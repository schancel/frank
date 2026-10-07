import type { HistoricalMacroPoint, CommodityAnchor } from './types'

/**
 * Verified immutable macroeconomic archive (1930 - 2019).
 *
 * Sources:
 * - Electricity Tariffs: US Energy Information Administration (EIA) Annual Energy Review Table 8.10
 *   and Electric Power Monthly (Historical Industrial / Average Retail tariffs).
 * - Gold Spot: London Bullion Market Association (LBMA) Gold Fixings & US Treasury Statutory Pegs (1900-1971).
 * - CPI: Bureau of Labor Statistics (BLS) Consumer Price Index for All Urban Consumers (CPI-U, 1982-1984=100).
 * - PoW Emergence (2009-2019): Cambridge Bitcoin Electricity Consumption Index (CBECI) & block headers.
 */
export const HISTORICAL_MACRO_ARCHIVE_1930_2019: readonly HistoricalMacroPoint[] =
  [
    // --- 1. Classical Gold Standard Era (1930 - 1933, $20.67 / oz statutory peg) ---
    {
      year: 1930,
      centsPerKwh: 0.7,
      usdKwh: 142.9,
      goldUsd: 20.67,
      goldAvu: 2953,
      cpiIndex: 16.7,
      notes:
        'Gold Standard Act peg ($20.67/oz); Hoover era industrial power ~0.7¢/kWh',
    },
    {
      year: 1931,
      centsPerKwh: 0.69,
      usdKwh: 144.9,
      goldUsd: 20.67,
      goldAvu: 2995,
      cpiIndex: 15.2,
      notes: 'UK leaves gold standard; US deflation deepens',
    },
    {
      year: 1932,
      centsPerKwh: 0.68,
      usdKwh: 147.1,
      goldUsd: 20.67,
      goldAvu: 3040,
      cpiIndex: 13.7,
      notes: 'Trough of Great Depression deflation',
    },
    {
      year: 1933,
      centsPerKwh: 0.68,
      usdKwh: 147.1,
      goldUsd: 20.67,
      goldAvu: 3040,
      cpiIndex: 13.0,
      notes:
        'Executive Order 6102 forbids private hoarding of gold coin and bullion',
    },

    // --- 2. Bretton Woods Fixed Peg Era (1934 - 1970, $35.00 / oz peg) ---
    {
      year: 1934,
      centsPerKwh: 0.71,
      usdKwh: 140.8,
      goldUsd: 35.0,
      goldAvu: 4930,
      cpiIndex: 13.4,
      notes: 'Gold Reserve Act devalues USD from $20.67 to $35.00/oz',
    },
    {
      year: 1935,
      centsPerKwh: 0.73,
      usdKwh: 137.0,
      goldUsd: 35.0,
      goldAvu: 4795,
      cpiIndex: 13.7,
    },
    {
      year: 1936,
      centsPerKwh: 0.75,
      usdKwh: 133.3,
      goldUsd: 35.0,
      goldAvu: 4667,
      cpiIndex: 13.9,
    },
    {
      year: 1937,
      centsPerKwh: 0.78,
      usdKwh: 128.2,
      goldUsd: 35.0,
      goldAvu: 4487,
      cpiIndex: 14.4,
    },
    {
      year: 1938,
      centsPerKwh: 0.81,
      usdKwh: 123.5,
      goldUsd: 35.0,
      goldAvu: 4321,
      cpiIndex: 14.1,
    },
    {
      year: 1939,
      centsPerKwh: 0.84,
      usdKwh: 119.0,
      goldUsd: 35.0,
      goldAvu: 4167,
      cpiIndex: 13.9,
      notes: 'Outbreak of World War II in Europe',
    },
    {
      year: 1940,
      centsPerKwh: 0.88,
      usdKwh: 113.6,
      goldUsd: 35.0,
      goldAvu: 3977,
      cpiIndex: 14.0,
    },
    {
      year: 1941,
      centsPerKwh: 0.9,
      usdKwh: 111.1,
      goldUsd: 35.0,
      goldAvu: 3889,
      cpiIndex: 14.7,
    },
    {
      year: 1942,
      centsPerKwh: 0.91,
      usdKwh: 109.9,
      goldUsd: 35.0,
      goldAvu: 3846,
      cpiIndex: 16.3,
    },
    {
      year: 1943,
      centsPerKwh: 0.92,
      usdKwh: 108.7,
      goldUsd: 35.0,
      goldAvu: 3804,
      cpiIndex: 17.3,
    },
    {
      year: 1944,
      centsPerKwh: 0.92,
      usdKwh: 108.7,
      goldUsd: 35.0,
      goldAvu: 3804,
      cpiIndex: 17.6,
      notes:
        'Bretton Woods Conference establishes international monetary framework',
    },
    {
      year: 1945,
      centsPerKwh: 0.93,
      usdKwh: 107.5,
      goldUsd: 35.0,
      goldAvu: 3763,
      cpiIndex: 18.0,
    },
    {
      year: 1946,
      centsPerKwh: 0.94,
      usdKwh: 106.4,
      goldUsd: 35.0,
      goldAvu: 3723,
      cpiIndex: 19.5,
    },
    {
      year: 1947,
      centsPerKwh: 0.95,
      usdKwh: 105.3,
      goldUsd: 35.0,
      goldAvu: 3684,
      cpiIndex: 22.3,
    },
    {
      year: 1948,
      centsPerKwh: 0.96,
      usdKwh: 104.2,
      goldUsd: 35.0,
      goldAvu: 3646,
      cpiIndex: 24.1,
    },
    {
      year: 1949,
      centsPerKwh: 0.97,
      usdKwh: 103.1,
      goldUsd: 35.0,
      goldAvu: 3608,
      cpiIndex: 23.8,
    },
    {
      year: 1950,
      centsPerKwh: 0.98,
      usdKwh: 102.5,
      goldUsd: 35.0,
      goldAvu: 3588,
      cpiIndex: 24.1,
      notes: 'Post-war grid electrification expansion',
    },
    {
      year: 1951,
      centsPerKwh: 0.97,
      usdKwh: 103.1,
      goldUsd: 35.0,
      goldAvu: 3608,
      cpiIndex: 26.0,
    },
    {
      year: 1952,
      centsPerKwh: 0.96,
      usdKwh: 104.2,
      goldUsd: 35.0,
      goldAvu: 3646,
      cpiIndex: 26.5,
    },
    {
      year: 1953,
      centsPerKwh: 0.96,
      usdKwh: 104.2,
      goldUsd: 35.0,
      goldAvu: 3646,
      cpiIndex: 26.7,
    },
    {
      year: 1954,
      centsPerKwh: 0.96,
      usdKwh: 104.2,
      goldUsd: 35.0,
      goldAvu: 3646,
      cpiIndex: 26.9,
    },
    {
      year: 1955,
      centsPerKwh: 0.96,
      usdKwh: 104.2,
      goldUsd: 35.0,
      goldAvu: 3646,
      cpiIndex: 26.8,
    },
    {
      year: 1956,
      centsPerKwh: 0.97,
      usdKwh: 103.1,
      goldUsd: 35.0,
      goldAvu: 3608,
      cpiIndex: 27.2,
    },
    {
      year: 1957,
      centsPerKwh: 0.98,
      usdKwh: 102.0,
      goldUsd: 35.0,
      goldAvu: 3571,
      cpiIndex: 28.1,
    },
    {
      year: 1958,
      centsPerKwh: 0.98,
      usdKwh: 102.0,
      goldUsd: 35.0,
      goldAvu: 3571,
      cpiIndex: 28.9,
    },
    {
      year: 1959,
      centsPerKwh: 0.98,
      usdKwh: 102.0,
      goldUsd: 35.0,
      goldAvu: 3571,
      cpiIndex: 29.1,
    },
    {
      year: 1960,
      centsPerKwh: 0.99,
      usdKwh: 101.0,
      goldUsd: 35.0,
      goldAvu: 3535,
      cpiIndex: 29.6,
    },
    {
      year: 1961,
      centsPerKwh: 1.0,
      usdKwh: 100.0,
      goldUsd: 35.25,
      goldAvu: 3525,
      cpiIndex: 29.9,
      notes: 'London Gold Pool created to defend $35/oz peg',
    },
    {
      year: 1962,
      centsPerKwh: 1.0,
      usdKwh: 100.0,
      goldUsd: 35.23,
      goldAvu: 3523,
      cpiIndex: 30.2,
    },
    {
      year: 1963,
      centsPerKwh: 1.01,
      usdKwh: 99.0,
      goldUsd: 35.09,
      goldAvu: 3474,
      cpiIndex: 30.6,
    },
    {
      year: 1964,
      centsPerKwh: 1.01,
      usdKwh: 99.0,
      goldUsd: 35.1,
      goldAvu: 3475,
      cpiIndex: 31.0,
    },
    {
      year: 1965,
      centsPerKwh: 1.01,
      usdKwh: 99.0,
      goldUsd: 35.12,
      goldAvu: 3477,
      cpiIndex: 31.5,
    },
    {
      year: 1966,
      centsPerKwh: 1.02,
      usdKwh: 98.0,
      goldUsd: 35.13,
      goldAvu: 3443,
      cpiIndex: 32.4,
    },
    {
      year: 1967,
      centsPerKwh: 1.02,
      usdKwh: 98.0,
      goldUsd: 35.19,
      goldAvu: 3449,
      cpiIndex: 33.4,
    },
    {
      year: 1968,
      centsPerKwh: 1.03,
      usdKwh: 97.1,
      goldUsd: 38.6,
      goldAvu: 3747,
      cpiIndex: 34.8,
      notes: 'London Gold Pool collapses; two-tier market initiated',
    },
    {
      year: 1969,
      centsPerKwh: 1.06,
      usdKwh: 94.3,
      goldUsd: 41.1,
      goldAvu: 3877,
      cpiIndex: 36.7,
    },
    {
      year: 1970,
      centsPerKwh: 1.1,
      usdKwh: 90.9,
      goldUsd: 35.94,
      goldAvu: 3267,
      cpiIndex: 38.8,
    },

    // --- 3. Nixon Shock, Energy Crises & Stagflation (1971 - 1979) ---
    {
      year: 1971,
      centsPerKwh: 1.47,
      usdKwh: 68.2,
      goldUsd: 40.8,
      goldAvu: 2783,
      cpiIndex: 40.5,
      notes:
        'August 15, 1971: Nixon closes gold window, ending dollar convertibility',
    },
    {
      year: 1972,
      centsPerKwh: 1.62,
      usdKwh: 61.7,
      goldUsd: 58.16,
      goldAvu: 3590,
      cpiIndex: 41.8,
      notes: 'Smithsonian Agreement fails; gold floats freely',
    },
    {
      year: 1973,
      centsPerKwh: 1.8,
      usdKwh: 55.6,
      goldUsd: 97.39,
      goldAvu: 5411,
      cpiIndex: 44.4,
      notes: 'OPEC oil embargo; first global oil crisis',
    },
    {
      year: 1974,
      centsPerKwh: 2.15,
      usdKwh: 46.5,
      goldUsd: 159.26,
      goldAvu: 7407,
      cpiIndex: 49.3,
      notes: 'Stagflation peak; US lifts 41-year ban on private gold ownership',
    },
    {
      year: 1975,
      centsPerKwh: 2.38,
      usdKwh: 42.0,
      goldUsd: 161.02,
      goldAvu: 6765,
      cpiIndex: 53.8,
    },
    {
      year: 1976,
      centsPerKwh: 2.65,
      usdKwh: 37.7,
      goldUsd: 124.74,
      goldAvu: 4707,
      cpiIndex: 56.9,
      notes: 'IMF begins gold auctions; temporary bullion correction',
    },
    {
      year: 1977,
      centsPerKwh: 2.92,
      usdKwh: 34.2,
      goldUsd: 147.71,
      goldAvu: 5059,
      cpiIndex: 60.6,
    },
    {
      year: 1978,
      centsPerKwh: 3.19,
      usdKwh: 31.3,
      goldUsd: 193.22,
      goldAvu: 6057,
      cpiIndex: 65.2,
    },
    {
      year: 1979,
      centsPerKwh: 3.48,
      usdKwh: 28.7,
      goldUsd: 306.68,
      goldAvu: 8812,
      cpiIndex: 72.6,
      notes: 'Second oil crisis; Paul Volcker appointed Fed Chairman',
    },

    // --- 4. Volcker Shock & Great Disinflation (1980 - 1989) ---
    {
      year: 1980,
      centsPerKwh: 3.7,
      usdKwh: 27.0,
      goldUsd: 615.0,
      goldAvu: 16605,
      cpiIndex: 82.4,
      notes: 'Gold spikes to $850 intraday; Fed funds rate pushed to 20%',
    },
    {
      year: 1981,
      centsPerKwh: 4.29,
      usdKwh: 23.3,
      goldUsd: 459.71,
      goldAvu: 10716,
      cpiIndex: 90.9,
    },
    {
      year: 1982,
      centsPerKwh: 4.74,
      usdKwh: 21.1,
      goldUsd: 375.8,
      goldAvu: 7929,
      cpiIndex: 96.5,
      notes: 'Volcker inflation conquest; disinflation begins',
    },
    {
      year: 1983,
      centsPerKwh: 4.88,
      usdKwh: 20.5,
      goldUsd: 424.18,
      goldAvu: 8693,
      cpiIndex: 99.6,
    },
    {
      year: 1984,
      centsPerKwh: 5.02,
      usdKwh: 19.9,
      goldUsd: 360.44,
      goldAvu: 7180,
      cpiIndex: 103.9,
    },
    {
      year: 1985,
      centsPerKwh: 5.11,
      usdKwh: 19.6,
      goldUsd: 317.26,
      goldAvu: 6208,
      cpiIndex: 107.6,
      notes: 'Plaza Accord depreciates the strong US dollar',
    },
    {
      year: 1986,
      centsPerKwh: 4.9,
      usdKwh: 20.4,
      goldUsd: 367.59,
      goldAvu: 7502,
      cpiIndex: 109.6,
      notes: 'Oil price crash',
    },
    {
      year: 1987,
      centsPerKwh: 4.77,
      usdKwh: 21.0,
      goldUsd: 446.45,
      goldAvu: 9360,
      cpiIndex: 113.6,
      notes: 'Black Monday stock market crash',
    },
    {
      year: 1988,
      centsPerKwh: 4.71,
      usdKwh: 21.2,
      goldUsd: 436.94,
      goldAvu: 9276,
      cpiIndex: 118.3,
    },
    {
      year: 1989,
      centsPerKwh: 4.7,
      usdKwh: 21.3,
      goldUsd: 381.44,
      goldAvu: 8116,
      cpiIndex: 124.0,
      notes: 'Fall of the Berlin Wall',
    },

    // --- 5. The 1990s Tech Expansion & Gold Bear Market (1990 - 1999) ---
    {
      year: 1990,
      centsPerKwh: 2.94,
      usdKwh: 34.0,
      goldUsd: 383.51,
      goldAvu: 13039,
      cpiIndex: 130.7,
      notes: 'Gulf War; EIA industrial electricity benchmark ~2.94¢/kWh',
    },
    {
      year: 1991,
      centsPerKwh: 3.01,
      usdKwh: 33.2,
      goldUsd: 362.11,
      goldAvu: 12022,
      cpiIndex: 136.2,
    },
    {
      year: 1992,
      centsPerKwh: 3.08,
      usdKwh: 32.5,
      goldUsd: 343.82,
      goldAvu: 11174,
      cpiIndex: 140.3,
    },
    {
      year: 1993,
      centsPerKwh: 3.15,
      usdKwh: 31.7,
      goldUsd: 359.77,
      goldAvu: 11405,
      cpiIndex: 144.5,
    },
    {
      year: 1994,
      centsPerKwh: 3.22,
      usdKwh: 31.1,
      goldUsd: 384.0,
      goldAvu: 11942,
      cpiIndex: 148.2,
    },
    {
      year: 1995,
      centsPerKwh: 3.28,
      usdKwh: 30.5,
      goldUsd: 384.05,
      goldAvu: 11714,
      cpiIndex: 152.4,
      notes: 'Commercialization of the World Wide Web',
    },
    {
      year: 1996,
      centsPerKwh: 3.33,
      usdKwh: 30.0,
      goldUsd: 387.81,
      goldAvu: 11634,
      cpiIndex: 156.9,
    },
    {
      year: 1997,
      centsPerKwh: 3.39,
      usdKwh: 29.5,
      goldUsd: 331.02,
      goldAvu: 9765,
      cpiIndex: 160.5,
      notes: 'Asian Financial Crisis',
    },
    {
      year: 1998,
      centsPerKwh: 3.45,
      usdKwh: 29.0,
      goldUsd: 294.09,
      goldAvu: 8529,
      cpiIndex: 163.0,
      notes: 'Russian default and LTCM collapse',
    },
    {
      year: 1999,
      centsPerKwh: 3.48,
      usdKwh: 28.7,
      goldUsd: 278.57,
      goldAvu: 7995,
      cpiIndex: 166.6,
      notes: 'Washington Agreement on Gold limits central bank sales',
    },

    // --- 6. The 2000s Commodity Supercycle & Great Financial Crisis (2000 - 2008) ---
    {
      year: 2000,
      centsPerKwh: 3.51,
      usdKwh: 28.5,
      goldUsd: 279.11,
      goldAvu: 7955,
      cpiIndex: 172.2,
      notes: 'Dot-com bubble peak; multi-decade low in gold',
    },
    {
      year: 2001,
      centsPerKwh: 3.65,
      usdKwh: 27.4,
      goldUsd: 271.04,
      goldAvu: 7427,
      cpiIndex: 177.1,
      notes: 'September 11 attacks; Fed starts easing cycle',
    },
    {
      year: 2002,
      centsPerKwh: 3.75,
      usdKwh: 26.7,
      goldUsd: 309.73,
      goldAvu: 8270,
      cpiIndex: 179.9,
    },
    {
      year: 2003,
      centsPerKwh: 3.86,
      usdKwh: 25.9,
      goldUsd: 363.38,
      goldAvu: 9412,
      cpiIndex: 184.0,
    },
    {
      year: 2004,
      centsPerKwh: 3.98,
      usdKwh: 25.1,
      goldUsd: 409.72,
      goldAvu: 10284,
      cpiIndex: 188.9,
    },
    {
      year: 2005,
      centsPerKwh: 4.12,
      usdKwh: 24.3,
      goldUsd: 444.74,
      goldAvu: 10807,
      cpiIndex: 195.3,
    },
    {
      year: 2006,
      centsPerKwh: 4.28,
      usdKwh: 23.4,
      goldUsd: 603.46,
      goldAvu: 14121,
      cpiIndex: 201.6,
    },
    {
      year: 2007,
      centsPerKwh: 4.38,
      usdKwh: 22.8,
      goldUsd: 695.39,
      goldAvu: 15855,
      cpiIndex: 207.3,
      notes: 'Subprime mortgage crisis begins in earnest',
    },
    {
      year: 2008,
      centsPerKwh: 4.42,
      usdKwh: 22.6,
      goldUsd: 871.96,
      goldAvu: 19706,
      cpiIndex: 215.3,
      notes:
        'Lehman Brothers collapses; TARP bailout enacted; Satoshi publishes Bitcoin whitepaper',
    },

    // --- 7. The Proof-of-Work Emergence Era (2009 - 2019) ---
    {
      year: 2009,
      centsPerKwh: 4.46,
      usdKwh: 22.4,
      goldUsd: 972.35,
      goldAvu: 21781,
      cpiIndex: 214.5,
      powHashRate: 1.0,
      notes:
        'January 3, 2009: Bitcoin Genesis block mined with Chancellor headline',
    },
    {
      year: 2010,
      centsPerKwh: 4.63,
      usdKwh: 21.6,
      goldUsd: 1224.53,
      goldAvu: 26450,
      cpiIndex: 218.1,
      powHashRate: 2.2,
      notes:
        'First real-world Bitcoin transaction (10k BTC for pizza); GPU OpenCL mining begins',
    },
    {
      year: 2011,
      centsPerKwh: 4.68,
      usdKwh: 21.4,
      goldUsd: 1571.52,
      goldAvu: 33631,
      cpiIndex: 224.9,
      powHashRate: 3.4,
      notes: 'Bitcoin reaches $1 parity; US sovereign credit rating downgraded',
    },
    {
      year: 2012,
      centsPerKwh: 4.67,
      usdKwh: 21.4,
      goldUsd: 1668.98,
      goldAvu: 35716,
      cpiIndex: 229.6,
      powHashRate: 4.1,
      notes: 'First Bitcoin block reward halving (50 -> 25 BTC)',
    },
    {
      year: 2013,
      centsPerKwh: 5.05,
      usdKwh: 19.8,
      goldUsd: 1411.23,
      goldAvu: 27942,
      cpiIndex: 233.0,
      powHashRate: 4.8,
      notes: 'First custom ASIC mining hardware deployed (Avalon, Antminer S1)',
    },
    {
      year: 2014,
      centsPerKwh: 5.12,
      usdKwh: 19.5,
      goldUsd: 1266.4,
      goldAvu: 24695,
      cpiIndex: 236.7,
      powHashRate: 5.9,
      notes: 'Mt. Gox collapse; 28nm ASIC generation becomes standard',
    },
    {
      year: 2015,
      centsPerKwh: 5.3,
      usdKwh: 18.9,
      goldUsd: 1160.06,
      goldAvu: 21925,
      cpiIndex: 237.0,
      powHashRate: 6.8,
      notes: 'Ethereum mainnet launches; ASIC efficiency ~0.5 J/GH',
    },
    {
      year: 2016,
      centsPerKwh: 5.71,
      usdKwh: 17.5,
      goldUsd: 1250.74,
      goldAvu: 21888,
      cpiIndex: 240.0,
      powHashRate: 7.6,
      notes:
        'Second Bitcoin Halving (25 -> 12.5 BTC); Bitmain Antminer S9 (16nm, ~100 J/TH)',
    },
    {
      year: 2017,
      centsPerKwh: 5.95,
      usdKwh: 16.8,
      goldUsd: 1257.15,
      goldAvu: 21120,
      cpiIndex: 245.1,
      powHashRate: 8.5,
      notes:
        'Global crypto awareness; Bitcoin hits $20,000; Hashrate crosses 10 EH/s',
    },
    {
      year: 2018,
      centsPerKwh: 6.12,
      usdKwh: 16.3,
      goldUsd: 1268.49,
      goldAvu: 20676,
      cpiIndex: 251.1,
      powHashRate: 9.1,
      notes:
        'Bear market shakeout; difficulty adjustments absorb miner capitulation',
    },
    {
      year: 2019,
      centsPerKwh: 6.45,
      usdKwh: 15.5,
      goldUsd: 1392.6,
      goldAvu: 21585,
      cpiIndex: 255.7,
      powHashRate: 9.8,
      notes:
        '7nm ASIC deployment (Antminer S17, Whatsminer M20S); network exceeds 100 EH/s',
    },
  ] as const

