# Arbitrary Value Unit (AVU) Energy Oracle

## Overview

Frank eliminates fiat currencies (such as the US Dollar) from core wallet interfaces, atomic swaps, and token comparisons. In their place, Frank uses the **Arbitrary Value Unit (AVU)**:

$$1\text{ AVU} \equiv 1\text{ Kilowatt-Hour (kWh)} = 3.6\times 10^6\text{ Joules}$$

Every token, asset, and wallet balance is measured directly in the physical energy (kWh) it commands.

---

## Why the AVU is Valuable

### The "Oracle-less" Paradigm
Traditional financial applications rely on centralized or federated price oracles (Chainlink, Pyth, Bloomberg, central exchange orderbooks, or commodity brokers). These introduce:
* Relayer collusion and bridge exploit vectors.
* Fragility during extreme market volatility.
* Jurisdictional regulatory attack vectors.

In contrast, **Proof-of-Work thermodynamic consensus is inherently oracle-less**:
* **Hashrate, Difficulty, and Subsidy Schedules** are baked directly into consensus rules and verified independently by full nodes.
* The physical cost of mining cannot be faked or printed. It is governed by the laws of physics: electricity, transistor switching, and thermal dissipation.
* Millions of independent mining operators globally arbitrage electricity down to its marginal thermodynamic cost, transforming the global ASIC fleet into an unbribable, decentralized sensor of the real-world value of energy.

### Energy: At the Base of Every Single Supply Chain
Thermodynamically, **every physical good and human service is organized energy**:
* **Food**: Natural gas synthesis into ammonia fertilizer (Haber-Bosch) + diesel machinery + solar irradiance + refrigerated logistical chains.
* **Semiconductors**: High-purity monocrystalline silicon refined at thousands of degrees + extreme ultraviolet (EUV) lithography lasers consuming hundreds of kilowatts each.
* **Fresh Water**: Energy required for reverse-osmosis desalination, deep aquifer pumping, and urban transport.
* **Shelter**: Calcination of limestone into cement ($1,450^\circ\text{C}$) + blast furnace steel reduction.
* **Compute & AI**: Terawatt-hours consumed by tensor processing units, cooling chillers, and data infrastructure.

Energy is the fundamental invariant cost input of the global economy. By pricing assets in **AVU ($1\text{ kWh}$)**, purchasing power is measured against the root denominator of physical reality.

### Refusing the USD Meme: Weakening the Fed's Psychological Hold
Money is fundamentally the most pervasive coordination meme in human society. For nearly a century, software interfaces, spreadsheet programs, and banking applications have unquestioningly defaulted to the US Dollar as the universal unit of account. This ubiquitous visual conditioning creates a powerful psychological illusion: the belief that the Dollar is an objective baseline, while the real world "fluctuates."

In truth, the Federal Reserve can dilute the dollar supply with arbitrary ledger entries, yet software continues to render that diluted denominator as the immutable ground truth.

**Frank explicitly rejects the USD meme.** By deliberately stripping fiat currency display from the wallet interface and replacing it with physical kilowatt-hours (AVU):
1. **It breaks the psychological monopoly of the Fed**: Users are no longer conditioned to evaluate their life energy and savings in units decreed by central planners.
2. **It deflates the currency meme**: A meme only retains power as long as participants repeat and display it. Denying fiat real estate in self-custodial software directly weakens its social network effect.
3. **It aligns perception with thermodynamics**: The user's wealth is presented in terms of invariant physical work ($3.6 \times 10^6 \text{ Joules}$), where no committee or algorithm can print more energy out of thin air.

---

## Bypassing the CPI & Exposing the True Debasement of USD

### The Flaws of the Consumer Price Index (CPI)
For decades, official government inflation metrics—predominantly the Consumer Price Index (CPI)—have obscured currency debasement through statistical engineering:
1. **Substitution Bias**: Assumes consumers substitute down to lower-grade alternatives when prime goods surge in price.
2. **Hedonic Adjustments**: Artificially subtracts subjective "quality improvements" from sticker price hikes.
3. **Exclusion of Capital Goods & Assets**: Omits real estate, farmland, and equities—the primary sinks where newly created fiat accumulates.

### Tracking the Real Worth of the Dollar Over Time
Because the face value of a dollar bill remains stamped "$1.00", the public perceives prices as "mysteriously rising," when in fact **the currency measuring stick is shrinking**.

Anchoring to **$1\text{ AVU} \equiv 1\text{ kWh}$** lays bare the real worth of the dollar across decadal horizons:

