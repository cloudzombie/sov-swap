# Submission checklist

The technical case is written and backed by a live, open-source reference implementation.
What remains is *yours* to fill and the process to follow.

## 1. Fill these in (only you can)

In [`ZCG-PROPOSAL.md`](./ZCG-PROPOSAL.md):

- [ ] Applicant legal name / entity
- [ ] Contact (email / forum handle / Discord)
- [ ] **Payout ZEC address** (transparent or unified)
- [ ] **Requested amount** — set your real number (the $25,500 is an editable example; scope
      up or down; you can drop the external audit line for a smaller ask)
- [ ] Duration + start/end dates (Milestones/Timeline §6–§7)
- [ ] Team background (§9) — your systems/crypto/open-source track record
- [ ] Prior funding / conflicts (§13) — or "none"

In [`FORUM-POST.md`](./FORUM-POST.md): name/handle/contact.

## 2. Process (ZCG expects this order)

1. **Post to the Zcash Community Forum** (Grants category) using `FORUM-POST.md`. Gather
   feedback for ~1–2 weeks; respond in-thread.
2. **Apply via the ZCG application form** at https://zcashcommunitygrants.org (or the current
   ZCG intake link — verify it's current). Paste/attach `ZCG-PROPOSAL.md`, and **link the
   forum thread** and the repo (https://github.com/cloudzombie/sov-swap) + live demo
   (https://swap.sovxus.com).
3. **Attach the technical design** (`TECHNICAL-DESIGN.md`) as supporting material.

## 3. Strengthen before you submit (optional but high-leverage)

- [ ] Land the **one real mainnet swap** and link both txids in §12 — a completed,
      publicly-verifiable atomic swap is the single most convincing artifact.
- [ ] Publish an early `zcash-htlc` package skeleton (even v0.0.1) so reviewers can see the
      library shape, not just the desk.
- [ ] Add one cross-impl test vector checked against `zcash_primitives` as proof-of-approach.

## 4. Framing reminders

- ZCG funds **public goods that benefit Zcash** — lead with the reusable library and the
  branch-id problem it solves for *the ecosystem*, not with XUS. XUS is the reference
  consumer/test harness.
- Be explicit it's **transparent-only** and why (shielded has no script) — reviewers will
  ask; answering up front reads as competence.
- Keep the ask proportional and milestone-gated; ZCG likes de-risked, already-started work —
  which this is.
