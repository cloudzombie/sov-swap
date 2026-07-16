# Zcash grant application

Formal package for a **Zcash Community Grants (ZCG)** application: fund a maintained,
open-source **transparent-HTLC atomic-swap library** (`zcash-htlc`) — a public good for the
Zcash ecosystem — with sov-swap as the live reference implementation (swap.sovxus.com).

| Doc | What it is |
|-----|------------|
| [`ZCG-PROPOSAL.md`](./ZCG-PROPOSAL.md) | The formal proposal — summary, motivation, deliverables, milestones, example budget. |
| [`TECHNICAL-DESIGN.md`](./TECHNICAL-DESIGN.md) | HTLC construction, security model, the consensus-branch-id handling, failure analysis. |
| [`FORUM-POST.md`](./FORUM-POST.md) | Community-forum RFC to post **before** applying (ZCG expects public discussion first). |
| [`SUBMISSION-CHECKLIST.md`](./SUBMISSION-CHECKLIST.md) | What you fill in, the submission order, and high-leverage things to do first. |

**Framing:** ZCG funds public goods that benefit *Zcash*. The fundable deliverable is the
reusable `zcash-htlc` package (build/watch/claim/refund/parse transparent HTLCs, with the
branch-id handling that keeps breaking wallets) + cross-impl test vectors — not "an XUS
project." Start with `SUBMISSION-CHECKLIST.md`.
