import { formatEther, getAddress, parseEther } from 'ethers'

/**
 * Parses user-provided token or wei amount into bigint wei.
 * Supports:
 * - "0.01" -> 10000000000000000n
 * - "0.01 MON" / "0.01MONT" -> 10000000000000000n
 * - "10000000000000000" -> 10000000000000000n
 * - "10000000000000000 wei" -> 10000000000000000n
 */
export function parseMonOrWei(input: string): bigint {
  const trimmed = input.trim()
  if (/^([0-9]+\.?[0-9]*|\.[0-9]+)\s*(mon|mont|mon1)?$/i.test(trimmed)) {
    const numericPart = trimmed.replace(/\s*(mon|mont|mon1)$/i, '').trim()
    if (numericPart.includes('.')) {
      return parseEther(numericPart)
    }
    // If it has explicit MON unit without decimal, e.g. "1 MON"
    if (/(mon|mont|mon1)$/i.test(trimmed)) {
      return parseEther(numericPart)
    }
  }
  // Try raw integer/wei
  const rawDigits = trimmed.replace(/\s*wei$/i, '').trim()
  if (/^\d+$/.test(rawDigits)) {
    return BigInt(rawDigits)
  }
  // Fallback to parseEther if valid decimal
  try {
    return parseEther(trimmed)
  } catch {
    throw new Error(`Invalid amount format: "${input}"`)
  }
}

export function formatMonAndWei(wei: bigint): string {
  return `${formatEther(wei)} MON (${wei.toString()} wei)`
}

export function normalizeAddress(address: string): string {
  try {
    return getAddress(address)
  } catch {
    throw new Error(`Invalid Ethereum/Monad address: "${address}"`)
  }
}

export function outputResult(
  result: unknown,
  textFormatter: () => void,
  isJson?: boolean,
): void {
  if (isJson) {
    console.log(
      JSON.stringify(
        result,
        (_, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
    )
  } else {
    textFormatter()
  }
}

export function setErrorExitCode(): void {
  if (process.env.NODE_ENV !== 'test') {
    process.exitCode = 1
  }
}

export function outputError(error: unknown, isJson?: boolean): void {
  const message = error instanceof Error ? error.message : String(error)
  if (isJson) {
    console.error(JSON.stringify({ error: message }, null, 2))
  } else {
    console.error(`Error: ${message}`)
  }
  setErrorExitCode()
}
