# Tomorrow — plan (2026-07-17)

Where we left off: the XUS↔ZEC atomic-swap desk is **live at swap.sovxus.com** on free
lightwalletd, and the first live acceptance swap **proved the mechanism on mainnet** (ZEC
locked → desk locked XUS → recipient credited). Four real bugs were found and fixed live,
including the critical **fee-bootstrap** (a fresh recipient can't pay the claim fee). One
thing is still unproven: the **Zcash sweep** (the stuck first claim never revealed the
secret on-chain).

## A. Finish the atomic swap — make it truly end-to-end
1. **Prove the ZEC sweep.** Run one clean swap start-to-finish (miner ON the whole time) and
   confirm the desk sweeps the ZEC (`zecSweepTxid` set, HTLC address emptied). This is the
   last unproven piece and validates the ZIP-243 sighash byte-order for real.
2. **Recover the pending test funds.** The 0.01 ZEC is in the Zcash HTLC (refundable after
   its ZEC timeout with the refund key); the desk's escrowed 1 XUS refunds to the desk at
   SOV height 7011. Reconcile once mined.

## B. Swap app — "rock solid" UX (the list)
1. **Hand out a MNEMONIC, not a raw seed.** Requires verifying SDK HD ↔ Rust `sov_wallet`
   HD parity FIRST (memory: "Rust CLI parity pending") — derive from the same mnemonic in
   both and confirm identical accounts before shipping. Then the sov-station import is
   one-click (24 words).
2. **Live mempool / pending tracker.** After "Claim", show submitted → in mempool →
   confirming → settled, with the tx id. Stop rendering *"already in the pool"* as a failure
   (it means pending/success).
3. More null-guards / error states audit — no more black pages under any swap state.

## C. Ship the chain release
4. **Cut & deploy v0.1.85** (notes in `sov/.github/RELEASE-0.1.85.md`): multisig HIGH fix +
   oracle breaker + P2P inbox cap + RPC rate-limit + macOS M1 fix + sov-station seed import.
   Version bump → tag → gate/build → deploy to BOTH relays + tell the user to update the
   miner (coordinated consensus upgrade). Same flow as the v0.1.84 noban release.

## D. Tests + hygiene
5. **Build the sov-swap test suite** the user asked for: unit tests for the SOV leg
   (lock/claim/refund/transfer + the grains/hashlock-array wire encodings that bit us), the
   fee-bootstrap, the machine end-to-end with fakes, and the lightwalletd adapter (byte-order
   round-trip). Then push swap-core + coordinator changes to `cloudzombie/sov-swap` and
   redeploy the desk.

## Standing operational notes
- **The SOV chain only advances when the user's miner runs** — it stalled repeatedly during
  the test. Any live swap needs the miner up the whole time.
- Free Zcash data = zec.rocks lightwalletd (no key, $0). Blockchair dropped.
- Desk keys backed up at `~/Desktop/keys/`; desk `.env` on the explorer droplet (chmod 600).
- Hosting all on the explorer droplet (104.236.244.93): swap.sovxus.com + coordinator + the
  Codex-upgraded explorer (sovxus.org, node 24 at /opt/node24).

## E. NEW DIRECTIVE (2026-07-16, for a proper design session) — SOV's own contract tooling
Build SOV's OWN smart-contract toolchain — **"nation-state" grade**, WASM-native (per the
VM discussion; NOT a bolted-on EVM — it fights the PQ / blake3-implicit-account identity).
Everything **"NASA code compliant"**: hold it to high-assurance software rules —
JPL / NASA **Power of Ten** (bounded loops, no recursion, no post-init dynamic allocation,
check every return, assertions, small functions, minimal preprocessor, restricted pointers),
plus static analysis + zero-warning builds + full test/KAT coverage. Deliverable to scope:
an ergonomic Rust contract SDK + templates on the wasmi VM, a hardened host-ABI contract,
and a compliance checklist/CI gate. See chain/docs/vm-and-token-composability.md for the
current VM + the three open questions (cross-contract calls, contract-held XUS, gas tuning).
