# @sov-swap/coordinator

The XUS↔ZEC atomic-swap **market-maker desk**. Holds the seeded XUS + the desk's ZEC key,
watches both chains, drives every swap through `@sov-swap/core`'s state machine, and serves
the small API the web app talks to.

Non-custodial toward the user (the HTLC guarantees they can always refund); the desk's own
inventory lives here.

## Run

    cp .env.example .env   # fill in SOV_MM_SEED_HEX, ZEC_MM_WIF, rate, bounds
    npm run build
    npm start

## API
- `GET /api/health` → `{ ok, net }`
- `GET /api/quote` → `{ rateXusPerZec, minZec, maxZec, deskAccount, inventoryXus, net }`
- `POST /api/swap` `{ hashlock, zecRefundPubkey, xusRecipient, zecAmountZat }` → swap view
- `GET /api/swap/:id` → swap view (phase, addresses, txids)

The desk only ever **receives** ZEC and **pays out** XUS, so it needs ZERO pre-funded ZEC —
seed it with mined XUS and it accumulates ZEC. See the repo README for the full flow.
