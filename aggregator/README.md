# aggregator — every launchpad's coins, as inventory

A launchpad earns only from the coins it launched. A terminal earns from every coin on the chain,
whoever launched it — which is why trading terminals out-earn the launchpads they sit on top of.
This service is the data half of that: a multi-chain, multi-launchpad indexer. `AggregatorRouter`
(in `contracts/contracts/v4/`) is the half that charges.

It also answers the question the foundry needs: **how crowded is this kind of launch right now?**

## How it differs from `backend/`

`backend/` indexes one launchpad (the legacy V3 `LaunchpadFactory`) on one chain, because that is
what it was built for. Here every launchpad is a **source** in a config file, and a new one is added
by describing its launch event rather than by shipping code for it.

```jsonc
// sources.json — copy sources.example.json
{
  "chains": [
    { "chainId": 4663, "label": "Robinhood Chain", "rpcUrl": "https://…", "logChunk": 10000 }
  ],
  "sources": [
    // ours: the ABI is known, so launches, graduations and pool ids are exact
    { "id": "doubleplus", "label": "doubleplus", "kind": "venture",
      "chainId": 4663, "address": "0x…", "startBlock": 128714375 },

    // anyone else's: described, not hard-coded
    { "id": "some-pad", "label": "Some launchpad", "kind": "generic",
      "chainId": 4663, "address": "0x…", "startBlock": 0,
      "launchEvent": "event TokenCreated(address indexed token, address indexed creator, string name, string symbol)",
      "map": { "token": "token", "creator": "creator", "name": "name", "symbol": "symbol" },
      "graduateEvent": "event Graduated(address indexed token)",
      "graduateMap": { "token": "token" } }
  ]
}
```

`${VAR}` in an `rpcUrl` is expanded from the environment, so a keyed endpoint stays out of the file.

**No third-party ABI is hard-coded anywhere in this service, deliberately.** An ABI we have not
verified against the deployed contract is a silent source of wrong data: it would either return
nothing, or decode the wrong argument as the coin. A description that does not match its own event
is rejected at startup, and a log whose shape is not what was described is skipped rather than
guessed at.

## Run it

```bash
npm install
cp sources.example.json sources.json   # then edit it
npm run build && npm start             # or: npm run dev
npm test                               # 20 tests
```

| Variable | Default |
| --- | --- |
| `SOURCES_FILE` | `sources.json` |
| `PORT` | 8081 |
| `DB_PATH` | `./data/aggregator.db` |
| `POLL_INTERVAL_MS` | 5000 |
| `WINDOW_DAYS` | 7 |

Each source keeps its own cursor, committed per page, so adding a launchpad backfills only that one,
an interrupted backfill resumes where it stopped, and one unreachable endpoint does not stall the
rest.

## API

| Route | What it gives |
| --- | --- |
| `GET /health` | liveness, plus what has been indexed so far |
| `GET /api/sources` | the chains and launchpads being indexed |
| `GET /api/coins?chainId=&source=&limit=&offset=` | inventory, newest first |
| `GET /api/saturation?windowDays=` | how crowded each chain is |
| `WS /ws` | `coin:launched`, `coin:graduated` |

Indexing starts after the server is listening, so `/health` answers during a long first backfill
instead of looking dead to a platform health check.

## What saturation can and cannot see

This feeds the foundry's selection loop, which divides a format's fee income by the number of live
copies of it. Being straight about the limits matters, because the loop spends money on the answer.

**Exact:** how many coins each launchpad launched in the window, and how many reached an open
market. Read from its own events.

**Not observable:** a third-party coin's *terms* — tax split, dividend policy, the format it is
copying. Those are not in its launch event, and usually not on chain. So rival counts cannot be
keyed to one of our formats for anyone else's coins.

**The projection:** every coin launched on the same chain in the window counts as a rival to every
format on that chain. That is coarse on purpose, and coarse in the safe direction — it overstates
competition, so the foundry retreats from a crowded chain early rather than discovering saturation
by losing money on it. The foundry subtracts its own copies before applying it, so a launch is never
counted twice. Our own coins are additionally counted exactly, by their real format, inside the
foundry.

The graduation rate is reported next to the launch count, because it is the better signal: a chain
minting thousands of coins that never graduate is saturated however high its launch count looks.

## Not built here

The terminal's front end. A `VITE_BRAND=aggregator` flavor would reuse `web/`'s `Explore`,
`ExploreBoard` and `Token` components over `/api/coins`. It is a UI surface rather than revenue
logic, and shipping a multi-launchpad trading screen whose adapters have not been verified against
live contracts would be worse than not shipping one.
