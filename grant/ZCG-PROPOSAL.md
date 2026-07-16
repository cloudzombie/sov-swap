# Zcash Community Grants — Proposal

## Open-Source Transparent-HTLC Atomic Swaps for Zcash

> **Applicant note:** bracketed `[…]` fields are for you to complete before submission
> (legal name, contact, payout address, requested amount, dates). Everything else is
> grounded in a working, deployed reference implementation.

---

### 1. Applicant

| | |
|---|---|
| **Name / entity** | [Your legal name or entity] |
| **Contact** | security@sovxus.com · [email / Discord / forum handle] |
| **Website** | https://swap.sovxus.com (live reference desk) |
| **Repository** | https://github.com/cloudzombie/sov-swap (MIT/Apache-2.0, public) |
| **Payout address** | [transparent or unified ZEC address] |
| **Requested amount** | [USD, paid in ZEC] — see §8 budget |
| **Duration** | [e.g. 3 months] |

### 2. One-paragraph summary

We are building — and have already deployed a working prototype of — **a maintained,
open-source library and reference implementation for cross-chain atomic swaps against
transparent Zcash**, using standard `OP_SHA256` + `OP_CHECKLOCKTIMEVERIFY` P2SH HTLCs (the
ZIP-300 pattern). The core deliverable to the Zcash ecosystem is **`zcash-htlc`**, a
well-tested TypeScript library that any project can use to build, fund, watch, claim,
refund, and parse Zcash transparent HTLCs — including the **consensus-branch-id handling
that has repeatedly broken shipped wallets** across network upgrades. Today no maintained,
audited JS building block for this exists; teams re-implement it and get the sighash wrong.
This grant funds turning our working code into that reusable public good, hardening it,
proving it end-to-end on mainnet, and committing to maintain it across future NUs.

### 3. Motivation — why this benefits Zcash

