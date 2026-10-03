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
