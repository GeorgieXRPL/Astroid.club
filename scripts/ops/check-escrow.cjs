/**
 * Read-only escrow / wager health check. Runs on the gateway machine (where
 * DATABASE_URL + ESCROW_PRIVATE_KEY + RPC live). Modifies nothing.
 *
 * Reports:
 *   1. Durable ledger (escrow_wagers): per-status counts + amounts, and any
 *      PARKED (failed) or stale active/settling rows. NOTE: fully-settled
 *      wagers are DELETED from this table, so a near-empty table is healthy.
 *   2. On-chain escrow wallet: $ASTROID ATA balance + a scan of recent tx
 *      memos (deposit / return / defender spoils / burn / rent-burn).
 *   3. Solvency: on-chain escrow balance vs outstanding (active+settling)
 *      liability — balance should comfortably cover liability.
 *
 * Usage (on Fly): NODE_PATH=/app/node_modules node /tmp/check-escrow.cjs
 */
const web3 = require('@solana/web3.js');

const DEC = Number(process.env.ASTROID_DECIMALS || '6');
const SIG_LIMIT = Number(process.env.ESCROW_SIG_LIMIT || '50');

function loadKp(envVar) {
  const raw = process.env[envVar];
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length === 64) return web3.Keypair.fromSecretKey(Uint8Array.from(p));
  } catch (e) {
    /* base58 */
  }
  const bs58 = require('bs58');
  const decode = bs58.decode || (bs58.default && bs58.default.decode);
  return web3.Keypair.fromSecretKey(decode(raw));
}

function tok(raw) {
  return Number(raw) / Math.pow(10, DEC);
}

