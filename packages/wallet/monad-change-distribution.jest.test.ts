import {
  orderOfMagnitude2,
  orderOfMagnitude10,
  computeGeometricRadixChangeSplits,
} from './monad-change-distribution';

describe('Monad Change Distribution & Geometric Radix Splitting (Issue #1180)', () => {
  describe('orderOfMagnitude2 and orderOfMagnitude10', () => {
    it('computes exact base-2 order of magnitude floor(log2(amount))', () => {
      expect(orderOfMagnitude2(1n)).toBe(0);
      expect(orderOfMagnitude2(2n)).toBe(1);
      expect(orderOfMagnitude2(3n)).toBe(1);
      expect(orderOfMagnitude2(4n)).toBe(2);
      expect(orderOfMagnitude2(7n)).toBe(2);
      expect(orderOfMagnitude2(8n)).toBe(3);
      expect(orderOfMagnitude2(1024n)).toBe(10);
      expect(orderOfMagnitude2(1025n)).toBe(10);
      expect(orderOfMagnitude2(1n << 60n)).toBe(60);
      expect(orderOfMagnitude2((1n << 60n) - 1n)).toBe(59);
    });

    it('computes exact base-10 order of magnitude floor(log10(amount))', () => {
      expect(orderOfMagnitude10(1n)).toBe(0);
      expect(orderOfMagnitude10(9n)).toBe(0);
      expect(orderOfMagnitude10(10n)).toBe(1);
      expect(orderOfMagnitude10(99n)).toBe(1);
      expect(orderOfMagnitude10(100n)).toBe(2);
      expect(orderOfMagnitude10(999n)).toBe(2);
      expect(orderOfMagnitude10(1_000_000_000n)).toBe(9);
      expect(orderOfMagnitude10(100_000_000_000_000_000n)).toBe(17);
    });

    it('throws RangeError for non-positive amounts', () => {
      expect(() => orderOfMagnitude2(0n)).toThrow(RangeError);
      expect(() => orderOfMagnitude2(-5n)).toThrow(RangeError);
      expect(() => orderOfMagnitude10(0n)).toThrow(RangeError);
      expect(() => orderOfMagnitude10(-100n)).toThrow(RangeError);
    });
  });

  describe('computeGeometricRadixChangeSplits', () => {
    const totalAvailableWei = 100_000_000_000_000_000n; // 0.1 MON
    const dustThresholdWei = 42_000_000_000_000n; // 42,000 gwei
    const minFeePerTxWei = 21_000_000_000_000n; // 21,000 gwei

    it('generates outputs that follow a geometric exponential decay spanning multiple orders of magnitude', () => {
      const splits = computeGeometricRadixChangeSplits({
        totalAvailableWei,
        dustThresholdWei,
        minFeePerTxWei,
      });

      // For 0.1 MON with ~42,000 gwei dust, geometric splitting produces multiple outputs
      expect(splits.length).toBeGreaterThanOrEqual(4);

      // Verify span across multiple base-2 orders of magnitude
      const ooms2 = splits.map(orderOfMagnitude2);
      const minOOM2 = Math.min(...ooms2);
      const maxOOM2 = Math.max(...ooms2);
      expect(maxOOM2 - minOOM2).toBeGreaterThanOrEqual(3);

      // Verify span across multiple base-10 orders of magnitude
      const ooms10 = splits.map(orderOfMagnitude10);
      const minOOM10 = Math.min(...ooms10);
      const maxOOM10 = Math.max(...ooms10);
      expect(maxOOM10 - minOOM10).toBeGreaterThanOrEqual(2);

      // Check exponential distribution: when sorted descending, outputs show step-down decay
      const sorted = [...splits].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
      for (let i = 0; i < sorted.length - 1; i++) {
        // Higher outputs should generally be larger than lower outputs
        expect(sorted[i]).toBeGreaterThanOrEqual(sorted[i + 1]);
      }
    });

    it('injects continuous multiplicative entropy jitter so outputs are neither round powers of 2 nor round decimals', () => {
      for (let run = 0; run < 10; run++) {
        const splits = computeGeometricRadixChangeSplits({
          totalAvailableWei,
          dustThresholdWei,
          minFeePerTxWei,
        });

        for (const out of splits) {
          // Output is not an exact power of 2: (x & (x - 1)) !== 0
          const isPowerOfTwo = (out & (out - 1n)) === 0n;
          expect(isPowerOfTwo).toBe(false);

          // Output is not a round decimal multiple (e.g. rounded to millions or billions of wei)
          expect(out % 1_000_000_000n).not.toBe(0n);
          expect(out % 10_000_000n).not.toBe(0n);
        }
      }
    });

    it('avoids recipient payment order of magnitude when recipientAmountWei is provided', () => {
      // Test across multiple recipient amounts and multiple iterations
      const recipientAmounts = [
        50_000_000_000_000_000n, // ~0.05 MON (OOM2 = 55)
        25_000_000_000_000_000n, // ~0.025 MON (OOM2 = 54)
        12_500_000_000_000_000n, // ~0.0125 MON (OOM2 = 53)
        3_000_000_000_000_000n, // ~0.003 MON (OOM2 = 51)
      ];

      for (const recipientAmountWei of recipientAmounts) {
        const targetOOM = orderOfMagnitude2(recipientAmountWei);

        for (let iteration = 0; iteration < 20; iteration++) {
          const splits = computeGeometricRadixChangeSplits({
            totalAvailableWei,
            recipientAmountWei,
            dustThresholdWei,
            minFeePerTxWei,
          });

          expect(splits.length).toBeGreaterThan(0);
          for (const out of splits) {
            const outOOM = orderOfMagnitude2(out);
            expect(outOOM).not.toBe(targetOOM);
          }
        }
      }
    });

    it('conserves available funds with zero lost wei (sum of outputs + sum of fees === totalAvailableWei)', () => {
      // Test different configurations: varying available amounts, fee levels, and output caps
      const testCases = [
        {
          total: 100_000_000_000_000_000n,
          fee: 21_000_000_000_000n,
          dust: 42_000_000_000_000n,
        },
        { total: 50_000_000_000_000_000n, fee: 0n, dust: 1_000_000_000_000n },
        {
          total: 1_000_000_000_000_000n,
          fee: 10_000_000_000_000n,
          dust: 20_000_000_000_000n,
        },
        {
          total: 200_000_000_000_000n,
          fee: 21_000_000_000_000n,
          dust: 42_000_000_000_000n,
        },
        {
          total: 123_456_789_012_345_678n,
          fee: 21_000_000_000_000n,
          dust: 42_000_000_000_000n,
        },
      ];

      for (const tc of testCases) {
        for (let run = 0; run < 10; run++) {
          const splits = computeGeometricRadixChangeSplits({
            totalAvailableWei: tc.total,
            dustThresholdWei: tc.dust,
            minFeePerTxWei: tc.fee,
          });

          const totalOutputs = splits.reduce((acc, val) => acc + val, 0n);
          const totalFees = BigInt(splits.length) * tc.fee;
          expect(totalOutputs + totalFees).toBe(tc.total);
        }
      }
    });

    it('enforces dust protection: never produces outputs below dustThresholdWei', () => {
      const splits = computeGeometricRadixChangeSplits({
        totalAvailableWei,
        dustThresholdWei,
        minFeePerTxWei,
      });

      for (const out of splits) {
        expect(out).toBeGreaterThanOrEqual(dustThresholdWei);
      }
    });

    it('returns empty array when total available amount is below dust + fee', () => {
      const belowDust = dustThresholdWei + minFeePerTxWei - 1n;
      const splits = computeGeometricRadixChangeSplits({
        totalAvailableWei: belowDust,
        dustThresholdWei,
        minFeePerTxWei,
      });
      expect(splits).toEqual([]);
    });

    it('creates single change output when balance is slightly above dust but insufficient for multiple splits', () => {
      const tightAvailable = dustThresholdWei + minFeePerTxWei + 1_000_000_000n;
      const splits = computeGeometricRadixChangeSplits({
        totalAvailableWei: tightAvailable,
        dustThresholdWei,
        minFeePerTxWei,
      });

      expect(splits).toHaveLength(1);
      expect(splits[0]).toBe(tightAvailable - minFeePerTxWei);
      expect(splits[0] + minFeePerTxWei).toBe(tightAvailable);
    });

    it('respects maxOutputs parameter when specified', () => {
      const maxOutputs = 3;
      const splits = computeGeometricRadixChangeSplits({
        totalAvailableWei,
        dustThresholdWei,
        minFeePerTxWei,
        maxOutputs,
      });

      expect(splits.length).toBeLessThanOrEqual(maxOutputs);
      const totalOutputs = splits.reduce((acc, val) => acc + val, 0n);
      const totalFees = BigInt(splits.length) * minFeePerTxWei;
      expect(totalOutputs + totalFees).toBe(totalAvailableWei);
    });

    it('shuffles outputs so they are not monotonically descending', () => {
      let isShuffled = false;
      for (let run = 0; run < 10; run++) {
        const splits = computeGeometricRadixChangeSplits({
          totalAvailableWei,
          dustThresholdWei,
          minFeePerTxWei,
        });

        if (splits.length >= 3) {
          // Check if at least one adjacent pair is in ascending order
          for (let i = 0; i < splits.length - 1; i++) {
            if (splits[i] < splits[i + 1]) {
              isShuffled = true;
              break;
            }
          }
        }
        if (isShuffled) break;
      }
      expect(isShuffled).toBe(true);
    });
  });
});
