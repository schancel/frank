import { samplePrices } from "../src/sampler";
import type { PriceSample } from "../src/types";

describe("samplePrices", () => {
  it("handles empty samples safely", () => {
    const result = samplePrices("ETH", []);
    expect(result.asset).toBe("ETH");
    expect(result.price).toBe(0);
    expect(result.sampleCount).toBe(0);
    expect(result.spreadPct).toBe(0);
  });

  it("handles a single sample directly", () => {
    const sample: PriceSample = {
      provider: "coinbase",
      asset: "ETH",
      price: 2600.5,
      timestamp: 1000,
      latencyMs: 50,
    };
    const result = samplePrices("ETH", [sample]);
    expect(result.price).toBe(2600.5);
    expect(result.sampleCount).toBe(1);
    expect(result.spreadPct).toBe(0);
  });

  const two = (a: number, b: number): PriceSample[] => [
    {
      provider: "coinbase",
      asset: "XEC",
      price: a,
      timestamp: 1,
      latencyMs: 1,
    },
    { provider: "kraken", asset: "XEC", price: b, timestamp: 1, latencyMs: 1 },
  ];

  it("gives no price when exactly two sources disagree widely, and keeps both answers", () => {
    // One source lying 100x would otherwise put the "middle" at about 50x.
    const result = samplePrices("XEC", two(1, 100));
    expect(result.price).toBe(0);
    expect(result.sampleCount).toBe(0);
    expect(result.spreadPct).toBe(9900);
    expect(result.samples).toHaveLength(2);
  });

  it("takes the middle of two sources that agree within the allowed spread", () => {
    const result = samplePrices("XEC", two(100, 105));
    expect(result.price).toBe(102.5);
    expect(result.sampleCount).toBe(2);
  });

  it("calculates median across odd number of samples", () => {
    const samples: PriceSample[] = [
      {
        provider: "coinbase",
        asset: "ETH",
        price: 2600,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "kraken",
        asset: "ETH",
        price: 2610,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "pyth",
        asset: "ETH",
        price: 2605,
        timestamp: 1,
        latencyMs: 1,
      },
    ];
    const result = samplePrices("ETH", samples, "median");
    expect(result.price).toBe(2605);
    expect(result.sampleCount).toBe(3);
  });

  it("calculates median across even number of samples", () => {
    const samples: PriceSample[] = [
      {
        provider: "coinbase",
        asset: "ETH",
        price: 2600,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "kraken",
        asset: "ETH",
        price: 2610,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "pyth",
        asset: "ETH",
        price: 2604,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "chainlink",
        asset: "ETH",
        price: 2608,
        timestamp: 1,
        latencyMs: 1,
      },
    ];
    // Sorted: 2600, 2604, 2608, 2610 -> (2604 + 2608) / 2 = 2606
    const result = samplePrices("ETH", samples, "median");
    expect(result.price).toBe(2606);
    expect(result.sampleCount).toBe(4);
  });

  it("calculates mean across samples", () => {
    const samples: PriceSample[] = [
      {
        provider: "coinbase",
        asset: "SOL",
        price: 150,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "kraken",
        asset: "SOL",
        price: 152,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "coingecko",
        asset: "SOL",
        price: 151,
        timestamp: 1,
        latencyMs: 1,
      },
    ];
    const result = samplePrices("SOL", samples, "mean");
    expect(result.price).toBe(151);
  });

  it("discards extreme outliers when 3 or more samples exist", () => {
    const samples: PriceSample[] = [
      {
        provider: "coinbase",
        asset: "ETH",
        price: 2600,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "kraken",
        asset: "ETH",
        price: 2605,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "pyth",
        asset: "ETH",
        price: 2595,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "binance",
        asset: "ETH",
        price: 99999,
        timestamp: 1,
        latencyMs: 1,
      }, // Extreme outlier
    ];
    const result = samplePrices("ETH", samples, "median");
    expect(result.price).toBe(2600);
    expect(result.sampleCount).toBe(3); // 4th sample was rejected as outlier
  });

  it("respects waterfall provider priority", () => {
    const samples: PriceSample[] = [
      {
        provider: "coingecko",
        asset: "BTC",
        price: 65000,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "chainlink",
        asset: "BTC",
        price: 65050,
        timestamp: 1,
        latencyMs: 1,
      },
      {
        provider: "coinbase",
        asset: "BTC",
        price: 65020,
        timestamp: 1,
        latencyMs: 1,
      },
    ];
    // Default priority: chainlink > pyth > coinbase > kraken > coingecko > binance
    const result = samplePrices("BTC", samples, "waterfall");
    expect(result.price).toBe(65050); // chainlink picked first
  });
});