- **More ZEC utility and on/off-ramps.** Trustless atomic swaps let ZEC move to and from
  other assets **without a custodian, bridge, or wrapped token** — no counterparty holding
  user funds. Every swap is settled by a hash-timelock contract; either both legs complete
  or both refund. This is the most sovereignty-preserving cross-chain primitive and it is
  natively Zcash-shaped (Zcash's own **ZIP-300** describes exactly this construction).
- **Transparent Zcash is under-tooled.** The shielded ecosystem has `librustzcash` and
  `lightwalletd`; **transparent-address scripting (P2SH, CLTV, HTLC) has no maintained,
  correct JS library.** Wallets that need it (Trust Wallet, Ledger) have shipped bugs from
  the ZIP-243/244 **consensus-branch-id** changing every ~quarter. A shared, tested library
  removes that whole class of failure for the ecosystem.
- **A public good, not a single-app tool.** The library is chain-agnostic on the "other"
  side: the same Zcash-HTLC engine works for ZEC↔BTC, ZEC↔any-HTLC-capable chain, or a DEX
  integration. We ship it as an independent package; our own desk is merely the first
  consumer and the living test harness.

### 4. What already exists (de-risked)

This is not a from-scratch proposal. A working reference desk is **live at
https://swap.sovxus.com** and open-source. Already implemented and tested:

- **Zcash transparent HTLC engine** — canonical redeem script (`OP_SHA256 <hashlock>
  OP_EQUALVERIFY` claim path / `<timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP` refund path), P2SH
  address derivation (including Zcash's two-byte base58 version prefixes that trip generic
  Bitcoin libraries), claim/refund transaction construction with hand-assembled scriptSigs,
  and **preimage recovery** from a counterparty's claim. Built on `@bitgo/utxo-lib`.
- **Consensus-branch-id as explicit, height-selected config** — the exact thing that
  silently breaks wallets. NU5 → NU6.3 tabulated; fails loudly rather than guessing.
- **Public-infrastructure chain access** — watch/broadcast via Blockchair (mainnet) with no
  self-hosted Zcash node required, so the tooling runs anywhere.
- **A full swap protocol** with the anti-theft timeout invariant enforced in code and
  unit-tested, plus a market-maker coordinator and a production web UI.
- **47+ automated tests** covering the HTLC construction, the safety invariant, and the
  swap state machine.

Grant funds take this from "working prototype" to "audited, documented, maintained public
good."

### 5. Deliverables

1. **`zcash-htlc` — standalone open-source npm package.** Extract and generalize the Zcash
   HTLC engine into an independently published, documented, semver'd library:
   build/derive/fund-watch/claim/refund/parse for transparent HTLCs; branch-id + expiry
   handling; pluggable chain-data providers (Blockchair, CipherScan, lightwalletd);
   mainnet + testnet.
2. **Cross-implementation test vectors** for Zcash transparent HTLC sighashes/txs, checked
   against `zcash_primitives` (`librustzcash`) so the branch-id/sighash is provably correct
   — the artifact that stops the recurring wallet bugs.
3. **End-to-end mainnet proof** of a full atomic swap (both directions) with a public
   write-up, and testnet rehearsal tooling for each NU activation.
4. **Documentation**: an integration guide, the security model (timeout invariant, refund
   guarantees, failure modes), and an NU-upgrade runbook.
5. **Reference desk** (sov-swap) kept open-source as the living example + regression harness.
6. **Maintenance commitment**: keep the branch-id table and vectors current through at least
   the next [N] network upgrades within the grant period, with a documented process for the
   community to continue after.

### 6. Milestones

| # | Milestone | Output | % |
|---|-----------|--------|---|
| M1 | Extract & publish `zcash-htlc` v0.1 (mainnet+testnet), docs | npm package + README | 25% |
| M2 | Cross-impl test vectors vs `librustzcash`; CI branch-id guard | vectors + green CI | 25% |
| M3 | End-to-end mainnet swap proof (both directions) + write-up | public report + txids | 25% |
| M4 | Security review remediation, NU-upgrade runbook, 1.0 release | audited-clean 1.0 | 25% |

### 7. Timeline

[Start date] → [end date], ~[3] months. Milestones roughly monthly (M1 wk 3, M2 wk 6,
M3 wk 9, M4 wk 12). Payment on milestone acceptance.

### 8. Budget

Paid in ZEC at the USD-equivalent on each milestone. **The figures below are a worked
example for a ~3-month solo effort — replace with your real rates/scope before submitting.**

| Item | Example (USD) |
|------|----------------|
| Engineering — library extraction, cross-impl vectors, hardening (~200 hrs @ $75) | $15,000 |
| Independent security review of the HTLC construction + sighash | $8,000 |
| Infrastructure (chain-data access, testnet, hosting) for the grant period | $500 |
| Documentation + maintenance reserve (branch-id updates across upcoming NUs) | $2,000 |
| **Total (example — adjust)** | **$25,500** |

Milestone split (from §6): M1 25% · M2 25% · M3 25% · M4 25%. Willing to scope down (e.g.
drop the external review to a community review) for a smaller ask if ZCG prefers.

### 9. Team

[Your background — relevant systems / cryptography / Zcash / open-source work.] The
reference implementation, a post-quantum PoW L1 (Sovereign/XUS), and this swap desk are all
authored by the applicant; links: https://github.com/cloudzombie/sov-swap and
https://github.com/cloudzombie/sov.

### 10. Open source & licensing

All deliverables are MIT/Apache-2.0, developed in public on GitHub, with no proprietary
components. The library has **no dependency on the Sovereign chain** — it is a general Zcash
tool.

### 11. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **Consensus-branch-id treadmill** (the core problem) | Explicit height-selected config + cross-impl vectors + CI guard + testnet rehearsal before each NU — this is a *deliverable*, not just a risk. |
| Public chain-data API reliability/limits | Pluggable providers + documented self-host path (lightwalletd/Zebra). |
| Transparent-only (shielded can't HTLC) | Clearly scoped and documented; transparent HTLC is the correct, only trustless option and is fully supported by consensus. |
| Sighash bug stranding funds | Independent review + mainnet proof gated before any "production-ready" claim; the refund path bounds worst case. |

### 12. Success metrics

- `zcash-htlc` published, documented, and used by ≥1 project beyond ours.
- Cross-impl vectors passing against `librustzcash`; CI catches a branch-id drift.
- A completed, publicly-verifiable mainnet atomic swap (linked txids on both chains).
- Zero fund-loss incidents in the reference desk over the grant period.

### 13. Prior funding / conflicts

[State any prior ZCG/Zcash funding and any conflicts of interest, or "none."]

---

*Contact: security@sovxus.com. Reference implementation: https://swap.sovxus.com ·
https://github.com/cloudzombie/sov-swap*
