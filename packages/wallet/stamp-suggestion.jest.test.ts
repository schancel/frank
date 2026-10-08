import {
  isqrt,
  computeGeometricStampSuggestion,
  derivePeerStampMetrics,
  getMessageStampWei,
} from "./stamp-suggestion";

describe("Stamp Suggestion & Geometric Mean Convergence (Issues #819 & #820)", () => {
  const ONE_MON = 1_000_000_000_000_000_000n; // 10^18 wei
  const DEFAULT_STAMP = 10_000_000_000_000_000n; // 0.01 MON = 10^16 wei

  describe("isqrt", () => {
    it("computes exact floor square roots for small numbers", () => {
      expect(isqrt(0n)).toBe(0n);
      expect(isqrt(1n)).toBe(1n);
      expect(isqrt(2n)).toBe(1n);
      expect(isqrt(3n)).toBe(1n);
      expect(isqrt(4n)).toBe(2n);
      expect(isqrt(8n)).toBe(2n);
      expect(isqrt(9n)).toBe(3n);
      expect(isqrt(15n)).toBe(3n);
      expect(isqrt(16n)).toBe(4n);
    });

    it("computes exact floor square roots for large 256-bit values", () => {
      const tenTo36 = 10n ** 36n;
      expect(isqrt(tenTo36)).toBe(10n ** 18n);

      const product = 5n * ONE_MON * (ONE_MON / 10n); // 5.0 * 0.1 MON = 0.5 MON^2 = 5 * 10^35
      const sqrt = isqrt(product);
      // sqrt(0.5 * 10^36) = sqrt(50 * 10^34) = ~7.0710678 * 10^17
      expect(sqrt).toBe(707_106_781_186_547_524n);
    });

    it("throws RangeError on negative inputs", () => {
      expect(() => isqrt(-1n)).toThrow(RangeError);
    });
  });

  describe("computeGeometricStampSuggestion", () => {
    it("returns default stamp when no prior history exists", () => {
      const suggestion = computeGeometricStampSuggestion({
        defaultStampWei: DEFAULT_STAMP,
      });
      expect(suggestion).toBe(DEFAULT_STAMP);
    });

    it("reproduces Issue #819 convergence sequence (5.00 MON opens, 0.10 MON replies)", () => {
      const stamp5Mon = 5n * ONE_MON;
      const stamp01Mon = ONE_MON / 10n; // 0.1 MON

      // Turn 3: A's perspective.
      // Mine = 5.00 MON, Theirs = 0.10 MON.
      // sqrt(5.00 * 0.10) = ~0.7071 MON. This is a decrease, uncapped.
      const turn3A = computeGeometricStampSuggestion({
        lastSentWei: stamp5Mon,
        lastReceivedWei: stamp01Mon,
        netReceivedWei: stamp01Mon - stamp5Mon, // -4.9 MON
        defaultStampWei: DEFAULT_STAMP,
      });
      // ~0.7071 MON
      expect(turn3A).toBe(707_106_781_186_547_524n);

      // Turn 4: B's perspective.
      // Mine = 0.10 MON, Theirs = 0.7071... MON.
      // B received: 5.00 MON (T1) + 0.7071 MON (T3), sent: 0.10 MON (T2) -> net > 0.
      const netB = stamp5Mon + turn3A - stamp01Mon;
      const turn4B = computeGeometricStampSuggestion({
        lastSentWei: stamp01Mon,
        lastReceivedWei: turn3A,
        netReceivedWei: netB,
        defaultStampWei: DEFAULT_STAMP,
      });
      // sqrt(0.10 * 0.7071) = ~0.2659 MON (~0.27 MON)
      expect(turn4B).toBe(265_914_794_847_249_430n);

      // Turn 5: A's perspective.
      // Mine = 0.7071 MON, Theirs = 0.2659 MON.
      // Decrease from 0.7071 -> uncapped.
      const turn5A = computeGeometricStampSuggestion({
        lastSentWei: turn3A,
        lastReceivedWei: turn4B,
        netReceivedWei: stamp01Mon + turn4B - (stamp5Mon + turn3A),
        defaultStampWei: DEFAULT_STAMP,
      });
      // sqrt(0.7071 * 0.2659) = ~0.4336 MON (~0.43 MON)
      expect(turn5A).toBe(433_624_439_641_401_759n);

      // Turn 6: B's perspective.
      // Mine = 0.2659 MON, Theirs = 0.4336 MON.
      const turn6B = computeGeometricStampSuggestion({
        lastSentWei: turn4B,
        lastReceivedWei: turn5A,
        netReceivedWei: netB + turn5A - turn4B,
        defaultStampWei: DEFAULT_STAMP,
      });
      // sqrt(0.2659 * 0.4336) = ~0.3395 MON (~0.34 MON)
      expect(turn6B).toBe(339_569_070_894_268_640n);

      // Verify rounding to 2 decimals matches Issue #819 table exactly:
      // Turn 3: 0.71, Turn 4: 0.27, Turn 5: 0.43, Turn 6: 0.34
      const toTwoDecimals = (wei: bigint) => (Number(wei) / 1e18).toFixed(2);
      expect(toTwoDecimals(turn3A)).toBe("0.71");
      expect(toTwoDecimals(turn4B)).toBe("0.27");
      expect(toTwoDecimals(turn5A)).toBe("0.43");
      expect(toTwoDecimals(turn6B)).toBe("0.34");
    });

    it("enforces floor when geometric mean drops below minimum", () => {
      const tinyStamp = 1_000n; // far below default
      const suggestion = computeGeometricStampSuggestion({
        lastSentWei: tinyStamp,
        lastReceivedWei: tinyStamp,
        defaultStampWei: DEFAULT_STAMP,
      });
      expect(suggestion).toBe(DEFAULT_STAMP);
    });

    it("enforces higher peerAdvertisedMinimum when specified", () => {
      const peerMinimum = 2n * DEFAULT_STAMP; // 0.02 MON
      const suggestion = computeGeometricStampSuggestion({
        lastSentWei: DEFAULT_STAMP,
        lastReceivedWei: DEFAULT_STAMP,
        defaultStampWei: DEFAULT_STAMP,
        minimumStampWei: peerMinimum,
      });
      expect(suggestion).toBe(peerMinimum);
    });

    it("caps upward suggestions by net value received (anti-draining / griefing protection)", () => {
      // Attacker sends a large opening bid of 100 MON.
      const hugeInbound = 100n * ONE_MON;
      const myLastSent = DEFAULT_STAMP; // 0.01 MON

      // Case A: User has net received = 0 (e.g. user previously paid more, so netReceived <= 0)
      const suggestionZeroNet = computeGeometricStampSuggestion({
        lastSentWei: myLastSent,
        lastReceivedWei: hugeInbound,
        netReceivedWei: 0n, // User has not received net profit from this peer
        defaultStampWei: DEFAULT_STAMP,
      });
      // Cannot increase above myLastSent
      expect(suggestionZeroNet).toBe(myLastSent);

      // Case B: User has received 0.5 MON net profit from this peer
      const partialNet = ONE_MON / 2n; // 0.5 MON
      const suggestionPartialNet = computeGeometricStampSuggestion({
        lastSentWei: myLastSent,
        lastReceivedWei: hugeInbound,
        netReceivedWei: partialNet,
        defaultStampWei: DEFAULT_STAMP,
      });
      // Raw would be sqrt(0.01 * 100) = 1.00 MON.
      // But max allowed is myLastSent (0.01) + partialNet (0.50) = 0.51 MON.
      expect(suggestionPartialNet).toBe(myLastSent + partialNet);
    });
  });

  describe("derivePeerStampMetrics and getMessageStampWei", () => {
    it("extracts stampValueWei correctly", () => {
      expect(getMessageStampWei({ stampValueWei: 500n })).toBe(500n);
      expect(
        getMessageStampWei({
          outpoints: [{ value: 100 }, { value: "200" }, { value: 300n }],
        })
      ).toBe(600n);
      expect(getMessageStampWei({})).toBe(0n);
    });

    it("derives correct metrics across a conversation history", () => {
      const messages = [
        { outbound: true, stampValueWei: 1000n, status: "confirmed" },
        { outbound: false, stampValueWei: 3000n, status: "confirmed" },
        { outbound: false, stampValueWei: 5000n, status: "confirmed" },
        { outbound: true, stampValueWei: 2000n, status: "error" }, // should be ignored
        { outbound: true, stampValueWei: 1500n, status: "confirmed" },
      ];

      const metrics = derivePeerStampMetrics(messages);
      expect(metrics.lastSentWei).toBe(1500n);
      expect(metrics.lastReceivedWei).toBe(5000n);
      // total received = 3000 + 5000 = 8000. total sent = 1000 + 1500 = 2500.
      expect(metrics.netReceivedWei).toBe(5500n);
      expect(metrics.sentCount).toBe(2);
      expect(metrics.receivedCount).toBe(2);
    });
  });
});
