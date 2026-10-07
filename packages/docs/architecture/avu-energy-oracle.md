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

## Genesis Baseline Reference Rates

| Asset | Decimals | Genesis Spot Price | Genesis AVU Rate | Physical Meaning |
| :--- | :--- | :--- | :--- | :--- |
| **Monad (`monad`)** | 18 | \$3.50 | **`41.67 AVU`** | 1 MON $\approx$ 41.7 kWh |
| **Tempo USD (`tempo`)**| 6 | \$1.00 | **`11.90 AVU`** | \$1 $\approx$ 11.9 kWh |
| **eCash (`ecash`)** | 2 | \$0.000035 | **`0.000417 AVU`** | 100k XEC $\approx$ 41.7 kWh |
| **Solana (`solana`)** | 9 | \$150.00 | **`1,785.71 AVU`** | 1 SOL $\approx$ 1,786 kWh |
| **Ethereum (`ethereum`)** | 18 | \$2,600.00 | **`30,952.38 AVU`** | 1 ETH $\approx$ 30,952 kWh |
| **Hyperliquid (`hyperliquid`)** | 18 | \$40.00 | **`476.19 AVU`** | 1 HYPE $\approx$ 476.2 kWh |

---

## Protocol Architecture

1. **`@frank/wallet/oracle`**:
   * Pure TypeScript SDK with zero Vue/DOM dependencies.
   * `convertRawToAvu(rawAmount, asset)`: Converts integer atomic units (wei, satoshis, lamports) to AVU.
   * `formatAvu(avu)`: Formats amounts with clean rounding and thousands separators.
   * `calculateSwapParity(sendRaw, sendAsset, receiveRaw, receiveAsset)`: Checks fairness of cross-chain atomic swaps.
2. **`useOracleStore()` (`app/src/stores/oracle.ts`)**:
   * Reactive Pinia store with 0ms synchronous reads.
   * Background polling worker for external oracle feeds.
   * 7-day rolling historical cache stored in `localStorage` (capped at 168 points) for zero-cost historical tracking.
