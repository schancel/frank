const U64 = (1n << 64n) - 1n
export function u64(value: string): bigint {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > U64) throw new Error('Expected canonical u64')
  return BigInt(value)
}
