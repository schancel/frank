# Arbitrary Value Unit (AVU) Specification & PoW Thermodynamic Derivation

**Author**: Frank Protocol Team  
**Status**: Living Specification  
**Baseline Definition**: $1\text{ AVU} \equiv 1\text{ Kilowatt-Hour (kWh)} = 3.6\times 10^6\text{ Joules (MJ)}$

---

## 1. Executive Summary

The **Arbitrary Value Unit (AVU)** is Frank’s objective purchasing-power standard designed to eliminate fiat currency (e.g. USD) from core user interfaces, atomic swaps, and multi-chain wallet balances. 

Rather than anchoring to arbitrary central bank fiat or unbacked stablecoins, $1\text{ AVU}$ is physically grounded in thermodynamics:
$$1\text{ AVU} \equiv 1\text{ Kilowatt-Hour (kWh)} \equiv 3,600,000\text{ Joules}$$

By deriving the global cost of energy directly from decentralized **Proof-of-Work (PoW) mining networks**, the protocol computes the exact market exchange rate between currency and physical compute ($\text{Dollars/kWh}$). Inverting this rate establishes an on-chain conversion factor ($\text{AVU/\$}$) that translates any token's value into the physical energy it commands in the real world.

---

## 2. Why the AVU is Valuable

### 2.1 The "Oracle-less" Paradigm
Traditional financial applications and smart contracts rely on centralized or federated price oracles (Chainlink, Pyth, Bloomberg, central exchange orderbooks, or commodity brokers). These introduce:
* Relayer collusion and bridge exploit vectors.
* Jurisdictional regulatory choke points.
* Fragility during extreme volatility when oracle feeds stall or get manipulated.

In contrast, **Proof-of-Work thermodynamic consensus is inherently oracle-less**:
* **Hashrate, Difficulty, and Subsidy Schedules** are baked directly into consensus rules and verified independently by every full node on earth.
* The physical cost of mining cannot be faked or printed. It is governed by the laws of physics: electricity, transistor switching, and thermal dissipation.
* Millions of independent mining operators globally arbitrage electricity down to its marginal thermodynamic cost, transforming the global ASIC fleet into an unbribable, decentralized sensor of the real-world value of energy.

### 2.2 Energy: At the Base of Every Single Supply Chain
Why choose energy ($1\text{ kWh}$) rather than a basket of manufactured goods or consumer items?

**Thermodynamically, every physical good and human service is organized energy:**
* **Food**: Nitrogen fertilizer synthesized from natural gas (Haber-Bosch) + diesel-powered tractors + solar photons + refrigerated transport.
* **Semiconductors**: Silicon melted at $1,400^\circ\text{C}$ + extreme ultraviolet (EUV) lasers consuming hundreds of kilowatts per lithography machine.
* **Fresh Water**: Energy required for reverse-osmosis desalination, pumping, and wastewater treatment.
* **Shelter & Infrastructure**: Calcination of limestone into cement ($1,450^\circ\text{C}$) + blast furnace steel reduction + logistical transport.
* **Compute & AI**: Terawatt-hours consumed by tensor processing units, cooling chillers, and data infrastructure.

Energy is the fundamental invariant cost input of the global economy. If an asset is priced in **AVU ($1\text{ kWh}$)**, its purchasing power is measured against the root denominator of physical reality.

### 2.3 Refusing the USD Meme: Weakening Central Bank Hegemony in Wallet UI
Money is fundamentally the most pervasive coordination meme in human society. For nearly a century, software interfaces, spreadsheet programs, and banking applications have unquestioningly defaulted to the US Dollar as the universal unit of account. This ubiquitous visual conditioning creates a powerful psychological illusion: the belief that the Dollar is a stable, objective baseline, while the real world "fluctuates."

In reality, the Federal Reserve can dilute the dollar supply at will with arbitrary keystrokes, yet software continues to render that diluted denominator as the immutable ground truth.

