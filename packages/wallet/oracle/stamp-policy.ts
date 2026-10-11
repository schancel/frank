/** Host-owned configuration: the recipient's value, independent of native coin and fees. */
export interface StampPolicyConfig {
  readonly targetAvu: string;
}

/** Fixed AVU target calibrated near one cent; never recalibrated on feed refresh. */
export const DEFAULT_STAMP_TARGET_AVU = "0.1";

interface Ratio {
  numerator: bigint;
  denominator: bigint;
}

/** Decimal representation, including scientific notation emitted by numeric oracle rates. */
function positiveDecimal(value: string | number): Ratio {
  const text = String(value).trim();
  // This checks validity only; all monetary arithmetic below uses integers.
  if (!Number.isFinite(Number(text)) || Number(text) <= 0)
    throw new Error("Stamp pricing requires a finite positive decimal");
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new Error("Stamp pricing requires a positive decimal");
  const fractional = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) - fractional.length;
  const digits = BigInt(match[1] + fractional);
  return exponent >= 0
    ? { numerator: digits * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(-exponent) };
}

/** The host passes its public FRANK_DM_DEFAULT_STAMP_AVU value; this module reads no env. */
export function stampPolicyConfig(
  targetAvu = DEFAULT_STAMP_TARGET_AVU
): StampPolicyConfig {
  positiveDecimal(targetAvu);
  return { targetAvu: targetAvu.trim() };
}

/** The least integer base-unit amount that meets the configured AVU value. */
export function avuToRawCeil(
  targetAvu: string,
  avuPerCoin: string | number,
  decimals: number
): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0)
    throw new Error("Stamp pricing requires nonnegative integer decimals");
  const target = positiveDecimal(targetAvu);
  const rate = positiveDecimal(avuPerCoin);
  const numerator =
    target.numerator * rate.denominator * 10n ** BigInt(decimals);
  const denominator = target.denominator * rate.numerator;
  return (numerator + denominator - 1n) / denominator;
}

export type DefaultStampQuote =
  | {
      readonly status: "available";
      readonly chainIdentifier: string;
      readonly amount: bigint;
      readonly targetAmount: bigint;
      /** Adapter minimum; not a quote of the complete multi-input network fee. */
      readonly minimumStamp: bigint;
      readonly rateAt: number;
    }
  | {
      readonly status: "unavailable";
      readonly chainIdentifier: string;
      readonly reason:
        | "unsupported"
        | "missing-rate"
        | "stale-rate"
        | "missing-fee";
    };

/** Pure decision shared by app, bot and SDK composition; no custody or transport access. */
export function quoteDefaultStamp(input: {
  readonly chainIdentifier: string;
  readonly supportsDirectMessages: boolean;
  readonly decimals: number;
  readonly config: StampPolicyConfig;
  readonly avuPerCoin?: string | number;
  readonly rateAt?: number;
  readonly rateStale?: boolean;
  readonly minimumStamp?: bigint;
}): DefaultStampQuote {
  const unavailable = (
    reason: Extract<DefaultStampQuote, { status: "unavailable" }>["reason"]
  ): DefaultStampQuote => ({
    status: "unavailable",
    chainIdentifier: input.chainIdentifier,
    reason,
  });
  if (!input.supportsDirectMessages) return unavailable("unsupported");
  if (
    input.avuPerCoin === undefined ||
    input.rateAt === undefined ||
    !Number.isFinite(input.rateAt) ||
    input.rateAt <= 0
  )
    return unavailable("missing-rate");
  if (input.rateStale) return unavailable("stale-rate");
  let targetAmount: bigint;
  try {
    targetAmount = avuToRawCeil(
      input.config.targetAvu,
      input.avuPerCoin,
      input.decimals
    );
  } catch {
    return unavailable("missing-rate");
  }
  if (input.minimumStamp === undefined || input.minimumStamp < 0n)
    return unavailable("missing-fee");
  return {
    status: "available",
    chainIdentifier: input.chainIdentifier,
    amount:
      targetAmount > input.minimumStamp ? targetAmount : input.minimumStamp,
    targetAmount,
    minimumStamp: input.minimumStamp,
    rateAt: input.rateAt,
  };
}
