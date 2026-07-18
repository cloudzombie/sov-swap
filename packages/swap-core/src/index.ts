/**
 * @sov-swap/core — the cross-chain HTLC engine for trustless XUS↔ZEC/BTC atomic swaps.
 *
 * UTXO-coin legs locked against one shared 32-byte SHA-256 hashlock (`./htlc-script`):
 *  - Zcash transparent P2SH HTLC   (`./zcash/htlc`, `./zcash/network`, `./zcash/chain`)
 *  - Bitcoin legacy P2SH HTLC      (`./bitcoin/htlc`, `./bitcoin/network`, `./bitcoin/chain`)
 *  - SOV native HTLC actions       (`./sov/htlc`)
 * plus the protocol that keeps them atomic (`./protocol`).
 */
export * from './htlc-script.js';
export * from './zcash/htlc.js';
export * from './zcash/network.js';
export * from './zcash/chain.js';
export * from './zcash/lightwalletd.js';
export * from './bitcoin/htlc.js';
export * from './bitcoin/network.js';
export * from './bitcoin/chain.js';
export * from './sov/htlc.js';
export * from './protocol.js';
export * from './swap/machine.js';
