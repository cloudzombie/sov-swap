# Technical Design — Zcash Transparent-HTLC Atomic Swaps

Companion to the ZCG proposal. Describes the construction as it exists in the reference
implementation (`github.com/cloudzombie/sov-swap`), the security model, and the
consensus-branch-id handling that is the crux of correctness.

## 1. The atomic-swap primitive

Two chains, one shared 32-byte secret `s` with hashlock `h = SHA256(s)`. Each chain holds
a hash-timelock contract locked against the same `h`. Revealing `s` to take one leg
publishes `s` on-chain, letting the counterparty take the other leg. Either both legs
settle or, after their timeouts, both refund. No custodian, bridge, oracle, or wrapped
asset.

**The only cross-chain requirement** is that both chains compute the *same* function on the
preimage. Zcash's `OP_SHA256` is a **single** SHA-256 of the raw preimage; the counterparty
chain must match exactly (single SHA-256, not double-SHA, not HASH160). The Sovereign side
of the reference desk verifies `sha256(preimage) == hashlock` for precisely this parity.

## 2. Zcash transparent HTLC

Transparent (t-address) Zcash inherits Bitcoin Script, including `OP_SHA256`,
`OP_CHECKLOCKTIMEVERIFY`, and arbitrary P2SH — and Zcash's own **ZIP-300** documents
cross-chain atomic transactions with this exact P2SH+CLTV pattern. (Shielded Sapling/Orchard
has no script and cannot participate; HTLC swaps are transparent-only, by construction.)

### Redeem script

```
OP_IF
  OP_SHA256 <hashlock> OP_EQUALVERIFY
  OP_DUP OP_HASH160 <claimantPubKeyHash>
OP_ELSE
  <timeoutHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
  OP_DUP OP_HASH160 <refundPubKeyHash>
OP_ENDIF
OP_EQUALVERIFY
OP_CHECKSIG
```

- **Claim path** (`OP_IF` true): requires the preimage of `hashlock` *and* the claimant's
  signature. scriptSig: `<sig> <pubkey> <preimage> OP_1 <redeemScript>`.
- **Refund path** (`OP_ELSE`): valid only once the chain height ≥ `timeoutHeight` (CLTV),
  requires the funder's signature. scriptSig: `<sig> <pubkey> OP_0 <redeemScript>`.

Funds are sent to the P2SH address of this script. The address commits to every term, so
the counterparty independently recomputes and verifies it before funding.

### Implementation notes (things that bite you)

- **Two-byte base58 version prefixes.** Zcash P2SH is `t3…` (0x1CBD) / testnet `t2…`
  (0x1CBA) — *two* bytes. Generic bitcoinjs writes one byte and throws or mis-encodes. Use a
  Zcash-aware encoder; round-trip the address → output script in tests.
- **CLTV requires a non-final input sequence** (`< 0xffffffff`) and `nLockTime ≥ timeout`,
  or the refund path is silently unenforceable.
- **ZIP-317 fees**: 5000 zat/logical-action, ≥2 actions ⇒ a 1-in/1-out sweep is 10000 zat.
  The claim/refund deducts its fee from the swept output, so a market-maker desk needs **zero
  pre-funded ZEC** — the sweep pays for itself.
- **Non-standard scriptSig**: the HTLC spend is not a template the tx builder understands;
  assemble the scriptSig by hand and set the input script directly.

## 3. The consensus-branch-id problem (the core deliverable)

Zcash's transparent sighash (ZIP-143 → ZIP-243/244) **commits to the consensus branch id of
the currently-active network upgrade.** Zcash ships an NU roughly quarterly, each changing
that id. **A stale branch id produces a silently-invalid, unbroadcastable transaction — no
useful error.** This has repeatedly broken shipped wallets (e.g. Trust Wallet wallet-core,
Ledger Live) around NU activations.

Reference implementation approach — and the artifact this grant hardens:

- **Explicit, height-selected config.** A table of `{name, branchId, activationHeight}` from
  NU5 forward (…NU6.2 `0x5437f330`, NU6.3 `0x37a5165b` @ 2026-07-28). The active id is the
  newest upgrade at the current tip; a swap spanning an activation still signs correctly.
- **Fail loud, never guess.** Below the oldest known upgrade it throws rather than assume.
- **Cross-implementation vectors (grant M2).** Generate sighash/tx vectors and check them
  against `zcash_primitives` (`librustzcash`) in CI, so a drift is caught before it ships.
  This is the reusable guard the ecosystem currently lacks.

## 4. Security model

Roles (reference desk, ZEC→XUS; the desk is the market maker):

- **Initiator** (the user): locks ZEC first, with the **longer** timeout; reveals `s` to
  claim the other leg.
- **Responder** (the desk): locks second, with the **shorter** timeout; only commits after
  the initiator's funds are confirmed.

**The one invariant that makes it a swap and not a theft:** the initiator's timeout must be
strictly *later* (in wall-clock, across the two chains' differing block times) than the
responder's, by a safety margin large enough for the responder to sweep after the reveal.
Otherwise the initiator could claim one leg *and* refund the other near the boundary. In the
reference code this is `assertSafeTimeouts()`, enforced — and re-checked against live tips
immediately before the responder commits any funds — not merely documented. It is
unit-tested, including the wall-clock case where equal *block* deltas are unequal *time*.

Failure modes and who bears them:

| Event | Outcome |
|-------|---------|
| Responder never locks after initiator funds | Initiator refunds after their timeout. No loss. |
| Initiator never claims | Responder refunds after the (earlier) timeout; initiator refunds after theirs. No loss. |
| Initiator claims (reveals `s`) then vanishes | Responder reads `s` off-chain and sweeps before the initiator's timeout. The responder must independently recover `s` from the chain — the reference desk scans for it rather than trusting cooperation. |
| Wrong sighash / branch id | Sweep won't broadcast → funds sit in the HTLC until the rightful refund. The *refund path* bounds the worst case to "no swap," not "lost funds" — provided the refund tx is itself correctly signed (hence the vectors). |

## 5. Chain access without a node

Watch (UTXOs at the HTLC address, confirmations), broadcast, and raw-tx fetch (to read a
revealed preimage) run over public REST — Blockchair (mainnet), CipherScan (testnet) —
behind one interface, with lightwalletd `SendTransaction` as a broadcast fallback. No
self-hosted Zcash node required, so the tooling runs on commodity hosts; a self-host path
(lightwalletd/Zebra with the address index) is documented for operators who want it.

## 6. What the grant changes

The above is implemented and running. The grant extracts the Zcash engine into an
independent, documented, semver'd package; adds the cross-impl vector suite + CI guard;
proves a full mainnet swap publicly; funds an independent review; and commits to maintaining
the branch-id table/vectors across upcoming NUs — turning working code into a maintained
public good the whole Zcash ecosystem can build on.

---

*Reference: https://github.com/cloudzombie/sov-swap · live desk https://swap.sovxus.com*