**Frank explicitly rejects the USD meme.** By deliberately stripping fiat currency display from the wallet interface and replacing it with physical kilowatt-hours (AVU):
1. **It breaks the psychological monopoly of the Fed**: Users are no longer conditioned to evaluate their life energy and savings in units decreed by central planners.
2. **It deflates the currency meme**: A meme only retains power as long as participants repeat and display it. Denying fiat real estate in self-custodial software directly weakens its social network effect.
3. **It aligns perception with thermodynamics**: The user's wealth is presented in terms of invariant physical work ($3.6 \times 10^6 \text{ Joules}$), where no committee or algorithm can print more energy out of thin air.

---

## 3. Bypassing the CPI & Exposing the True Debasement of USD

### 3.1 The Structural Flaws of the Consumer Price Index (CPI)
For decades, official government inflation metrics—predominantly the Consumer Price Index (CPI)—have been used as the standard measure of purchasing power. However, CPI suffers from severe structural and political distortions:

1. **Substitution Bias**:
   When beef or olive oil doubles in price, CPI algorithms assume consumers substitute down to cheaper alternatives (e.g. chicken or canola oil), artificially muting the reported price rise.
2. **Hedonic Adjustments**:
   Bureaucrats mathematically deduct "quality improvements" from price increases. If a new vehicle costs $\$10,000$ more but features improved collision sensors or a larger touchscreen, the CPI claims its effective price did not increase or even "fell," regardless of the consumer's cash outlay.
3. **Geometric Weighting Tweaks**:
   Formulaic changes systematically depress official inflation prints, reducing government obligations on inflation-linked bonds (TIPS) and social entitlements.
4. **Exclusion of Capital Goods & Assets**:
   CPI strictly tracks consumer consumption, omitting real estate, farmland, capital equipment, and equity ownership—the exact assets where monetary inflation primarily concentrates.

### 3.2 Revealing the Real Worth of the Dollar Over Time
Because the face value of a fiat bill never changes (a \$100 bill remains stamped "\$100"), the decay of the dollar is obscured. The public perceives prices as "mysteriously rising," when in fact **the currency measuring stick is shrinking**.

By anchoring to **$1\text{ AVU} \equiv 1\text{ kWh}$**, the true purchasing power of the US Dollar is revealed across decadal horizons:

| Era | US Industrial Power Cost | **kWh of Energy Purchased per \$1.00** | Dollar Purchasing Power in AVU |
| :--- | :--- | :--- | :--- |
| **1930s** | $\approx \$0.007 / \text{kWh}$ | **$142.8\text{ kWh / \$}$** | **$142.8\text{ AVU / \$}$** |
| **1970** | $\approx \$0.010 / \text{kWh}$ | **$100.0\text{ kWh / \$}$** | **$100.0\text{ AVU / \$}$** |
| **2000** | $\approx \$0.045 / \text{kWh}$ | **$22.2\text{ kWh / \$}$** | **$22.2\text{ AVU / \$}$** |
| **2026 (Present)** | $\approx \$0.084 / \text{kWh}$ | **$11.9\text{ kWh / \$}$** | **$11.9\text{ AVU / \$}$** |

Over the past century, the US Dollar has lost **$> 91\%$ of its energy purchasing power**. 

Tracking $\text{AVU/\$}$ over time cuts through bureaucratic CPI revisions, providing an unforgeable, physical record of monetary inflation.

---

## 4. Mathematical Derivation of the PoW Thermodynamic Standard

### 4.1 The Core Formula

Under competitive Proof-of-Work mining equilibrium:

$$\text{Network Energy Cost} = \frac{\text{Spot Price } [\$] \times \text{Reward Rate } [\text{coins/sec}]}{\text{Hashrate } [\text{hashes/sec}] \times \text{Electricity per Hash } [\text{kWh/hash}]}$$

