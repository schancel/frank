/**
 * Geometric radix change splitting and decoy pairing distribution for Monad/EVM wallet.
 *
 * Inspired by the original Stamp wallet change generation (cashweb/legacy-wallet/index.ts#L700-L753):
 * - Decomposes large leftover balances into multiple change outputs following a geometric power
 *   distribution with continuous entropy jitter.
 * - Prevents on-chain heuristics from distinguishing change outputs from payment outputs.
 * - Implements decoy pairing / OOM avoidance to never create a change output at the same base-2
 *   order of magnitude as the recipient payment amount.
 * - Exactly conserves available funds: sum(outputs) + sum(fees) === totalAvailableWei with 0 lost wei.
 * - Enforces dust protection: no outputs below dustThresholdWei are ever created.
 */

export interface GeometricRadixChangeParams {
  readonly totalAvailableWei: bigint;
  readonly recipientAmountWei?: bigint;
  readonly dustThresholdWei: bigint;
  readonly minFeePerTxWei?: bigint;
  readonly maxOutputs?: number;
  readonly radix?: number;
  readonly jitterBps?: number;
  readonly random?: () => number;
}

/**
 * Computes base-2 order of magnitude: floor(log2(amount)).
 * Exact for arbitrary BigInt values without IEEE 754 precision loss.
 */
export function orderOfMagnitude2(amount: bigint): number {
  if (amount <= 0n) {
    throw new RangeError(
      "Amount must be positive to compute order of magnitude"
    );
  }
  return amount.toString(2).length - 1;
}

/**
 * Computes base-10 order of magnitude: floor(log10(amount)).
 * Exact for arbitrary BigInt values without IEEE 754 precision loss.
 */
export function orderOfMagnitude10(amount: bigint): number {
  if (amount <= 0n) {
    throw new RangeError(
      "Amount must be positive to compute order of magnitude"
    );
  }
  return amount.toString(10).length - 1;
}

/** Geometric denominations use bigint arithmetic throughout. A feasible-sum interval check
 * leaves a legal tail at every step, so final residual absorption cannot recreate an excluded
 * magnitude. An impossible policy is rejected rather than silently losing value or exclusion. */
