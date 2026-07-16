# Zcash grant application

Formal documents for a **Zcash Community Grants (ZCG)** application to fund an
open-source, maintained **transparent-HTLC atomic-swap library** for the Zcash
ecosystem, with sov-swap as the reference implementation (live at swap.sovxus.com).

- [`ZCG-PROPOSAL.md`](./ZCG-PROPOSAL.md) — the formal proposal (fill the bracketed fields).
- [`TECHNICAL-DESIGN.md`](./TECHNICAL-DESIGN.md) — construction, security model, the
  consensus-branch-id handling, and failure analysis.

**Framing:** ZCG funds public goods that benefit *Zcash*. The fundable deliverable is a
reusable `zcash-htlc` package (build/watch/claim/refund/parse transparent HTLCs, with the
branch-id handling that keeps breaking wallets) + cross-impl test vectors — not "an XUS
project." The swap desk is the reference consumer and living test harness.

Before submitting: complete the applicant/budget/timeline fields, and consider posting to
the Zcash Community Forum for feedback first (ZCG values public discussion).
