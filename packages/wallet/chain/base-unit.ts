export function formatBaseUnit(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function parseBaseUnit(display: string, decimals: number): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(display.trim());
  if (!match || (match[3]?.length ?? 0) > decimals) {
    throw new Error(`invalid amount with at most ${decimals} decimal places`);
  }
  const scale = 10n ** BigInt(decimals);
  const fraction = (match[3] ?? "").padEnd(decimals, "0");
  const raw = BigInt(match[2]) * scale + BigInt(fraction || "0");
  return match[1] === "-" ? -raw : raw;
}

/** Which way a shortened amount moves when digits are dropped: `"down"` toward zero, `"up"` away
 * from zero. A limit a person may pay up to is shown rounded down, so the shown amount is
 * allowed; a minimum, a price or an amount needed is shown rounded up, so the shown amount is
 * enough. */
export type DisplayRounding = "down" | "up";

/** Decimals kept for an amount of one unit or more. */
export const DISPLAY_MAX_DECIMALS = 4;
/** Significant digits kept for an amount below one unit. */
export const DISPLAY_SIGNIFICANT_DIGITS = 4;

/**
 * Shortens an exact decimal string ("0.86192379322624184") for reading. Display only: never feed
 * the result back into arithmetic, validation or an amount input.
 *
 * - one unit or more: at most `DISPLAY_MAX_DECIMALS` decimals;
 * - below one unit: the leading zeros plus `DISPLAY_SIGNIFICANT_DIGITS` significant digits, so a
 *   non-zero amount never reads as "0";
 * - dropped digits move the amount `round` (default `"down"`: a balance is never shown larger
 *   than it is); an amount with no dropped non-zero digit is shown exactly;
 * - trailing zeros are dropped ("1.0" reads "1").
 *
 * Text that is not a plain decimal number is returned unchanged.
 */
export function shortenDisplayAmount(
  exact: string,
  round: DisplayRounding = "down"
): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(exact.trim());
  if (!match) return exact;
  const [, sign, wholeDigits, fraction = ""] = match;
  const whole = wholeDigits.replace(/^0+(?=\d)/, "");
  const firstDigit = fraction.search(/[1-9]/);
  const wanted =
    whole !== "0"
      ? DISPLAY_MAX_DECIMALS
      : firstDigit < 0
      ? 0
      : firstDigit + DISPLAY_SIGNIFICANT_DIGITS;
  const keep = Math.min(wanted, fraction.length);
  let scaled = BigInt(whole + fraction.slice(0, keep));
  if (round === "up" && /[1-9]/.test(fraction.slice(keep))) scaled += 1n;
  if (scaled === 0n) return "0";
  return `${sign}${formatBaseUnit(scaled, keep)}`;
}
