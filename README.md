# sov-swap — trustless XUS ↔ ZEC atomic swaps

A hash-timelock atomic swap desk between **Zcash (transparent ZEC)** and **Sovereign
(XUS)**. No bridge, no custodian, no wrapped asset: one 32-byte SHA-256 secret locks a
contract on *both* chains, and revealing it to take one leg mathematically publishes it to
take the other. Either both legs settle or both refund.

Launch direction: **ZEC → XUS** (buy XUS with ZEC), with the operator as a market-maker
desk. The desk seeds **only XUS** (mine it) — it pays out XUS and *receives* ZEC, so it
needs zero pre-funded ZEC and accumulates a ZEC balance as it trades.

```
packages/swap-core   the cross-chain HTLC engine + protocol + swap state machine (tested)
services/coordinator the market-maker desk: watches both chains, executes the MM leg, API
apps/desk            the swap terminal web app (React/Vite)
```

## Why it's trustless

- **Zcash leg** — a transparent P2SH HTLC: `OP_SHA256 <hashlock> OP_EQUALVERIFY` (claim) /
  `<timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP` (refund).
- **XUS leg** — the SOV chain's native `htlc_lock`/`htlc_claim`/`htlc_refund`, where the
  runtime checks `sha256(preimage) == hashlock`.
- Same single SHA-256 hashlock on both sides. **The invariant that makes it a swap and not
  a theft:** the user (initiator, locks ZEC) always gets the *longer* refund timeout; the
  desk (responder, locks XUS) the shorter one — enforced in code (`assertSafeTimeouts`),
  re-checked against live tips before the desk commits a single grain.

## The flow

1. Browser mints a secret, a ZEC refund key, and a hybrid-PQ XUS wallet — none leave the
   device.
2. Desk quotes the rate and returns a one-time ZEC HTLC address.
3. User sends ZEC to it from any wallet.
4. On confirmation, the desk locks the matching XUS (shorter timeout).
5. User clicks **Claim** — receives XUS and reveals the secret.
6. Desk reads the secret off the SOV chain and sweeps the ZEC. Done.

If anything stalls, both sides refund via their HTLC timeout — no counterparty risk.

## Go-live runbook

**1. Seed the desk.** Mine/transfer XUS to the desk account (derived from `SOV_MM_SEED_HEX`).
Generate a Zcash key; its address receives the ZEC the desk earns.

**2. Coordinator** (on the faucet droplet — no new host needed):
```
cd services/coordinator && npm ci && npm run build
cp .env.example .env    # set SWAP_NET, keys, RATE_XUS_PER_ZEC, MIN/MAX_ZEC
# install the systemd unit + nginx https vhost from ./deploy/, then:
systemctl enable --now sov-swap-coordinator
```
Serve it over https (nginx + the existing certbot) at e.g. `swap-api.sovxus.org` so the
browser (https) can reach it and tunnel SOV-RPC through `/api/sov`.

**3. Web app** (Vercel, like sovxus.com):
```
cd apps/desk && VITE_COORDINATOR_URL=https://swap-api.sovxus.org npm run build
```
Deploy `dist/` (or point Vercel at this dir). Suggested domain: `swap.sovxus.com`.

**4. Prove it before real money.** Run one full round-trip on **Zcash testnet** first
(`SWAP_NET=testnet`, TAZ from the zfaucet), playing both user and desk, and confirm the
XUS moves desk→user and the ZEC is swept — plus the timeout→refund path. Only then flip to
mainnet with small bounds.

## Test

```
cd packages/swap-core && npm test     # 49 tests: HTLC (both legs), protocol, machine
```

## The one operational tax

Zcash rotates its **consensus branch id** ~quarterly (NU6.3 activates 2026-07-28). A stale
id silently produces unbroadcastable transactions. It's explicit, height-selected config in
`packages/swap-core/src/zcash/network.ts` — keep it current and rehearse on testnet before
each activation.
