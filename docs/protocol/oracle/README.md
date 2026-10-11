# Oracle feed v1

The relay is the price and energy oracle. A client makes one request to its relay and gets one
normalised feed; it knows nothing about any price provider, chain statistics API or electricity
market. The relay owns the provider adapters, sampling, smoothing, history and any provider keys.

The feed supports valuation and host-composed AVU defaults for message stamps. A stamp default
is a recipient-value suggestion, captured as a native amount before signing; it is not a
settlement quote for swaps or contracts. Missing or stale observations cannot price a default.

Files: this document, `feed.schema.json` (JSON Schema of the response), `feed.example.json` (a
small valid response; `packages/price-feeds/test/feed.jest.test.ts` parses it with the client's
parser). The TypeScript types and parser are `packages/price-feeds/src/feed.ts`.

## Request

There are two shapes, and only two.

    GET /oracle/v1/feed?latest
    GET /oracle/v1/feed?since=<unixSeconds>&until=<unixSeconds>&step=<seconds>

**Latest** is what the app polls, app-wide, every 10 minutes while its window is visible and
never while it is hidden. The answer carries the current value of every series and nothing else:
one point per series (the current smoothed price of each asset, the current difficulty, block
reward and market capitalisation of each basket chain, the efficiency step in force, the
latest `electricity/aggregate` point). That is about 35 series of one point: under 10 kB of
JSON before compression. The client
appends each latest answer to its local series, and computes the AVU rate of each asset from it
once.

**A range** is asked for only by a chart while it is on screen, and only for the stretches its
local series lack (before its first local point, or while the app was closed). `since`, `until`
and `step` are all required. Each series carries at most one point per `step` seconds: the last
point of each step. The client stores what it receives into the same local series, so a range is
asked for once.

No authentication: the feed is public data and identical for every user. The relay is a trusted
service: the client does not cross-check its values against anything else.

Caching: a latest answer is sent with `Cache-Control: public, max-age=600` and an `ETag`; a range
whose `until` is in the past may be cached for a day.

A relay that does not serve the feed answers `404`. Only a 404 makes the client use its temporary
direct adapter (`packages/price-feeds/src/temporary-direct-feed.ts`, to be deleted when relays
serve this route); any other failure leaves the client showing what it last received, with its
age.

## Response

    {
      "version": 1,
      "generatedAt": 1791650000,
      "basket": { ... },
      "electricity": { ... },
      "series": { "<name>": { "unit", "source", "asOf", "stale", "points": [[t, value], ...] } }
    }

### Timeseries semantics

A series is a list of `[unixSeconds, value]` points, oldest first, no two with the same time.
There is one lookup:

    at(t) = the value of the latest point whose time is <= t

It is a step-hold (floor) lookup. Nothing is interpolated. Before the first point the series has
no value: a first value is never extended backwards. After the last point the last value holds,
however old; the reader shows its age when that matters (`asOf`, `stale`).

Values are JSON numbers. Times are whole seconds.

### Series names

| name | value | notes |
| --- | --- | --- |
| `price/<assetId>` | US dollars per whole coin | the relay's smoothed price |
| `marketCap/<assetId>` | US dollars | coins in existence x price |
| `difficulty/<chainId>` | the chain's difficulty | expected hashes per block = difficulty x the basket chain's `hashesPerDifficulty` |
| `blockReward/<chainId>` | whole coins per block paid to the miner | subsidy only, no fees; where consensus sends part of the subsidy elsewhere (eCash) this is the miner's part |
| `efficiency/<algorithm>` | hashes per kWh | curated dated steps: the hardware assumed for the algorithm at each date |
| `electricity/aggregate` | US dollars per kWh | REQUIRED for AVU_spot. One point per UTC day, stamped at the start of the day, and already windowed: the point for day d is the equally weighted mean, over the regions, of each region's mean daily wholesale day-ahead price in the `windowDays` days ending at d. A region with fewer than `minDays` daily prices in that window is left out of that day's point. A day on which no region qualifies has no point. |
| `electricity/<regionId>` | US dollars per kWh | optional, for display: one region's daily mean price, one point per UTC day, not windowed. May be zero or negative. |

`assetId` and `chainId` are the canonical chain identifiers of the chain registry
(`docs/protocol/chains/v1.json`), always the main network's: `btc-mainnet`, `bch-mainnet`,
`xec-mainnet`, `doge-mainnet`, `monad-mainnet`, `ethereum-mainnet`, `solana-mainnet`,
`hyperliquid-mainnet`. A chain's native coin is priced under its chain identifier. Two basket
coins are not Frank networks and have no registry row; in this feed, and only here, they are
`ltc-mainnet` and `xmr-mainnet`. They are oracle inputs, not supported networks.

