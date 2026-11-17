import { formatBaseUnit, shortenDisplayAmount } from "./base-unit";

/** The exact text of `raw` base units at `decimals`, shortened `round`. */
const shown = (raw: bigint, decimals: number, round: "down" | "up") =>
  shortenDisplayAmount(formatBaseUnit(raw, decimals), round);

describe("shortenDisplayAmount", () => {
  it("rounds a limit down and a minimum up, so neither misleads", () => {
    expect(shortenDisplayAmount("0.510496892794540437", "down")).toBe("0.5104");
    expect(shortenDisplayAmount("0.510496892794540437", "up")).toBe("0.5105");
    expect(shortenDisplayAmount("12.345678", "down")).toBe("12.3456");
    expect(shortenDisplayAmount("12.345678", "up")).toBe("12.3457");
  });

  it("rounds down by default", () => {
    expect(shortenDisplayAmount("0.86192379322624184")).toBe("0.8619");
  });

  it("shows an amount exactly when no non-zero digit is dropped", () => {
    for (const round of ["down", "up"] as const) {
      expect(shortenDisplayAmount("0.04284", round)).toBe("0.04284");
      expect(shortenDisplayAmount("0.245000000000000000", round)).toBe("0.245");
      expect(shortenDisplayAmount("3.0", round)).toBe("3");
      expect(shortenDisplayAmount("1.23450000", round)).toBe("1.2345");
    }
  });

  it("carries a rounded-up digit into the whole part", () => {
    expect(shortenDisplayAmount("0.99999", "up")).toBe("1");
    expect(shortenDisplayAmount("9.99991", "up")).toBe("10");
    expect(shortenDisplayAmount("0.0099999", "up")).toBe("0.01");
  });

  it("keeps a tiny amount non-zero in both directions", () => {
    expect(shortenDisplayAmount("0.000000000000000001", "down")).toBe("0.000000000000000001");
    expect(shortenDisplayAmount("0.000000000000000001", "up")).toBe("0.000000000000000001");
    expect(shortenDisplayAmount("0.000000123456789", "down")).toBe("0.0000001234");
    expect(shortenDisplayAmount("0.000000123456789", "up")).toBe("0.0000001235");
  });

  it("reads zero as 0", () => {
    for (const round of ["down", "up"] as const) {
      expect(shortenDisplayAmount("0", round)).toBe("0");
      expect(shortenDisplayAmount("0.0", round)).toBe("0");
      expect(shortenDisplayAmount("-0.0", round)).toBe("0");
      expect(shown(0n, 18, round)).toBe("0");
    }
  });

  it("rounds by magnitude for a negative amount", () => {
    expect(shortenDisplayAmount("-0.123456", "down")).toBe("-0.1234");
    expect(shortenDisplayAmount("-0.123456", "up")).toBe("-0.1235");
  });

  it.each([
    [18, 510_496_892_794_540_437n, "0.5104", "0.5105"],
    [18, 1_234_567_890_123_456_789n, "1.2345", "1.2346"],
    [9, 139_404_169n, "0.1394", "0.1395"],
    [9, 5_000_000_001n, "5", "5.0001"],
    [6, 1_234_567n, "1.2345", "1.2346"],
    [6, 42n, "0.000042", "0.000042"],
    [2, 123_456n, "1234.56", "1234.56"],
    [2, 1n, "0.01", "0.01"],
  ])("at %i decimals %p reads %s down and %s up", (decimals, raw, down, up) => {
    expect(shown(raw, decimals, "down")).toBe(down);
    expect(shown(raw, decimals, "up")).toBe(up);
  });

  it("returns text that is not a plain decimal number unchanged", () => {
    expect(shortenDisplayAmount("1e-7", "up")).toBe("1e-7");
    expect(shortenDisplayAmount("n/a", "down")).toBe("n/a");
    expect(shortenDisplayAmount("007.5", "up")).toBe("7.5");
  });
});
