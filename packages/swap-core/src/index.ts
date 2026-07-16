/**
 * @sov-swap/core — the cross-chain HTLC engine for trustless XUS↔ZEC atomic swaps.
 *
 * Two legs locked against one shared 32-byte SHA-256 hashlock:
 *  - Zcash transparent P2SH HTLC  (`./zcash/htlc`, `./zcash/network`)
 *  - SOV native HTLC actions       (`./sov/htlc`)
 * plus the protocol that keeps them atomic (`./protocol`).
 */
export * from './zcash/htlc.js';
export * from './zcash/network.js';
export * from './sov/htlc.js';
export * from './protocol.js';
