/**
 * Wallet abstraction that decouples the auth handshake from any
 * particular wallet provider.
 *
 * The auth handshake (`Session.connectSession`) only ever needs two
 * things from the user's wallet:
 *
 *   1. The wallet's Solana public key (base58 string), to identify
 *      the holder to the gateway and have it issue a nonce against.
 *   2. The ability to sign an arbitrary canonical message string
 *      with that wallet, returning a base64-encoded ed25519
 *      signature the gateway's `WalletVerifier` can verify.
 *
 * Anything that satisfies this contract can drive the handshake. We
 * ship two implementations:
 *
 *   - `devWalletSource(kp)` — wraps the existing localStorage dev
 *     keypair from `./dev-keypair`. Used when no Privy app is
 *     configured (i.e. local development).
 *   - `privyWalletSource(...)` — wraps a Privy-connected external
 *     Solana wallet (Phantom / Solflare / Backpack / etc.). Used in
 *     prod and any env where `NEXT_PUBLIC_PRIVY_APP_ID` is set.
 *
 * Keeping this interface narrow means the rest of the shell never
 * imports `@privy-io/*` directly. Only `wallet-source-privy.tsx`
 * does, which keeps the Privy bundle out of unrelated routes when
 * tree-shaken, and makes the dev-mode build trivial (one fewer
 * heavyweight provider in the tree).
 */

/**
 * An unsigned Solana transaction the gateway built for the wallet to
 * sign and submit. Mirrors the server's `TransactionBuildResult`
 * (`server/chain/staking.ts`): `transaction` is the base64-serialized
 * unsigned tx; `blockhash` / `lastValidBlockHeight` let the submitter
 * confirm it with a blockhash strategy.
 */
export interface SignableTransaction {
  /** Base64-serialized unsigned transaction. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface WalletSource {
  /** Solana base58 public key; goes into `walletAddress` on the wire. */
  publicKey: string;
  /**
   * Sign the canonical handshake message with this wallet. The
   * returned string MUST be a base64-encoded detached ed25519
   * signature — that's what the gateway's `WalletVerifier` re-derives
   * and compares against. Throws if the user rejects the signature.
   */
  signMessage(message: string): Promise<string>;
  /**
   * Sign AND submit a gateway-built Solana transaction, resolving with
   * the base58 transaction signature once it's been broadcast.
   *
   * Optional because not every wallet source can move real assets:
   * - Privy external wallets (Phantom/Solflare/...) submit to their own
   *   configured RPC and return the signature.
   * - The dev keypair signs locally and submits via the RPC named by
   *   `NEXT_PUBLIC_SOLANA_RPC_URL` (so localnet/devnet staking is
   *   testable without a browser-extension wallet).
   *
   * Consumers MUST treat absence of this method (or a thrown error) as
   * "on-chain actions unavailable for this wallet" and degrade the UI
   * rather than assuming the asset moved. Throws if the user rejects.
   */
  signAndSendTransaction?(tx: SignableTransaction): Promise<string>;
  /**
   * Sign a gateway-built transaction WITHOUT submitting it, resolving with
   * the base64-serialized SIGNED transaction.
   *
   * Used for the atomic redeem swap, where a server-side treasury key must
   * co-sign AFTER the wallet and the server broadcasts. Signing a clean
   * (unsigned) transaction — rather than one already carrying the treasury's
   * signature — is what keeps wallet scanners (Phantom/Blowfish) from
   * flagging the redeem as a drainer.
   *
   * Optional for the same reasons as {@link signAndSendTransaction}. Throws
   * if the user rejects.
   */
  signTransaction?(tx: SignableTransaction): Promise<string>;
}