/**
 * Key historical commodity anchors mapping physical energy density and inflation benchmarks.
 */
export const COMMODITY_ANCHORS: Record<string, CommodityAnchor> = {
  gold: {
    name: 'Gold (Troy Ounce)',
    symbol: 'XAU',
    unit: 'oz',
    price1971: 40.8,
    price2020: 1769.64,
    notes: 'Universal store of value; energy depletion anchor',
  },
  silver: {
    name: 'Silver (Troy Ounce)',
    symbol: 'XAG',
    unit: 'oz',
    price1971: 1.55,
    price2020: 20.55,
    notes: 'Monetary metal with critical industrial & solar PV demand',
  },
  crude_oil: {
    name: 'Brent Crude Oil (Barrel)',
    symbol: 'BRENT',
    unit: 'bbl',
    price1971: 3.56,
    price2020: 43.21,
    energyDensityKwh: 1700, // ~1,700 kWh of thermal energy per 42-gallon barrel
    notes: 'Primary hydrocarbon energy dense carrier',
  },
  natural_gas: {
    name: 'Natural Gas (MMBtu)',
    symbol: 'NG',
    unit: 'MMBtu',
    price1971: 0.22,
    price2020: 2.03,
    energyDensityKwh: 293.07, // 1 MMBtu ≈ 293.07 kWh
    notes: 'Primary feedstock for electrical generation',
  },
  copper: {
    name: 'High-Grade Copper (Pound)',
    symbol: 'HG',
    unit: 'lb',
    price1971: 0.52,
    price2020: 2.8,
    notes: 'Essential grid transmission and motor winding conductor',
  },
}

