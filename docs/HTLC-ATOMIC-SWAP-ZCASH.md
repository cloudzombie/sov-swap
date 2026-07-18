# HTLC Atomic Swap with Zcash — end-to-end proof of the ZEC leg

**Status:** ZEC leg **PROVEN on Zcash mainnet** (real broadcast, funded → claimed →
confirmed, funds recovered). Full XUS↔ZEC round-trip pending only the SOV miner being up.
**Date:** 2026-07-17 · **Network:** Zcash mainnet · **Amount at risk:** 0.0099 ZEC (fees only)

---

## 1. Executive summary

The sov-swap desk performs trustless XUS↔ZEC atomic swaps using a single 32-byte SHA-256
hashlock that locks an HTLC on *both* chains. The Zcash leg is a transparent P2SH HTLC; its
**ZIP-243 spend sighash had never been proven end-to-end** — the historically "unproven"
piece.

This exercise proved it three independent ways and then **executed a live self-swap on
Zcash mainnet**: a real HTLC was funded, claimed (revealing the preimage on-chain), and
confirmed, with the ZEC returning to the hot wallet. **No code fix was required** — the
ZIP-243 sighash in `packages/swap-core/src/zcash/htlc.ts` was already correct; it was
*unproven*, not broken. A regression test now pins it.

The safety invariant was honoured throughout: **the refund spend was constructed and
sighash-verified BEFORE any ZEC was locked**, guaranteeing recoverability.

---

## 2. Network parameters in play

| Property | Value |
|---|---|
| Chain | Zcash **mainnet** |
| Tip at test time | ~3,415,7xx |
| Active upgrade | **NU6.2** |
| Consensus branch id | **`0x5437f330`** (empirically confirmed correct — the network accepted the tx) |
| Tx format | **v4 Sapling**, versionGroupId **`0x892f2085`** |
| Sighash algorithm | **ZIP-243** — BLAKE2b-256, personalization `"ZcashSigHash"` + 4-byte LE branch id |
| Fee | ZIP-317 conventional, 10,000 zat (2-action minimum) per spend |

> **NU6.3 note.** The upgrade table (`network.ts`) lists NU6.3 at height `3,428,143`
> (~2026-07-28), branch `0x37a5165b`. At test time the tip was *below* that, so the table
> correctly selected NU6.2. That NU6.3 entry stays unverified until activation — re-verify
> the boundary before 2026-07-28.

---

## 3. The Zcash HTLC

A transparent **P2SH** output with two mutually-exclusive spend paths:

```
OP_IF
  OP_SHA256 <hashlock> OP_EQUALVERIFY      # claim: knows preimage …
  OP_DUP OP_HASH160 <claimantPubkeyHash>   #        … and holds claimant key
OP_ELSE
  <timeoutHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP   # refund: after timeout …
  OP_DUP OP_HASH160 <refundPubkeyHash>            #        … back to funder
OP_ENDIF
OP_EQUALVERIFY
OP_CHECKSIG
```

- **claim scriptSig:**  `<sig> <pubkey> <preimage> OP_1 <redeemScript>`
- **refund scriptSig:** `<sig> <pubkey> OP_0 <redeemScript>`

