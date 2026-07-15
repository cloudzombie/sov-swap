# @sov-swap/core

The cross-chain HTLC engine behind the XUS↔ZEC atomic swap desk.

## Why this can be trustless

Both chains lock against the **same 32-byte SHA-256 hashlock**:

- **Zcash** — a transparent P2SH script: `OP_SHA256 <hashlock> OP_EQUALVERIFY` (claim path)
  or `<timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP` (refund path).
- **SOV/XUS** — the native `HtlcLock` / `HtlcClaim` / `HtlcRefund` actions, where the
  runtime verifies `sha256(preimage) == hashlock`.

Single SHA-256 of the raw secret, byte-for-byte identical on both sides. Revealing the
secret to take one leg mathematically publishes it for the other leg. No bridge, no
custodian, no oracle — either both legs settle or both refund.

Only **transparent** ZEC can participate: shielded (Sapling/Orchard) has no script and
no `OP_SHA256`.

## Operational hazards this code takes seriously

- **Consensus branch id.** Zcash's transparent sighash commits to the branch id of the
  active network upgrade, which rotates ~quarterly. A stale id silently produces
  unbroadcastable transactions. It is explicit config here (`src/zcash/network.ts`),
  selected by height, and fails loudly rather than guessing. **NU6.3 activates
  2026-07-28** — keep the table current and rehearse on testnet before each activation.
- **Two-byte base58 prefixes.** Zcash P2SH addresses (`t3…`/`t2…`) use a two-byte
  version; upstream bitcoinjs `payments.p2sh` writes one byte. We use the Zcash-aware
  `utxolib.address` encoder, and a test round-trips address → output script.
- **CLTV needs a non-final sequence** and `nLockTime >= timeout`, or the refund path
  isn't enforceable. Both are pinned by tests.
- **Zero pre-funded ZEC.** Claims deduct the ZIP-317 fee from the claimed amount, so the
  desk never needs ZEC on hand — it only ever receives it.

## Test

    npm test