| Era | US Industrial Electricity Cost | **kWh of Energy Purchased per \$1.00** | Dollar Purchasing Power in AVU |
| :--- | :--- | :--- | :--- |
| **1930s** | $\approx \$0.007 / \text{kWh}$ | **$142.8\text{ kWh / \$}$** | **$142.8\text{ AVU / \$}$** |
| **1970** | $\approx \$0.010 / \text{kWh}$ | **$100.0\text{ kWh / \$}$** | **$100.0\text{ AVU / \$}$** |
| **2000** | $\approx \$0.045 / \text{kWh}$ | **$22.2\text{ kWh / \$}$** | **$22.2\text{ AVU / \$}$** |
| **2026 (Present)** | $\approx \$0.084 / \text{kWh}$ | **$11.9\text{ kWh / \$}$** | **$11.9\text{ AVU / \$}$** |

Over the past century, the US Dollar has lost **$> 91\%$ of its energy purchasing power**. Tracking $\text{AVU/\$}$ over time provides an unforgeable, physical record of monetary inflation free of bureaucratic revisions.

---

## The PoW Thermodynamic Derivation

Under competitive Proof-of-Work mining markets:

$$\text{Network Energy Cost} = \frac{\text{Spot Price } [\$] \times \text{Reward Rate } [\text{coins/sec}]}{\text{Hashrate } [\text{H/s}] \times \text{Electricity per Hash } [\text{kWh/H}]} = \mathbf{\left[\frac{\$}{\text{kWh}}\right]}$$

Inverting this cost gives the **AVU conversion multiplier**:

$$\text{Conversion Multiplier} = \frac{1}{\text{Network Energy Cost}} = \mathbf{\left[\frac{\text{kWh}}{\$}\right]} \equiv \mathbf{\left[\frac{\text{AVU}}{\$}\right]}$$

### Pricing Assets in AVU

For any asset with price $P_{\text{asset}}$:

$$\text{Asset AVU} = P_{\text{asset}} \left[\frac{\$}{\text{token}}\right] \times \text{Conversion Multiplier} \left[\frac{\text{AVU}}{\$}\right] = \mathbf{\left[\frac{\text{AVU}}{\text{token}}\right]}$$

The quotation currency ($\$$) completely cancels out.

---

## Empirical Benchmark & Multi-Chain Weights

Across the top mined networks, the empirical cost of electricity matches the real-world industrial grid:

* **Bitcoin (BTC)**: $\approx \$0.0840\text{ / kWh}$ ($11.90\text{ AVU / \$}$)
* **Bitcoin Cash (BCH)**: $\approx \$0.1150\text{ / kWh}$ ($8.70\text{ AVU / \$}$)
* **eCash (XEC)** *(Net to Miner)*: $\approx \$0.1413\text{ / kWh}$ ($7.08\text{ AVU / \$}$)
* **Merged Scrypt (LTC + DOGE)**: $\approx \$0.0394\text{ / kWh}$ ($25.38\text{ AVU / \$}$)
* **Kaspa (KAS)**: $\approx \$0.0595\text{ / kWh}$ ($16.81\text{ AVU / \$}$)

### Composite Benchmark
Frank uses a composite multi-chain Proof-of-Work energy benchmark:
$$\overline{\$/\text{kWh}} \approx \mathbf{\$0.084 / \text{kWh}} \implies \overline{\text{AVU} / \$} \approx \mathbf{11.90\text{ AVU / \$}}$$

This matches the **US Energy Information Administration (EIA) National Industrial Average** ($\$0.082/\text{kWh}$ or $12.2\text{ kWh/\$}$).

---

## How the app computes AVU values

AVU is a unit of account, not a coin or token: 1 AVU = 1 kWh. Two readings say how many kWh
a dollar is worth, and the app shows both.

**AVU_hash** is read off proof-of-work mining and needs no electricity price. For each entry
$c$ of a basket of mined coins at time $t$, the dollars one kWh of mining earns are

$$\$/\text{kWh}_c(t) = \text{price}_c(t)\left[\tfrac{\$}{\text{coin}}\right] \times \text{subsidy}_c(t)\left[\tfrac{\text{coins}}{\text{block}}\right] \div \text{hashes per block}_c(t) \times \text{efficiency}_c(t)\left[\tfrac{\text{hashes}}{\text{kWh}}\right]$$

and AVU_hash is the weighted average of the inverses, in kWh per dollar:

$$\text{AVU\_hash}(t) = \sum_c w_c(t) \times \left(\$/\text{kWh}_c(t)\right)^{-1}$$

The AVU value of any coin is $\text{price}(t) \times \text{AVU\_hash}(t)$: kWh per coin. That
is every "≈ N AVU" figure in the app.

Weights (`basketWeights`). Each entry's weight is its share of the basket's total market
capitalisation. If Bitcoin's share is above 60% it is set to 60% and the other 40% is divided
among the other entries in proportion to their market capitalisations. Weights sum to 1.
Bitcoin alone has weight 1.