The `hashlock` is a **single SHA-256** of the raw secret — byte-identical to what Zcash's
`OP_SHA256` computes and what the SOV chain's `htlc_claim` verifies (`sha256(preimage) ==
hashlock`). That shared primitive is what makes the two legs atomic.

---

## 4. The sighash — what was actually going on

`hashForSignatureByNetwork` in `@bitgo/utxo-lib@11.24.0` implements the ZIP-243 transparent
sighash correctly (BLAKE2b-256 with `ZcashSigHash`+branchId personalization; shielded
sub-hashes and valueBalance are zero, which is exactly right for a **transparent-only** tx).
`packages/swap-core/src/zcash/htlc.ts` wires it correctly: branch id selected by height,
version-group `0x892f2085`, the redeem script as scriptCode, and the UTXO value as amount.

The gap was **verification, not correctness**: the prior test suite only checked tx *shape*
(script layout, fee, hex format), never that a produced signature actually validates.

### The one genuine gotcha: the branch id is not serialized

A Zcash v4 transaction does **not** carry its consensus branch id on the wire. So
re-parsing a built tx with `createTransactionFromBuffer` yields a tx object whose
`consensusBranchId` defaults to the library's newest-known branch (NU6.2 today) — **not**
necessarily the branch the signer committed to. Any verifier or re-derivation must
re-supply the branch id used at signing time. `htlc.ts` does the right thing when signing;
only the verification harness had to restore it. This is the classic "silently
unbroadcastable" Zcash footgun, and it is why the branch table is explicit config.

---

## 5. Proof (money-free), three independent ways

Added as a regression test: `packages/swap-core/test/zcash-sighash-verify.test.ts`.

1. **Independent ZIP-243 implementation.** A from-scratch reimplementation of the Sapling
   transparent sighash (BLAKE2b-256, personalized) computes the digest and must agree
   byte-for-byte with `@bitgo`'s `hashForSignatureByNetwork` on the *same* tx — fed the
   values we expect it to carry (branch id from the height table, version-group
   `0x892f2085`, the UTXO value).
2. **ECDSA verify.** The signature embedded in the produced scriptSig must verify against
   that digest under the claimant/refund pubkey — exactly what `OP_CHECKSIG` does.
3. **Script conditions.** `OP_SHA256(preimage) == hashlock` (claim) and
   `HASH160(pubkey) == PKH` — the remaining redeem-script constraints.

All three pass for **both the claim and the refund** paths. Full suite: **51/51 green**.

---

## 6. Recoverability gate (hard invariant)

Before broadcasting the funding transaction, the driver:

1. Built and signed the funding tx and computed its (deterministic) txid.
2. **Constructed the REFUND spend** of the not-yet-existent HTLC UTXO and
   **sighash-verified it** (ECDSA over an independently-recomputed ZIP-243 digest).
3. Refused to broadcast unless that refund verified.

Refund timelock was short — **~1 hour** (HTLC timeout = tip + 48 blocks, height 3,415,795).
Because the refund path uses the same proven ZIP-243 code and we hold the key, the 0.0099
ZEC was recoverable regardless of whether the claim succeeded. Losing the ZEC was never on
the table.

---

## 7. Live execution on mainnet — the transactions

Self-swap (we play both sides); one hot-wallet key serves as both claimant and refund.

| Step | Txid | Effect |
|---|---|---|
| **Fund** | `502a7ce58ba1a7474376f8816e9266082cae0504943e0e92518bea82da75ae6b` | Hot wallet `t1MX4hCpMUagW7xEo1FGGchXuQFCEaF4yk5` → HTLC `t3LvbrsW9Z7kHbemdxvYf5f2pzkKqZTVeBv`, locked **980,000 zat** |
| **Claim** | `753770360952b8ac9463c6fa124627c39eb1d9581f7e5cf9c05edaffec7c6468` | Swept **970,000 zat** back to hot wallet, **revealing the preimage on-chain** (235-byte HTLC scriptSig) |

- **Hashlock:** `1a10a69a067fcf55c7fa101b546ad9ca9cb9e15664428a92a717d30a0cadfb88`
- **Confirmations:** funding confirmed; claim confirmed (2 confs). **HTLC address now empty.**
- **Cost:** 20,000 zat (2 × ZIP-317 fee). **Final hot-wallet balance: 0.0097 ZEC — fully recovered.**

The mainnet network **accepting and confirming** both the funding P2PKH spend and the HTLC
P2SH claim spend (OP_SHA256 preimage path + OP_CHECKSIG) is the decisive, network-level
proof that the ZIP-243 sighash and the redeem script are correct.

---

## 8. XUS leg — pending (operational, not code)

The SOV/XUS half (`lockXus` / `claimXus` / `getHtlc` / `transferXus` in
`packages/swap-core/src/sov/htlc.ts`) is present and unit-tested, and the local XUS account
`8a3926…7eb6` is funded (~97.96 XUS). At test time the **SOV miner was offline** — the head
block was ~11 min stale with ~50 txs stuck in the mempool and height frozen at 7311 — so an
XUS HTLC lock could not confirm. An unconfirmable lock was **not** submitted.

Cross-chain atomicity nonetheless rests on the **shared SHA-256 hashlock** (unit-tested
identical on both chains) plus the preimage the ZEC claim already published on the Zcash
chain. To finish the full round-trip:

1. Start the SOV miner (chain only advances while it runs).
2. `lockXus` from the desk/hot account to the recipient with **the same hashlock**.
3. `claimXus` with the same preimage → completes the atomic swap; escrow vanishes.
4. Reconcile balances on both chains.

---

## 9. Verdict

- **ZEC↔ HTLC sighash: PROVEN end-to-end on Zcash mainnet.** Real funding + HTLC-claim
  spends accepted and confirmed; funds recovered.
- **Recoverability: proven before any lock**, per the hard safety invariant.
- **Remaining:** demonstrate the full XUS↔ZEC round-trip once the SOV miner is running — a
  matter of operations, not of the (now-proven) swap mechanics.

---

## 10. Artefacts (uncommitted, in `packages/swap-core/`)

- `test/zcash-sighash-verify.test.ts` — the regression proof (4 checks; claim + refund).
- `_liveswap.mjs` — live self-swap driver. Reads the hot-wallet WIF locally and **never
  logs it**; builds & verifies funding + refund + claim; refuses to broadcast unless the
  refund gate verifies. Modes: `dryrun | fund | claim | refund`.
- `_await_claim.mjs` — confirmation poller that confirmed funding, broadcast the claim, and
  confirmed it.

No tracked source was modified. ZEC chain access throughout: free zec.rocks lightwalletd
(no key). Secrets (WIF, seeds) were never printed, echoed, or written anywhere.