function classifyMemo(line) {
  // memo program logs surface as: Program log: Memo (len N): "<memo>"
  const m = line.match(/astroid_raid_wager[a-z_]*:[^"]*/);
  if (!m) return null;
  const memo = m[0];
  if (memo.startsWith('astroid_raid_wager_return')) return { kind: 'return (winner)', memo };
  if (memo.startsWith('astroid_raid_wager_spoils')) return { kind: 'defender spoils', memo };
  if (memo.startsWith('astroid_raid_wager_rent_burn')) return { kind: 'rent-offset burn', memo };
  if (memo.startsWith('astroid_raid_wager_burn')) return { kind: 'loss burn', memo };
  return { kind: 'deposit', memo };
}

async function checkLedger() {
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.log('\n[ledger] pg module not available — skipping DB check.');
    return { outstanding: 0 };
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('\n[ledger] DATABASE_URL unset — skipping DB check.');
    return { outstanding: 0 };
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const sum = await db.query(
      `SELECT status, count(*)::int AS c, coalesce(sum(amount),0)::float AS amt
       FROM escrow_wagers GROUP BY status ORDER BY status`,
    );
    console.log('\n=== Durable ledger (escrow_wagers) ===');
    if (sum.rows.length === 0) {
      console.log('  (table empty — all wagers fully settled & removed, or none yet)');
    } else {
      for (const r of sum.rows) console.log(`  ${r.status.padEnd(9)} count=${r.c}  amount=${r.amt} $ASTROID`);
    }
    let outstanding = 0;
    for (const r of sum.rows) if (r.status === 'active' || r.status === 'settling') outstanding += Number(r.amt);

    const rows = await db.query(
      `SELECT wager_id, wallet, amount, status, retries, last_error, target_asteroid,
              extract(epoch from (now() - updated_at))::int AS age_s
       FROM escrow_wagers ORDER BY updated_at DESC LIMIT 30`,
    );
    if (rows.rows.length) {
      console.log('\n  recent unsettled rows:');
      for (const r of rows.rows) {
        console.log(
          `   ${String(r.wager_id).slice(0, 8)}… ${String(r.wallet).slice(0, 6)}… ` +
            `${r.amount} ${r.status} retries=${r.retries} age=${r.age_s}s` +
            (r.target_asteroid ? ` target=${r.target_asteroid}` : '') +
            (r.last_error ? `\n        last_error: ${String(r.last_error).slice(0, 160)}` : ''),
        );
      }
    }
    const failed = sum.rows.find((r) => r.status === 'failed');
    if (failed && failed.c > 0) {
      console.log(`\n  ⚠️  ${failed.c} PARKED (failed) wager(s) — manual settlement required.`);
    }
    return { outstanding };
  } finally {
    await db.end();
  }
}

async function checkChain() {
  const rpc = process.env.SOLANA_RPC_URL;
  const mintStr = process.env.ASTROID_MINT_ADDRESS;
  if (!rpc || !mintStr) {
    console.log('\n[chain] SOLANA_RPC_URL / ASTROID_MINT_ADDRESS unset — skipping chain check.');
    return { balance: null };
  }
  const escrowKp = loadKp('ESCROW_PRIVATE_KEY') || loadKp('REDEEMER_TREASURY_PRIVATE_KEY');
  if (!escrowKp) {
    console.log('\n[chain] no escrow/treasury key — skipping chain check.');
    return { balance: null };
  }
  const dedicated = !!process.env.ESCROW_PRIVATE_KEY;
  const conn = new web3.Connection(rpc, 'confirmed');
  const mint = new web3.PublicKey(mintStr);
  const spl = require('@solana/spl-token');
  const ata = await spl.getAssociatedTokenAddress(mint, escrowKp.publicKey);

  console.log('\n=== On-chain escrow wallet ===');
  console.log(`  wallet:   ${escrowKp.publicKey.toBase58()} (${dedicated ? 'dedicated ESCROW_PRIVATE_KEY' : 'shared redeemer treasury'})`);
  console.log(`  $ASTROID ATA: ${ata.toBase58()}`);

  let balance = 0;
  try {
    const acc = await spl.getAccount(conn, ata);
    balance = tok(acc.amount);
    console.log(`  balance:  ${balance} $ASTROID`);
  } catch {
    console.log('  balance:  (ATA not found / 0)');
  }

  const sigs = await conn.getSignaturesForAddress(ata, { limit: SIG_LIMIT });
  console.log(`\n  scanning ${sigs.length} recent signatures for wager memos…`);
  const tally = {};
  let scanned = 0;
  for (const s of sigs) {
    let tx;
    try {
      tx = await conn.getParsedTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    } catch {
      continue;
    }
    scanned += 1;
    const logs = (tx && tx.meta && tx.meta.logMessages) || [];
    const seen = new Set();
    for (const line of logs) {
      const c = classifyMemo(line);
      if (c && !seen.has(c.kind)) {
        seen.add(c.kind);
        tally[c.kind] = (tally[c.kind] || 0) + 1;
        const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?';
        const err = tx.meta && tx.meta.err ? ' ERR' : '';
        console.log(`   [${when}]${err} ${c.kind.padEnd(16)} ${c.memo.slice(0, 60)}  tx ${s.signature.slice(0, 8)}…`);
      }
    }
  }
  console.log('\n  memo tally:');
  if (Object.keys(tally).length === 0) console.log('   (no wager memos in the scanned window)');
  for (const [k, v] of Object.entries(tally)) console.log(`   ${k.padEnd(16)} ${v}`);
  return { balance };
}

(async () => {
  console.log('— Escrow / wager health check —');
  let outstanding = 0;
  try {
    ({ outstanding } = await checkLedger());
  } catch (e) {
    console.log('[ledger] error:', e && e.message ? e.message : e);
  }
  let balance = null;
  try {
    ({ balance } = await checkChain());
  } catch (e) {
    console.log('[chain] error:', e && e.message ? e.message : e);
  }
  console.log('\n=== Solvency ===');
  console.log(`  outstanding (active+settling) liability: ${outstanding} $ASTROID`);
  if (balance != null) {
    console.log(`  on-chain escrow balance:                 ${balance} $ASTROID`);
    console.log(
      balance >= outstanding
        ? `  ✓ SOLVENT — balance covers outstanding liability (surplus ${(balance - outstanding).toFixed(6)}).`
        : `  ⚠️  UNDER-COLLATERALIZED — balance is below outstanding liability by ${(outstanding - balance).toFixed(6)}.`,
    );
  }
})().catch((e) => {
  console.error('check failed:', e && e.message ? e.message : String(e));
  process.exit(1);
});