#### Dimensional Analysis:
1. **Numerator**: $[\frac{\$}{\text{coin}}] \times [\frac{\text{coins}}{\text{sec}}] = \mathbf{\frac{\$}{\text{sec}}}$ *(Network Gross Revenue Rate)*
2. **Denominator**: $[\frac{\text{hashes}}{\text{sec}}] \times [\frac{\text{Joules}}{\text{hash}}] = \mathbf{\frac{\text{Joules}}{\text{sec}}} = \mathbf{\text{Watts}}$ *(Physical Power Consumption)*
3. **The Ratio**:
$$\frac{\$ / \text{sec}}{\text{Joules} / \text{sec}} = \mathbf{\frac{\$}{\text{Joule}}} \quad \xrightarrow{\times 3.6 \times 10^6} \quad \mathbf{\frac{\$}{\text{kWh}}}$$

### 4.2 Inverting to Obtain AVU per Currency Unit

Because $1\text{ AVU} \equiv 1\text{ kWh}$, inverting the network energy cost yields the **AVU conversion multiplier**:

$$\text{Conversion Multiplier} = \frac{1}{\text{Network Energy Cost}} = \left[\frac{\text{kWh}}{\$}\right] \equiv \mathbf{\left[\frac{\text{AVU}}{\$}\right]}$$

### 4.3 Pricing Any Asset in AVU

For any asset or token with nominal spot price $P_{\text{asset}}$ (quoted in USD):

$$\text{Asset Value (AVU)} = P_{\text{asset}} \left[\frac{\$}{\text{token}}\right] \times \text{Conversion Multiplier} \left[\frac{\text{AVU}}{\$}\right] = \mathbf{\left[\frac{\text{AVU}}{\text{token}}\right] \equiv \left[\frac{\text{kWh}}{\text{token}}\right]}$$

The quotation currency cancels out:
$$\frac{\cancel{\$}}{\text{token}} \times \frac{\text{AVU}}{\cancel{\$}} = \mathbf{\frac{\text{AVU}}{\text{token}}}$$

USD disappears from protocol frames, wallet balances, and atomic swap parity checks.

---

## 5. Empirical Evidence Across Mined Networks

Hashing algorithms are architecturally diverse. Measuring energy requires using the empirical hardware efficiency ($\text{Joules/hash}$) of each algorithm's active mining fleet:

* **SHA-256** (Bitcoin, Bitcoin Cash, eCash): Pure 32-bit ALU logic on 3nm/5nm custom ASICs ($\approx 17.5\text{ J/TH} = 1.75 \times 10^{-11}\text{ J/hash}$).
* **Scrypt** (Litecoin, Dogecoin): SRAM-hard memory scratchpad ($\approx 0.59\text{ J/MH} = 5.9 \times 10^{-7}\text{ J/hash}$).
* **kHeavyHash** (Kaspa): 2D matrix multiplication ASIC ($\approx 140\text{ J/TH} = 1.40 \times 10^{-10}\text{ J/hash}$).
* **RandomX** (Monero): Turing-complete VM with 2MB L3 CPU cache ($\approx 0.010\text{ J/hash}$).

### Multi-Chain PoW Energy Yield Table

| Network | Mining Algo | Network Hashrate | Hardware Efficiency | Power Draw | Revenue Rate | Derived Rate (\$/kWh) | Inverted Rate (AVU/\$) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Bitcoin (BTC)** | SHA-256 | 1.063 ZH/s | 17.5 J/TH | 18,602 MW | \$434.24 / s | **\$0.0840 / kWh** | **11.90 AVU / \$** |
| **Bitcoin Cash (BCH)** | SHA-256 | 2.802 EH/s | 17.5 J/TH | 49.0 MW | \$1.57 / s | **\$0.1150 / kWh** | **8.70 AVU / \$** |
| **eCash (XEC)** *(Net to Miner)* | SHA-256 | 38.94 PH/s | 17.5 J/TH | 0.68 MW | \$0.027 / s | **\$0.1413 / kWh** | **7.08 AVU / \$** |
| **Merged Scrypt (LTC + DOGE)** | Scrypt | 2.71 PH/s | 0.59 J/MH | 1,599 MW | \$17.52 / s | **\$0.0394 / kWh** | **25.38 AVU / \$** |
| **Kaspa (KAS)** | kHeavyHash | 356.2 PH/s | 140 J/TH | 49.9 MW | \$0.82 / s | **\$0.0595 / kWh** | **16.81 AVU / \$** |
| **Monero (XMR)** | RandomX | 6.64 GH/s | 10.0 mJ/H | 66.4 MW | \$2.77 / s | **\$0.1501 / kWh** | **6.66 AVU / \$** |

