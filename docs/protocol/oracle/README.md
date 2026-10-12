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
one point per series (the current smoothed price of each asset, the observed hashrate, miner
revenue and market capitalisation of each basket chain, the efficiency step in force, the
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
| `hashrate/<chainId>` | hashes per second | upstream observed-work estimate over the same window as miner revenue; never instantaneous difficulty |
| `minerRevenue/<chainId>` | whole coins per second paid to the miner | subsidy plus actual fees, after consensus allocations (eCash applies its share to both); absent fee observations are unavailable, while observed zero fees are valid |
| `minerSubsidy/<chainId>` | whole coins per second paid to the miner excluding fees | observed issuance after consensus allocations when exact fees are unavailable; explicitly subsidy-only, never total revenue |
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
        price(t) x minerRevenue(t) / hashrate(t)
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

### Mining observation alignment

Hashrate and the chosen receipt series (minerRevenue, otherwise minerSubsidy) must have identical timestamps/windows. The consumer rejects unmatched observations rather than combining differently aged readings. Live block receipts are aggregated over the stats snapshot’s last `blocks_24h` heights ending at its best block, and the block count and issuance must agree. Hashrate is the provider’s 24-hour chainwork/time estimate, not a physical measurement of mining hardware. Historical block-work sums divided by calendar seconds are likewise observed-work estimates; they include actual block cadence instead of treating current target difficulty as a rate.

AVU Hash uses `price × minerRevenue / hashrate × efficiency`. Merge-mined coins contribute receipts per hash to one entry, with energy counted once. Allocated miner shares model consensus percentages; rounding of individual coinbase outputs can create sub-base-unit aggregate differences. Existing historical rows without fees/work observations do not supply those series. Monero is unavailable until a provider supplies complete matching receipts/work data. BTC historical receipts use blockchain.com miners-revenue (including fees), same-day price and hashrate. Cambridge efficiency remains a modeled power/fleet estimate; this is not a measured miner electricity bill.

### Dated Gold reference

`price/gold` is USD per troy ounce (`unit: "USD/troy ounce"`), not a token or a chain. Chainlink XAU/USD rounds carry the validated `updatedAt` observation timestamp through provider parsing and collection. A sole dated provider is stored at that timestamp with its exact price, without collection-time smoothing or repeated polling points. Multi-provider coin series remain derived samples: their raw inputs retain collection-round timestamps so the sample can be replayed, including when a dated source returns the same earlier quote again. Sole-source dated observations retain their source timestamps in both raw records and served series.

Gold chart values are coin USD price divided by dated Gold USD/troy-ounce price, using the last actual Gold observation at or before each coin-price timestamp and a seven-day maximum age. No annual averages, future quotes or current-value backfill are used. Missing historical coverage remains unavailable. Configured collection starts accumulating actual rounds; long-range phase-aware historical round import is separate from this implementation. The existing feed version and `[unixSeconds,value]` point format are unchanged.


### Observed subsidy when fees are unavailable

`minerSubsidy/<chain>` is observed issuance per second after the dated miner allocation, explicitly excluding fees. It is not total mining revenue. A live fee-source failure may produce this series with `hashrate/<chain>` from the same stats observation; `minerRevenue` is emitted only when actual fee totals are verified. Missing fees never become observed zero. The AVU consumer prefers fee-inclusive revenue at the matching work timestamp, otherwise uses matching net subsidy and retains the fee basis for display and default attention-stamp quote metadata. Zero actual fees remain fee-inclusive observations. The fee omission is not claimed insignificant on every chain.
