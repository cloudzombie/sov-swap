# Forum post draft — Zcash Community Forum

> Post this to https://forum.zcashcommunity.com (category: *Grants* / *Community
> Collaboration*) **before** submitting the formal ZCG application. ZCG values public
> discussion; gather feedback here, then link this thread from the application.
> Fill the `[…]` bits first.

---

**Title:** `zcash-htlc` — an open-source, maintained library for transparent-address atomic swaps (RFC / feedback before a ZCG application)

Hi all — I'm [name / handle], and I'd like feedback before applying to Zcash Community
Grants.

**The gap.** Transparent Zcash can do everything a cross-chain **atomic swap** needs —
`OP_SHA256`, `OP_CHECKLOCKTIMEVERIFY`, P2SH — and Zcash's own **ZIP-300** describes exactly
this. But there is **no maintained, correct, well-tested library** for building these HTLCs.
Teams re-implement them and get the **ZIP-243/244 consensus-branch-id sighash** wrong, which
is the exact thing that has repeatedly broken shipped wallets around network upgrades. The
shielded side has `librustzcash` and `lightwalletd`; transparent scripting has nothing
comparable.

**What I propose to fund.** Turn a **working, deployed reference implementation** into a
reusable public good: **`zcash-htlc`**, an MIT/Apache TypeScript library that builds,
funds-watches, claims, refunds, and parses transparent HTLCs — with **branch-id handling as
a first-class, tested feature**, cross-implementation test vectors checked against
`librustzcash`, and a maintenance commitment across upcoming NUs.

**It already works.** A live reference desk swaps ZEC ↔ a post-quantum L1 (XUS) trustlessly
today at **https://swap.sovxus.com** (open-source: https://github.com/cloudzombie/sov-swap),
including the two-byte-address and branch-id gotchas, running on public infrastructure with
no self-hosted node. The grant hardens it into a standalone library the whole ecosystem can
use — for ZEC↔BTC, ZEC↔anything-HTLC, or DEX integrations — not tied to my chain.

**Why it benefits Zcash:** more trustless ZEC on/off-ramps with **no custodian or bridge**,
and a shared building block that removes a recurring class of wallet bugs.

**Scope is transparent-only** (shielded has no script — clearly documented). Deliverables,
milestones, security model, and the branch-id design are written up here:
https://github.com/cloudzombie/sov-swap/tree/main/grant

Would especially value feedback from anyone who's fought the branch-id sighash, and from
ECC/ZF folks on the `librustzcash` vector approach. Thanks!

*— [name / contact]*