---

## 6. Real-World Grid Validation

The derived Proof-of-Work energy baseline ($\approx \mathbf{\$0.084 / \text{kWh}}$ or $\mathbf{11.90\text{ AVU / \$}}$) corresponds directly with real-world electrical grids:

| Sector / Region | Real-World Grid Cost (\$/kWh) | Real-World kWh per \$1.00 | Aligned Mining Network |
| :--- | :--- | :--- | :--- |
| **US National Industrial Average (EIA)** | **\$0.082 / kWh** | **12.2 kWh / \$** | **Matches Bitcoin & Frank PoW Composite** |
| **Global Industrial Average (IEA)** | **\$0.080–\$0.090 / kWh** | **11.1–12.5 kWh / \$** | **Matches Bitcoin & Frank PoW Composite** |
| **Paraguay (Itaipu Hydroelectric)** | \$0.035 / kWh | 28.6 kWh / \$ | Merged Scrypt Breakeven Floor |
| **Texas (ERCOT Wholesale Curtailment)**| \$0.040 / kWh | 25.0 kWh / \$ | Low-Cost Industrial ASIC Floor |
| **US Commercial Grid (Small Business)** | \$0.125 / kWh | 8.0 kWh / \$ | Matches Bitcoin Cash |
| **US National Residential Average** | \$0.160 / kWh | 6.3 kWh / \$ | Matches Monero (Consumer CPU Mining) |

---

## 7. Architecture & Implementation

### 7.1 Package Layout
The oracle resides in `@frank/wallet/oracle` with zero UI dependencies:
* `energy-basket.ts`: the basket of mined coins, the per-coin formula (`miningDollarsPerKwh`), the weights (`basketWeights`), `computeAvuHash`, and AVU_spot (`latestAvuSpot`).
* `price-oracle.ts`: the fetch of prices and chain statistics (`fetchOracleSnapshot`), `rateOracleSnapshot`, integer conversion (`convertRawToAvu`), formatting (`formatAvu`), and atomic swap parity.
* `index.ts`: Public module exports.

### 7.2 How the app computes AVU values

AVU is a unit of account, not a coin or token: 1 AVU = 1 kWh. Two readings say how many kWh
a dollar is worth, and the app shows both.

**AVU_hash** is read off proof-of-work mining and needs no electricity price. For each entry
$c$ of a basket of mined coins at time $t$, the dollars one kWh of mining earns are

$$\$/\text{kWh}_c(t) = \text{price}_c(t)\left[\tfrac{\$}{\text{coin}}\right] \times \text{subsidy}_c(t)\left[\tfrac{\text{coins}}{\text{block}}\right] \div \text{hashes per block}_c(t) \times \text{efficiency}_c(t)\left[\tfrac{\text{hashes}}{\text{kWh}}\right]$$

and AVU_hash is the weighted average of the inverses, in kWh per dollar:

$$\text{AVU\_hash}(t) = \sum_c w_c(t) \times \left(\$/\text{kWh}_c(t)\right)^{-1}$$

The AVU value of any coin is $\text{price}(t) \times \text{AVU\_hash}(t)$: kWh per coin. That
is every "≈ N AVU" figure in the app.

**AVU_spot** is kWh per dollar from a published electricity price: $1 \div (\$/\text{kWh})$.
It depends on whoever publishes that price; AVU_hash does not. The two should roughly agree,
because miners buy electricity. The Parity tab shows both and the gap between them.

Weights (`basketWeights`). Each entry's weight is its share of the basket's total market
capitalisation. If Bitcoin's share is above 60% it is set to 60% and the other 40% is divided
among the other entries in proportion to their market capitalisations. Weights sum to 1.
Bitcoin alone has weight 1.

