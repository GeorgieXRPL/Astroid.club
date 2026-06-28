/**
 * Self-contained admin dashboard, served by the gateway at `/admin`.
 *
 * One static HTML document with inline CSS + vanilla JS — no build step,
 * no framework, same-origin with the `/admin/api/*` endpoints (so no
 * CORS). The page shell carries no secrets; the operator pastes the
 * admin token, which is kept in sessionStorage and sent as a Bearer on
 * every API call. All data is fetched from `/admin/api/snapshot`.
 *
 * NOTE: this is a template literal. Do not use backticks or `${...}`
 * inside the embedded client script — it concatenates strings on purpose
 * to avoid clashing with the server-side template.
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>astroid.club — admin</title>
<style>
  :root {
    --bg: #070b14; --panel: #0e1626; --panel2: #131f33; --line: #1e2c44;
    --text: #dce6f5; --muted: #7b8aa6; --accent: #36b6ff; --good: #38d39f;
    --warn: #f5b740; --bad: #ff6b6b; --diamond: #8be9fd;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--accent); }
  header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
    position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .5px; }
  header h1 span { color: var(--accent); }
  .badge { padding: 2px 8px; border-radius: 999px; background: var(--panel2);
    border: 1px solid var(--line); color: var(--muted); font-size: 11px; }
  .badge.on { color: var(--good); border-color: #1c5; }
  .badge.off { color: var(--muted); }
  .badge.warn { color: var(--warn); border-color: #863; }
  .spacer { flex: 1; }
  button { background: var(--panel2); color: var(--text); border: 1px solid var(--line);
    padding: 5px 11px; border-radius: 6px; cursor: pointer; font: inherit; }
  button:hover { border-color: var(--accent); }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1500px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .card .v { font-size: 22px; margin-top: 4px; font-weight: 600; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  section > h2 { margin: 0; padding: 9px 14px; font-size: 12px; text-transform: uppercase;
    letter-spacing: .6px; color: var(--muted); background: var(--panel2); border-bottom: 1px solid var(--line); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
  tbody tr:hover { background: var(--panel2); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--good); box-shadow: 0 0 6px var(--good); }
  .pill { padding: 1px 7px; border-radius: 999px; font-size: 11px; background: var(--panel2); border: 1px solid var(--line); }
  .t-Diamond { color: var(--diamond); } .t-Gold { color: #ffd35c; }
  .t-Silver { color: #cdd6e4; } .t-Bronze { color: #d79a6a; } .t-Base { color: var(--muted); }
  .grid2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
  @media (max-width: 1000px) { .grid2 { grid-template-columns: 1fr; } }
  #log { height: 340px; overflow: auto; padding: 8px 12px; margin: 0;
    font-size: 12px; background: #060a11; white-space: pre-wrap; word-break: break-word; }
  .lg-info { color: var(--text); } .lg-warn { color: var(--warn); } .lg-error { color: var(--bad); } .lg-log { color: var(--muted); }
  .lg-ts { color: #4a5a78; }
  .logbar { display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); align-items: center; }
  input[type=text], input[type=password] { background: #060a11; color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit; }
  #login { max-width: 360px; margin: 14vh auto; background: var(--panel);
    border: 1px solid var(--line); border-radius: 12px; padding: 26px; text-align: center; }
  #login h1 { font-size: 18px; } #login input { width: 100%; margin: 12px 0; }
  #login button { width: 100%; }
  .err { color: var(--bad); min-height: 18px; font-size: 12px; }
  .muted { color: var(--muted); }
  .right { text-align: right; }
</style>
</head>
<body>
<div id="login">
  <h1>astroid.club <span style="color:var(--accent)">admin</span></h1>
  <p class="muted">Enter the admin token to monitor the live server.</p>
  <input id="token" type="password" placeholder="ADMIN_SECRET" autocomplete="off" />
  <button id="loginBtn">Unlock</button>
  <div class="err" id="loginErr"></div>
</div>

<div id="app" style="display:none">
  <header>
    <h1>astroid.club <span>admin</span></h1>
    <span class="badge" id="b-chain">chain</span>
    <span class="badge" id="b-quarry">quarry</span>
    <span class="badge" id="b-payouts">payouts</span>
    <span class="badge" id="b-gate">gate</span>
    <span class="badge" id="b-persist">persistence</span>
    <span class="badge" id="b-uptime">uptime</span>
    <span class="badge on" id="b-conn">0 online</span>
    <div class="spacer"></div>
    <span class="muted" id="updated"></span>
    <button id="pauseBtn">Pause</button>
    <button id="logoutBtn">Lock</button>
  </header>
  <main>
    <div class="cards" id="cards"></div>
    <div class="grid2">
      <section>
        <h2>Holder gate &amp; oracle</h2>
        <div style="overflow:auto"><table id="gate"></table></div>
      </section>
      <section>
        <h2>Raid-wager escrow</h2>
        <div style="overflow:auto"><table id="escrow"></table></div>
      </section>
    </div>
    <section>
      <h2>Comp wallets — holder-gate bypass</h2>
      <div class="logbar">
        <input type="text" id="compInput" placeholder="wallet address to comp past the holder gate…" style="flex:1" />
        <button id="compAddBtn">Add</button>
        <span class="err" id="compErr"></span>
      </div>
      <div style="overflow:auto; max-height:300px"><table id="compWallets"></table></div>
    </section>
    <section>
      <h2>Asteroids</h2>
      <div style="overflow:auto"><table id="asteroids"></table></div>
    </section>
    <div class="grid2">
      <section>
        <h2>Active raids</h2>
        <div style="overflow:auto; max-height:360px"><table id="raidsActive"></table></div>
      </section>
      <section>
        <h2>Recent raid outcomes</h2>
        <div style="overflow:auto; max-height:360px"><table id="raidsRecent"></table></div>
      </section>
    </div>
    <div class="grid2">
      <section>
        <h2>Incoming meteors</h2>
        <div style="overflow:auto; max-height:360px"><table id="meteorsActive"></table></div>
      </section>
      <section>
        <h2>Recent meteor outcomes</h2>
        <div style="overflow:auto; max-height:360px"><table id="meteorsRecent"></table></div>
      </section>
    </div>
    <div class="grid2">
      <section>
        <h2>Players</h2>
        <div style="overflow:auto; max-height:420px"><table id="players"></table></div>
      </section>
      <section>
        <h2>Top Astroid Creds balances</h2>
        <div style="overflow:auto; max-height:420px"><table id="economy"></table></div>
      </section>
    </div>
    <section>
      <h2>Live server log</h2>
      <div class="logbar">
        <input type="text" id="logFilter" placeholder="filter…" style="flex:1" />
        <span class="muted" id="logCount"></span>
      </div>
      <pre id="log"></pre>
    </section>
  </main>
</div>

<script>
(function () {
  var KEY = 'astroid_admin_token';
  var token = sessionStorage.getItem(KEY) || '';
  var timer = null, paused = false, lastEventId = 0, filter = '';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }
  function num(n) { return (typeof n === 'number' ? n : 0).toLocaleString(); }
  function shortW(w) { return w ? w.slice(0, 4) + '…' + w.slice(-4) : '—'; }
  function fmtUptime(s) {
    s = s | 0; var d = (s / 86400) | 0; s %= 86400;
    var h = (s / 3600) | 0; s %= 3600; var m = (s / 60) | 0;
    return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
  }
  function fmtRel(ms) {
    var s = Math.round(Math.abs(ms) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }
  function fmtDur(s) {
    s = s | 0;
    if (s >= 86400 && s % 86400 === 0) return (s / 86400) + 'd';
    if (s >= 3600 && s % 3600 === 0) return (s / 3600) + 'h';
    if (s >= 60 && s % 60 === 0) return (s / 60) + 'm';
    return s + 's';
  }
  function price(p, dp) { return p > 0 ? '$' + Number(p).toPrecision(dp || 4) : '—'; }

  function show(el, on) { document.getElementById(el).style.display = on ? '' : 'none'; }

  function api(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) {
      if (r.status === 401) { lock('Invalid or expired token.'); throw new Error('unauthorized'); }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  // Mutating call (POST/DELETE). Surfaces the server's error message on failure.
  function apiSend(path, method, body) {
    return fetch(path, {
      method: method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) { lock('Invalid or expired token.'); throw new Error('unauthorized'); }
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j && j.message ? j.message : 'http ' + r.status);
        return j;
      });
    });
  }

  function lock(msg) {
    sessionStorage.removeItem(KEY); token = '';
    if (timer) { clearInterval(timer); timer = null; }
    show('app', false); show('login', true);
    document.getElementById('loginErr').textContent = msg || '';
  }

  function unlock() {
    token = document.getElementById('token').value.trim();
    if (!token) return;
    sessionStorage.setItem(KEY, token);
    document.getElementById('loginErr').textContent = '';
    start();
  }

  function start() {
    refresh().then(function () {
      show('login', false); show('app', true);
      if (timer) clearInterval(timer);
      timer = setInterval(function () { if (!paused) refresh(); }, 3000);
    }).catch(function () { /* lock() already handled 401 */ });
  }

  function badge(id, label, cls) {
    var el = document.getElementById(id);
    el.textContent = label; el.className = 'badge ' + (cls || '');
  }

  function refresh() {
    return api('/admin/api/snapshot?sinceEventId=' + lastEventId).then(render);
  }

  function render(d) {
    var s = d.server;
    badge('b-chain', 'chain: ' + (s.chainEnabled ? 'on' : 'off'), s.chainEnabled ? 'on' : 'off');
    badge('b-quarry', 'quarry: ' + (s.quarryEnabled ? 'on' : 'off'), s.quarryEnabled ? 'on' : 'off');
    badge('b-payouts', 'payouts: ' + (s.payoutsOnChain ? 'on-chain' : 'iou'), s.payoutsOnChain ? 'on' : '');
    var hg = d.holderGate || {};
    if (!hg.enabled) {
      badge('b-gate', 'gate: dev', 'off');
    } else {
      var stale = hg.pegged && hg.oracleUpdatedAt > 0 && (d.ts - hg.oracleUpdatedAt > 15 * 60 * 1000);
      var noQuote = hg.pegged && hg.oracleUpdatedAt === 0;
      var gtxt = hg.pegged ? ('gate: ~' + hg.minSol + ' SOL' + (noQuote ? ' (floor)' : '')) : 'gate: ' + num(hg.staticFloor);
      badge('b-gate', gtxt, (stale || noQuote) ? 'warn' : 'on');
    }
    badge('b-persist', s.persistence, s.persistence === 'postgres' ? 'on' : 'warn');
    badge('b-uptime', 'up ' + fmtUptime(s.uptimeSec), '');
    badge('b-conn', s.connected + ' online', 'on');
    document.getElementById('updated').textContent = 'updated ' + new Date(d.ts).toLocaleTimeString();

    var n = d.network, sec = d.security, ec = d.economy;
    var cards = [
      ['Miners', num(n.totalMiners)], ['Drill power', num(n.totalDrillPower)],
      ['Active expeditions', num(n.activeExpeditions)], ['Discoveries', num(n.totalDiscoveries)],
      ['Claimable Creds', num(ec.totalPendingYield)], ['Lifetime earned', num(ec.totalEarned)],
      ['Lifetime claimed', num(ec.totalRedeemed)], ['Wallets w/ credit', num(ec.walletsWithCredit)],
      ['Flagged wallets', num(sec.flaggedWallets)], ['Suspicious today', num(sec.suspiciousEventsToday)]
    ];
    if (ec.emission) {
      var em = ec.emission;
      var pct = Math.round(em.scale * 100);
      var head = em.budget > 0 ? num(em.headroom) + ' / ' + num(em.budget) : '∞';
      cards.push(['Emission rate', pct + '%']);
      cards.push(['Backing headroom', head]);
      if (em.dailyCap > 0) cards.push(['Issued (24h)', num(em.dailyIssued) + ' / ' + num(em.dailyCap)]);
    }
    if (hg.enabled) {
      cards.push(['Gate req.', num(Math.round(hg.requiredAstroid))]);
      cards.push(['Hold window', fmtDur(hg.holdSeconds)]);
    }
    if (d.escrow && (d.escrow.outstanding > 0 || d.escrow.failed > 0)) {
      cards.push(['Escrow out', num(d.escrow.outstanding)]);
    }
    document.getElementById('cards').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>';
    }).join('');

    var ah = '<thead><tr><th>Asteroid</th><th>Resource</th><th class="right">Miners</th>' +
      '<th class="right">Drill</th><th class="right">Stake</th><th class="right">Treasury</th>' +
      '<th class="right">Defense</th><th class="right">Steal</th><th class="right">Found</th><th>State</th></tr></thead><tbody>';
    ah += (n.asteroids || []).map(function (a) {
      var st = [];
      if (a.hasDefenseBuff) st.push('<span class="pill" style="color:var(--good)">immune</span>');
      if (a.hasAttackDebuff) st.push('<span class="pill" style="color:var(--bad)">debuff</span>');
      if (a.activeRaidCount > 0) st.push('<span class="pill" style="color:var(--warn)">raid x' + a.activeRaidCount + '</span>');
      return '<tr><td>' + esc(a.asteroidName) + '</td><td>' + esc(a.resource) + '</td><td class="right">' +
        num(a.minerCount) + '</td><td class="right">' + num(a.drillPower) + '</td><td class="right">' +
        num(a.totalStake) + '</td><td class="right">' + num(a.refineryBalance) + '</td><td class="right">' +
        num(a.defensePower) + '</td><td class="right">' + num(a.stealableYield) + '</td><td class="right">' +
        num(a.discoveriesFound) + '</td><td>' + (st.join(' ') || '—') + '</td></tr>';
    }).join('');
    document.getElementById('asteroids').innerHTML = ah + '</tbody>';

    var gateRows = [];
    if (!hg.enabled) {
      gateRows.push(['Status', 'disabled — dev pass-through (all wallets eligible)']);
    } else {
      gateRows.push(['Mode', hg.pegged ? 'SOL-pegged (dynamic)' : 'static floor']);
      gateRows.push(['Required to enter', num(Math.round(hg.requiredAstroid)) + ' $ASTROID']);
      if (hg.pegged) gateRows.push(['Peg target', hg.minSol + ' SOL worth']);
      gateRows.push(['Static floor', num(hg.staticFloor) + ' $ASTROID']);
      gateRows.push(['Hold window', fmtDur(hg.holdSeconds)]);
      gateRows.push(['$ASTROID price', price(hg.astroidUsd)]);
      gateRows.push(['SOL price', price(hg.solUsd, 5)]);
      gateRows.push(['Oracle updated', hg.oracleUpdatedAt > 0 ? fmtRel(d.ts - hg.oracleUpdatedAt) + ' ago' : 'no quote yet (on floor)']);
    }
    document.getElementById('gate').innerHTML = '<tbody>' + gateRows.map(function (r) {
      return '<tr><td class="muted">' + r[0] + '</td><td class="right">' + esc(r[1]) + '</td></tr>';
    }).join('') + '</tbody>';

    var escEl = document.getElementById('escrow');
    if (!d.escrow) {
      escEl.innerHTML = '<tbody><tr><td class="muted" style="padding:14px">Escrow not wired (chain off or no escrow store).</td></tr></tbody>';
    } else {
      var es = d.escrow;
      var escRows = [
        ['Outstanding liability', num(es.outstanding) + ' $ASTROID'],
        ['Active deposits', num(es.active)],
        ['Settling', num(es.settling)],
        ['Failed (manual)', es.failed > 0 ? '<span style="color:var(--bad)">' + num(es.failed) + '</span>' : '0']
      ];
      if (es.fees) {
        escRows.push(['Creation fee', (es.fees.feeBps / 100) + '% + ' + num(es.fees.feeFlat) + ' flat']);
        escRows.push(['Fees collected', num(es.fees.feesCollected) + ' $ASTROID']);
        escRows.push(['Rent-offset burned', num(es.fees.rentBurned) + ' $ASTROID']);
      }
      escEl.innerHTML = '<tbody>' + escRows.map(function (r) {
        return '<tr><td class="muted">' + r[0] + '</td><td class="right">' + r[1] + '</td></tr>';
      }).join('') + '</tbody>';
    }

    var rd = d.raids || { active: [], recent: [] };
    var rah = '<thead><tr><th>Attacker</th><th class="right">Party</th><th>Target</th>' +
      '<th class="right">Attack</th><th class="right">Defense</th><th class="right">Bet</th><th class="right">ETA</th></tr></thead><tbody>';
    rah += (rd.active || []).map(function (r) {
      var winning = r.attackPower > r.defensePower;
      return '<tr><td title="' + esc(r.attacker) + '">' + esc(shortW(r.attacker)) +
        (r.attackers > 1 ? ' <span class="pill">+' + (r.attackers - 1) + '</span>' : '') + '</td>' +
        '<td class="right">' + num(r.attackers) + '</td>' +
        '<td>' + esc(r.targetAsteroidId) + '</td>' +
        '<td class="right" style="color:' + (winning ? 'var(--good)' : 'var(--muted)') + '">' + num(r.attackPower) + '</td>' +
        '<td class="right">' + num(r.defensePower) + '</td>' +
        '<td class="right">' + num(r.bet) + '</td>' +
        '<td class="right">' + fmtRel(new Date(r.expiresAt).getTime() - d.ts) + '</td></tr>';
    }).join('');
    if (!rd.active || !rd.active.length) rah += '<tr><td colspan="7" class="muted" style="padding:14px">No active raids.</td></tr>';
    document.getElementById('raidsActive').innerHTML = rah + '</tbody>';

    var rrh = '<thead><tr><th>Expedition</th><th>Outcome</th><th class="right">Stolen</th>' +
      '<th class="right">Attack</th><th class="right">Defense</th><th class="right">When</th></tr></thead><tbody>';
    rrh += (rd.recent || []).map(function (r) {
      var won = r.attackersWon;
      return '<tr><td title="' + esc(r.expeditionId) + '">' + esc(String(r.expeditionId).slice(0, 10)) + '</td>' +
        '<td><span class="pill" style="color:' + (won ? 'var(--bad)' : 'var(--good)') + '">' + (won ? 'breached' : 'defended') + '</span></td>' +
        '<td class="right">' + num(r.stolenYield) + '</td>' +
        '<td class="right">' + num(r.attackPower) + '</td>' +
        '<td class="right">' + num(r.defensePower) + '</td>' +
        '<td class="right">' + fmtRel(d.ts - new Date(r.resolvedAt).getTime()) + ' ago</td></tr>';
    }).join('');
    if (!rd.recent || !rd.recent.length) rrh += '<tr><td colspan="6" class="muted" style="padding:14px">No raids resolved yet.</td></tr>';
    document.getElementById('raidsRecent').innerHTML = rrh + '</tbody>';

    var md = d.meteors || { active: [], recent: [] };
    var mah = '<thead><tr><th>Target</th><th class="right">Deflect cost</th><th class="right">Skim</th>' +
      '<th class="right">Yield hit</th><th class="right">Impact</th></tr></thead><tbody>';
    mah += (md.active || []).map(function (m) {
      return '<tr><td>' + esc(m.asteroidId) + '</td>' +
        '<td class="right">' + num(m.deflectCost) + '</td>' +
        '<td class="right">' + num(m.vaultSkimPercent) + '%</td>' +
        '<td class="right">' + num(m.yieldPenaltyPercent) + '%</td>' +
        '<td class="right">' + fmtRel(new Date(m.impactAt).getTime() - d.ts) + '</td></tr>';
    }).join('');
    if (!md.active || !md.active.length) mah += '<tr><td colspan="5" class="muted" style="padding:14px">No incoming meteors.</td></tr>';
    document.getElementById('meteorsActive').innerHTML = mah + '</tbody>';

    var mrh = '<thead><tr><th>Target</th><th>Outcome</th><th>By</th><th class="right">Skimmed</th>' +
      '<th class="right">When</th></tr></thead><tbody>';
    mrh += (md.recent || []).map(function (m) {
      var deflected = m.status === 'deflected';
      return '<tr><td>' + esc(m.asteroidId) + '</td>' +
        '<td><span class="pill" style="color:' + (deflected ? 'var(--good)' : 'var(--bad)') + '">' + (deflected ? 'deflected' : 'struck') + '</span></td>' +
        '<td title="' + esc(m.deflectedBy || '') + '">' + esc(m.deflectedBy ? shortW(m.deflectedBy) : '—') + '</td>' +
        '<td class="right">' + num(m.skimmed) + '</td>' +
        '<td class="right">' + fmtRel(d.ts - new Date(m.resolvedAt).getTime()) + ' ago</td></tr>';
    }).join('');
    if (!md.recent || !md.recent.length) mrh += '<tr><td colspan="5" class="muted" style="padding:14px">No meteors resolved yet.</td></tr>';
    document.getElementById('meteorsRecent').innerHTML = mrh + '</tbody>';

    var ph = '<thead><tr><th></th><th>Wallet</th><th>Tier</th><th class="right">Stake</th>' +
      '<th class="right">Drill</th><th class="right">Drill×</th><th class="right">Claimable</th><th class="right">Earned</th>' +
      '<th class="right">Claimed</th><th>Home</th><th>Active</th><th class="right">Loyal</th><th>Flags</th></tr></thead><tbody>';
    ph += (d.players || []).slice().sort(function (a, b) { return b.onChainStake - a.onChainStake; }).map(function (p) {
      var flags = [];
      if (p.onExpedition) flags.push('raiding');
      if (p.cooldowns && p.cooldowns.length) flags.push(p.cooldowns.length + ' cd');
      return '<tr><td><span class="dot ' + (p.authed ? 'on' : '') + '"></span></td>' +
        '<td title="' + esc(p.wallet) + '">' + esc(shortW(p.wallet)) + '</td>' +
        '<td class="t-' + esc(p.tier) + '">' + esc(p.tier) + '</td>' +
        '<td class="right">' + num(p.onChainStake) + '</td>' +
        '<td class="right">' + num(p.drillPower) + '</td>' +
        '<td class="right">' + (p.drillMultiplier) + '×</td>' +
        '<td class="right">' + num(p.pendingYield) + '</td>' +
        '<td class="right">' + num(p.lifetimeEarned) + '</td>' +
        '<td class="right">' + num(p.lifetimeRedeemed) + '</td>' +
        '<td>' + esc(p.homeAsteroidId || '—') + '</td>' +
        '<td>' + esc(p.activeAsteroidId || '—') + '</td>' +
        '<td class="right">' + num(p.loyaltyDays) + '</td>' +
        '<td class="muted">' + esc(flags.join(', ') || '—') + '</td></tr>';
    }).join('');
    if (!d.players || !d.players.length) ph += '<tr><td colspan="13" class="muted" style="padding:14px">No players yet.</td></tr>';
    document.getElementById('players').innerHTML = ph + '</tbody>';

    var eh = '<thead><tr><th>Wallet</th><th class="right">Astroid Creds</th></tr></thead><tbody>';
    eh += (ec.topBalances || []).map(function (b) {
      return '<tr><td title="' + esc(b.wallet) + '">' + esc(shortW(b.wallet)) + '</td><td class="right">' + num(b.amount) + '</td></tr>';
    }).join('');
    if (!ec.topBalances || !ec.topBalances.length) eh += '<tr><td colspan="2" class="muted" style="padding:14px">No credits yet.</td></tr>';
    document.getElementById('economy').innerHTML = eh + '</tbody>';

    renderComp(d.compWallets || []);

    appendLogs(d.events || []);
    if (d.lastEventId) lastEventId = d.lastEventId;
  }

  function renderComp(list) {
    var h = '<thead><tr><th>Comped wallet (bypasses holder gate)</th><th class="right">Action</th></tr></thead><tbody>';
    h += list.map(function (w) {
      return '<tr><td title="' + esc(w) + '">' + esc(w) + '</td>' +
        '<td class="right"><button class="comp-rm" data-w="' + esc(w) + '">Remove</button></td></tr>';
    }).join('');
    if (!list.length) h += '<tr><td colspan="2" class="muted" style="padding:14px">No comped wallets — everyone enters via the holder gate.</td></tr>';
    document.getElementById('compWallets').innerHTML = h + '</tbody>';
  }

  function addComp() {
    var inp = document.getElementById('compInput');
    var errEl = document.getElementById('compErr');
    var w = inp.value.trim();
    errEl.textContent = '';
    if (!w) return;
    apiSend('/admin/api/comp-wallets', 'POST', { wallet: w }).then(function (j) {
      inp.value = '';
      renderComp(j.wallets || []);
    }).catch(function (e) { errEl.textContent = e.message || 'add failed'; });
  }

  function appendLogs(events) {
    if (!events.length) return;
    var logEl = document.getElementById('log');
    var atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    var html = events.map(function (e) {
      var t = new Date(e.ts).toLocaleTimeString();
      return '<div class="lg-' + e.level + '" data-msg="' + esc(e.msg.toLowerCase()) +
        '"><span class="lg-ts">' + t + '</span> ' + esc(e.msg) + '</div>';
    }).join('');
    logEl.insertAdjacentHTML('beforeend', html);
    var lines = logEl.children;
    while (lines.length > 1000) logEl.removeChild(lines[0]);
    applyFilter();
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    document.getElementById('logCount').textContent = logEl.children.length + ' lines';
  }

  function applyFilter() {
    var lines = document.getElementById('log').children;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].getAttribute('data-msg') || '';
      lines[i].style.display = (!filter || m.indexOf(filter) >= 0) ? '' : 'none';
    }
  }

  document.getElementById('loginBtn').onclick = unlock;
  document.getElementById('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
  document.getElementById('logoutBtn').onclick = function () { lock(''); };
  document.getElementById('pauseBtn').onclick = function () {
    paused = !paused; this.textContent = paused ? 'Resume' : 'Pause';
  };
  document.getElementById('logFilter').addEventListener('input', function () {
    filter = this.value.trim().toLowerCase(); applyFilter();
  });
  document.getElementById('compAddBtn').onclick = addComp;
  document.getElementById('compInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') addComp(); });
  document.getElementById('compWallets').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.comp-rm') : null;
    if (!btn) return;
    var w = btn.getAttribute('data-w');
    if (!w || !confirm('Remove ' + w + ' from the comp list? They will then need to pass the holder gate.')) return;
    apiSend('/admin/api/comp-wallets', 'DELETE', { wallet: w }).then(function (j) {
      renderComp(j.wallets || []);
    }).catch(function (err) { document.getElementById('compErr').textContent = err.message || 'remove failed'; });
  });

  if (token) start(); else show('login', true);
})();
</script>
</body>
</html>`;