export function computeGeometricRadixChangeSplits(
  params: GeometricRadixChangeParams
): bigint[] {
  const {
    totalAvailableWei: total,
    recipientAmountWei,
    dustThresholdWei,
    minFeePerTxWei: fee = 0n,
    maxOutputs = 20,
    radix = 2,
    jitterBps = 1500,
    random = Math.random,
  } = params;
  if (
    dustThresholdWei < 0n ||
    fee < 0n ||
    !Number.isSafeInteger(maxOutputs) ||
    maxOutputs < 0 ||
    !Number.isSafeInteger(radix) ||
    radix < 2 ||
    !Number.isSafeInteger(jitterBps) ||
    jitterBps < 0 ||
    jitterBps > 9999
  )
    throw new RangeError("Invalid change distribution policy");
  const dust = dustThresholdWei > 0n ? dustThresholdWei : 1n;
  if (total < dust + fee || maxOutputs === 0) return [];
  const entropy = () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new RangeError("Invalid change entropy");
    return value;
  };
  const base = BigInt(radix);
  let lower: bigint | undefined;
  if (recipientAmountWei !== undefined && recipientAmountWei > 0n) {
    lower = 1n;
    while (lower * base <= recipientAmountWei) lower *= base;
  }
  type Interval = readonly [bigint, bigint];
  const allowed = (cap: bigint): Interval[] => {
    if (lower === undefined) return cap >= dust ? [[dust, cap]] : [];
    const intervals: Interval[] = [];
    if (dust < lower)
      intervals.push([dust, cap < lower - 1n ? cap : lower - 1n]);
    const high = dust > lower * base ? dust : lower * base;
    if (cap >= high) intervals.push([high, cap]);
    return intervals.filter(([lo, hi]) => lo <= hi);
  };
  // Sums of m legal denominations have at most two intervals: all below the excluded
  // bucket, or at least one above it. This keeps final residual handling exact.
  const sums = (count: number, cap: bigint): Interval[] => {
    if (count === 0) return [[0n, 0n]];
    if (lower === undefined)
      return cap >= BigInt(count) * dust ? [[BigInt(count) * dust, cap]] : [];
    const result: Interval[] = [];
    if (dust < lower) {
      const lo = BigInt(count) * dust,
        hi = BigInt(count) * (lower - 1n);
      if (lo <= cap) result.push([lo, hi < cap ? hi : cap]);
      const highLo = lower * base + BigInt(count - 1) * dust;
      if (highLo <= cap) result.push([highLo, cap]);
    } else {
      const minimum = dust >= lower * base ? dust : lower * base;
      if (BigInt(count) * minimum <= cap)
        result.push([BigInt(count) * minimum, cap]);
    }
    return result;
  };
  let desired = 1,
    scale = total / (dust + fee);
  while (scale >= base && desired < maxOutputs) {
    desired++;
    scale /= base;
  }
  const capCount = Math.min(
    maxOutputs,
    Number(
      total / (dust + fee) > BigInt(maxOutputs)
        ? BigInt(maxOutputs)
        : total / (dust + fee)
    )
  );
  desired = Math.min(desired, capCount);
  const counts = [
    ...Array.from({ length: desired }, (_, i) => desired - i),
    ...Array.from({ length: capCount - desired }, (_, i) => desired + i + 1),
  ];
  for (const count of counts) {
    let remaining = total - BigInt(count) * fee;
    if (
      !sums(count, remaining).some(
        ([lo, hi]) => remaining >= lo && remaining <= hi
      )
    )
      continue;
    const outputs: bigint[] = [];
    for (let index = 0; index < count; index++) {
      const left = count - index - 1;
      const entropyScale = 1n << 52n;
      const split =
        8000n * entropyScale +
        4000n * BigInt(Math.floor(entropy() * Number(entropyScale)));
      const jitter =
        entropyScale +
        ((2n * BigInt(Math.floor(entropy() * Number(entropyScale))) -
          entropyScale) *
          BigInt(jitterBps)) /
          10000n;
      const target =
        left === 0
          ? remaining
          : (remaining * split * jitter) /
            (base * 10000n * entropyScale * entropyScale);
      let best: bigint | undefined, distance: bigint | undefined;
      for (const [lo, hi] of allowed(remaining))
        for (const [tailLo, tailHi] of sums(left, remaining)) {
          const minimum = lo > remaining - tailHi ? lo : remaining - tailHi;
          const maximum = hi < remaining - tailLo ? hi : remaining - tailLo;
          if (minimum > maximum) continue;
          const candidate =
            target < minimum ? minimum : target > maximum ? maximum : target;
          const delta =
            candidate > target ? candidate - target : target - candidate;
          if (distance === undefined || delta < distance) {
            best = candidate;
            distance = delta;
          }
        }
      if (best === undefined)
        throw new RangeError("Unable to partition change");
      outputs.push(best);
      remaining -= best;
    }
    if (remaining !== 0n) throw new RangeError("Change did not conserve value");
    for (let index = outputs.length - 1; index > 0; index--) {
      const other = Math.floor(entropy() * (index + 1));
      [outputs[index], outputs[other]] = [outputs[other]!, outputs[index]!];
    }
    return outputs;
  }
  throw new RangeError(
    "No change partition satisfies dust, fee, output and magnitude limits"
  );
}

/**
 * Calculates a randomized decoy jitter delay using an exponential / Poisson
 * inter-arrival distribution to obfuscate background sweep timings.
 *
 * Uses inverse transform sampling: delay = -meanDelayMs * ln(1 - U) where U in [0, 1).
 * Clamps the resulting delay to [0, maxDelayMs].
 *
 * @param meanDelayMs Expected mean delay in milliseconds (default: 30,000 ms)
 * @param maxDelayMs Maximum ceiling for jitter delay in milliseconds (default: 120,000 ms)
 * @returns Jitter delay in milliseconds within [0, maxDelayMs]
 */
export function calculateDecoyJitterDelayMs(
  meanDelayMs = 30_000,
  maxDelayMs = 120_000
): number {
  if (meanDelayMs <= 0 || maxDelayMs <= 0) {
    return 0;
  }
  // Math.random() returns [0, 1), so (1 - Math.random()) returns (0, 1], guaranteeing Math.log is finite and <= 0
  const u = 1 - Math.random();
  const rawDelay = -meanDelayMs * Math.log(u);
  return Math.min(maxDelayMs, Math.max(0, Math.round(rawDelay)));
}