The basket has five entries: BTC, BCH, XEC, merge-mined LTC+DOGE, and XMR. Merge-mined chains
are one entry: one hash earns on both, so their pay per hash is summed (each: price × block
reward ÷ (difficulty × 2³²)), the energy is counted once, and the entry's weight is the sum of
the two market capitalisations. Monero's expected hashes per block is its difficulty itself
(no 2³²). An entry whose inputs are not all known at $t$ is left out and the weights are taken
over the rest; the app shows how many entries were used and why each other one was not. With
none, there is no AVU_hash and no AVU value: nothing falls back to a fixed rate.

**AVU_spot** is the inverse of the mean wholesale day-ahead electricity price over the 30 days
ending at $t$. The prices are averaged first and the mean inverted; a window whose mean is not
positive has no AVU_spot.

### The oracle feed

The relay is the oracle. The app asks its relay for one normalised feed
(`docs/protocol/oracle/README.md`) and knows nothing about any provider. Every input above is
a series in that feed, read by one lookup: the latest point at or before a time, never
interpolated, never extended backwards (`packages/price-feeds/src/timeseries.ts`). Today's
figures and every point of a chart are the same functions (`avuHashAt`, `avuSpotAt` in
`packages/wallet/oracle/energy-basket.ts`) evaluated at different times.

The app shell holds the feed for the life of the app (`useAppOracleFeed`): the latest answer is
asked for every 10 minutes while the window is visible, appended to the local series in
LevelDB, and the AVU rate of every asset is computed from it once (`current` in
`app/src/stores/oracle.ts`). Everything on screen reads that. The Parity chart, while on
screen, asks for a range only for the stretches the local series lack.

Until relays serve the route (a 404), the app fills the same contract itself with
`packages/price-feeds/src/temporary-direct-feed.ts`: prices are the median of the public
providers that answer, chain statistics are Blockchair's `/stats` (hourly), and history is the
bundled files below. That file and what only it uses are to be deleted when the relay serves
the feed; the bundled files then become the relay's seed data.

| Series | Bundled history (`packages/price-feeds/src/historical`) | Built by |
| :--- | :--- | :--- |
| Bitcoin price, difficulty, subsidy, supply; SHA-256 efficiency (Cambridge CBECI fleet estimate) | `btc-mining-monthly.json`, monthly from 2010 | `scripts/build-btc-mining-history.py` |
| Litecoin, Dogecoin, Bitcoin Cash, eCash, Monero: price, difficulty, subsidy, supply | `mined-chains-monthly.json`, monthly | `scripts/build-mined-chains-history.py` |
| scrypt and RandomX efficiency (best hardware on sale, dated steps); eCash miner share (dated steps read from coinbases) | `curated-steps.json`, written by hand, every step cited | — |
| Wholesale electricity, daily, per region and aggregated | `wholesale-electricity-daily.json` | `scripts/build-wholesale-electricity.py` |
| Gold, yearly (World Bank) | `us-electricity-gold.json` | `scripts/build-historical.py` |

Each script's header names its source URLs and the exact command. Every file carries its
retrieval date.

The efficiency series are the inputs that are neither a chain reading nor a market price.
SHA-256 is Cambridge's model of the machines actually running (its best guess assumes miners
pay 0.05 USD/kWh when deciding which machines are still profitable). Scrypt and RandomX are
the most efficient machine on sale at each date: a frontier, which is more efficient than a
fleet, so those two entries' pay per kWh reads higher than a fleet estimate would give. The
RandomX steps before the first ASIC (September 2023) are desktop processors rated at their
package power limit and are marked as estimates.

Staleness. A price that has missed two refreshes, or an AVU_hash whose oldest market or chain
reading is over two hours old (including a bundled monthly value standing in where nothing
newer was received), is shown with its age. There are no stand-in prices: a coin the feed has
no price for has no AVU value. Test-network coins are valued at their main network's price
and marked "testnet". No dollar figure is shown anywhere in the app.

The tables in the sections above (per-network rates, the $0.084 "composite", the grid
comparison, the purchasing-power eras) are illustrations written with the original text. No
code reads them and their figures were not computed from sources.

---

## Protocol Architecture

1. **`@frank/price-feeds`**: the feed contract's types, parser and fetch (`feed.ts`), the
   timeseries lookup (`timeseries.ts`), and the temporary direct adapter.
2. **`@frank/wallet/oracle`**: pure TypeScript, no Vue/DOM. `avuHashAt`, `avuSpotAt`,
   `computeOracleRates` (every asset's AVU rate at a time), `convertRawToAvu`, `formatAvu`
   (compact, SI prefixes).
3. **`useOracleStore()` (`app/src/stores/oracle.ts`)**: the local series, the cached rates,
   and the one display helper `formatAvuAmount(asset, rawAmount)`: an AVU string or nothing.