The basket (`AVU_HASH_BASKET`) has five entries: BTC, BCH, XEC, merge-mined LTC+DOGE, and
XMR. Merge-mined chains are one entry: one hash earns on both, so their pay per hash is
summed and the energy is counted once. An entry whose inputs are not all known is left out
and the weights are taken over the rest; the app shows how many entries were used and why
each other one was not. With none, there is no AVU_hash and no AVU value: nothing falls back
to a fixed rate.

Where each input comes from:

| Input | Source | Kind |
| :--- | :--- | :--- |
| Coin price | `PriceFeedsClient` in `packages/price-feeds`: the median of the providers that answered (Chainlink, Pyth, Coinbase, Kraken, CoinGecko, Binance). The number of providers is kept in `priceSources`. | fetched, every 5 minutes |
| Coins per block | Blockchair `/stats`: `inflation_24h ÷ blocks_24h`, the subsidy the chain actually minted, so halvings need no schedule. For eCash the miner's 58% is used (consensus sends 32% to the miner fund and 10% to staking rewards). Monero publishes no issuance there; its consensus tail emission of 0.6 XMR is configured in `MINED_CHAINS`. | fetched, every 30 minutes, one source |
| Hashes per block | Blockchair `/stats` `difficulty` × 2³² (Monero: the difficulty itself). | fetched, every 30 minutes, one source |
| Market capitalisation | Blockchair `/stats` `circulation` × the oracle's price. | fetched |
| Hashing efficiency (hashes per kWh) | SHA-256: Cambridge Bitcoin Electricity Consumption Index, best-guess network power demand ÷ network hashrate, by month, bundled in `packages/price-feeds/src/historical/btc-mining-monthly.json`. The latest bundled month is used for the present. | **curated estimate, bundled** |
| Electricity price (AVU_spot) | US EIA Table 9.8, industrial, bundled in `us-electricity-gold.json`; the latest published month. | bundled |

The efficiency series is the one input that is neither a chain reading nor a market price.
It is Cambridge's model of which machines are running, and its best guess assumes miners pay
0.05 USD/kWh when deciding which machines are still profitable; the bundle also carries the
lower and upper bounds. No efficiency series is bundled for scrypt (LTC+DOGE) or RandomX
(XMR), so those two entries are left out today and AVU_hash is computed over BTC, BCH and XEC.

History. `scripts/build-btc-mining-history.py` builds the monthly Bitcoin inputs (price,
difficulty, subsidy, efficiency) from blockchain.com's charts API and the Cambridge download,
from October 2010; `BTC_MONTHLY_AVU_HASH` applies the same formula to them. It is Bitcoin's
term alone, not the basket. Short-range price lines (24h to 1y) are each price times today's
AVU_hash, and the chart says so. `scripts/build-historical.py` builds the EIA and World Bank
figures. Both files carry their source URLs and retrieval date.

Staleness. A coin's price that has missed several refreshes (15 minutes) or chain statistics
older than two hours make AVU_hash stale; every value computed with it then shows the age of
the oldest input. There are no stand-in prices: a coin whose price was not fetched has no AVU
value, and a coin no provider prices (the Tempo test dollar) never has one. MON is priced as
mainnet MON; a testnet MON balance is not valued.

The tables in the sections above (per-network rates, the $0.084 "composite", the grid
comparison, the purchasing-power eras) are illustrations written with the original text. No
code reads them and their figures were not computed from sources.

---

## 8. Atomic Swap Parity

When two parties negotiate a cross-chain atomic swap (e.g. trading Monad for eCash), the oracle evaluates fairness in pure thermodynamic energy:

$$\text{Swap Parity} = \frac{\text{Energy Received (AVU)}}{\text{Energy Offered (AVU)}}$$

* $\text{Parity} \approx 1.0\pm 0.05$: **Fair Exchange** (both sides exchange equivalent physical work).
* $\text{Parity} > 1.05$: **Premium** (receiver obtains surplus energy value).
* $\text{Parity} < 0.95$: **Discount**.
* $\text{Parity} < 0.80$: **Warning** (severe cross-chain value disparity).