A token that lives on several chains is not a chain's native coin and is priced once, under
its own asset id: `price/usdc` and `price/usdt` (US dollars per whole token). These two are the
token ids of this version; they have `price/` series only.

`algorithm` is `sha256`, `scrypt` or `randomx`.

A series the relay cannot provide is absent. An absent series, or a lookup before a series' first
point, makes what depends on it unavailable; the client never substitutes a value.

### Series metadata

- `unit`: what the value is, for a reader of the JSON (`USD`, `hashes/kWh`, ...).
- `source`: a short label for display, naming where the values come from
  (e.g. `Blockchair`, `Cambridge CBECI, curated`, `Bitmain / AsicMinerValue listings, curated`).
- `asOf`: unix seconds at which the latest point was observed or published. For a curated or
  monthly series this is the retrieval date, not the point's time.
- `stale`: true when the relay could not refresh the series within its normal interval. The
  client then shows the age of the value beside it.
- `estimatedBefore` (optional): unix seconds; points before it are estimates and the client
  marks them so (the RandomX efficiency steps before the first ASIC are processors rated at
  their package power limit, not a measured wall figure).

### What a response must contain

A latest answer: for every series its latest point.

A range answer: for every series the points inside the range (thinned to `step`), and in front of
them the floor point at `since` (the latest point at or before it), so the series can be
evaluated at the start of the range.

The points of a range answer and of latest answers are the same kind of point. A client keeps one
local series per name; a point received later for a time it already holds replaces the held one.

### `basket`

    "basket": {
      "weightCap": { "entry": "bitcoin", "max": 0.6 },
      "entries": [
        { "id": "bitcoin", "label": "BTC", "algorithm": "sha256",
          "chains": [ { "chain": "btc-mainnet", "hashesPerDifficulty": 4294967296 } ] },
        { "id": "scrypt", "label": "LTC+DOGE", "algorithm": "scrypt",
          "chains": [ { "chain": "ltc-mainnet", "hashesPerDifficulty": 4294967296 },
                      { "chain": "doge-mainnet", "hashesPerDifficulty": 4294967296 } ] },
        { "id": "monero", "label": "XMR", "algorithm": "randomx",
          "chains": [ { "chain": "xmr-mainnet", "hashesPerDifficulty": 1 } ] }
      ]
    }

An entry is one body of hashing and every chain it is paid by. Merge-mined chains are one entry.
The client hardcodes none of this.

### `electricity`

    "electricity": {
      "windowDays": 30,
      "minDays": 10,
      "regions": [
        { "id": "de-lu", "label": "Germany-Luxembourg day-ahead",
          "attribution": "Bundesnetzagentur | SMARD.de, CC BY 4.0",
          "lastContributed": 1791504000 }
      ]
    }

Metadata for display; the client computes nothing from it. `windowDays` and `minDays` are the
window and the threshold `electricity/aggregate` was built with. `regions` names the regional
sources behind it, with the attribution each asks for and `lastContributed`: the day (unix
seconds, start of the UTC day) of the latest aggregate point the region counted in, absent if
it never has. A region whose `lastContributed` is older than the aggregate's latest point is
not in the current figure, and the client says so.

## What the client computes from the feed

All of it by the one lookup above, at any time `t` (now, or a point on a chart):

    $/kWh of an entry (t) = sum over its chains of
        price(t) x blockReward(t) / (difficulty(t) x hashesPerDifficulty)
      x efficiency(t)

    entry weight (t) = sum of its chains' marketCap(t), as a share of the entries that have
        every input at t; the capped entry's share is limited to `max` and the rest is
        divided among the others by market cap

    AVU_hash(t) [kWh per $] = sum over entries of weight x 1 / ($/kWh)

    AVU_spot(t) [kWh per $] = 1 / at(`electricity/aggregate`, t); unavailable when the
        series has no point at or before t, or the value is not positive. The relay has
        already averaged prices over the window and across regions; the client only looks
        the value up and inverts it. (Prices are averaged and the mean inverted: never the
        inverse of a single day, never a mean of inverses.)

    AVU value of an amount of a coin = amount x price(t) x AVU_hash(t)

An entry missing any input at `t` is left out and the weights are taken over the rest.