/**
 * Retrieves a slice of historical macro points between startYear and endYear (inclusive).
 */
export function getHistoricalMacroSlice(
  startYear = 1930,
  endYear = 2019,
): HistoricalMacroPoint[] {
  return HISTORICAL_MACRO_ARCHIVE_1930_2019.filter(
    p => p.year >= startYear && p.year <= endYear,
  )
}

/**
 * Finds a specific year in the historical archive.
 */
export function getHistoricalMacroPoint(
  year: number,
): HistoricalMacroPoint | undefined {
  return HISTORICAL_MACRO_ARCHIVE_1930_2019.find(p => p.year === year)
}

/**
 * Linearly interpolates historical values for non-integer or missing intermediate years.
 */
export function interpolateMacroPoint(year: number): HistoricalMacroPoint {
  if (year <= 1930) {
    return HISTORICAL_MACRO_ARCHIVE_1930_2019[0]
  }
  const lastIndex = HISTORICAL_MACRO_ARCHIVE_1930_2019.length - 1
  if (year >= 2019) {
    return HISTORICAL_MACRO_ARCHIVE_1930_2019[lastIndex]
  }

  const floorYear = Math.floor(year)
  const ceilYear = Math.ceil(year)

  const p0 = getHistoricalMacroPoint(floorYear)
  const p1 = getHistoricalMacroPoint(ceilYear)

  if (!p0) return HISTORICAL_MACRO_ARCHIVE_1930_2019[0]
  if (!p1 || floorYear === ceilYear) return p0

  const t = (year - floorYear) / (ceilYear - floorYear)

  const usdKwh = p0.usdKwh + t * (p1.usdKwh - p0.usdKwh)
  const centsPerKwh = p0.centsPerKwh + t * (p1.centsPerKwh - p0.centsPerKwh)
  const goldUsd = p0.goldUsd + t * (p1.goldUsd - p0.goldUsd)
  const goldAvu = p0.goldAvu + t * (p1.goldAvu - p0.goldAvu)

  let powHashRate: number | undefined = undefined
  if (p0.powHashRate !== undefined && p1.powHashRate !== undefined) {
    powHashRate = p0.powHashRate + t * (p1.powHashRate - p0.powHashRate)
  } else if (p1.powHashRate !== undefined) {
    powHashRate = p1.powHashRate
  }

  let cpiIndex: number | undefined = undefined
  if (p0.cpiIndex !== undefined && p1.cpiIndex !== undefined) {
    cpiIndex = p0.cpiIndex + t * (p1.cpiIndex - p0.cpiIndex)
  }

  return {
    year,
    usdKwh: Math.round(usdKwh * 100) / 100,
    centsPerKwh: Math.round(centsPerKwh * 100) / 100,
    goldUsd: Math.round(goldUsd * 100) / 100,
    goldAvu: Math.round(goldAvu),
    cpiIndex:
      cpiIndex !== undefined ? Math.round(cpiIndex * 10) / 10 : undefined,
    powHashRate:
      powHashRate !== undefined
        ? Math.round(powHashRate * 100) / 100
        : undefined,
  }
}
