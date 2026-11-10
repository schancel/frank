/** One bounded historical display fact owned by OracleCache, never spend authorization. */
import {
  SUPPORTED_ASSETS,
  unavailableOracleRates,
  type OracleRates,
} from '@frank/wallet/oracle'

export const MAX_ORACLE_VIEW_BYTES = 32 * 1024
const MAX_ENTRIES = 64
const assets = new Set<string>(SUPPORTED_ASSETS)
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128
const close = (a: number, b: number) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9

/** Validate a complete view before trusting its age, fee coverage or numeric provenance.
 * Rebuilds an owned plain snapshot; unknown fields/asset keys are never carried forward. */
export function validateOracleView(
  value: unknown,
  nowSeconds: number,
  requireValue = true,
): OracleRates {
  const fail = (): never => {
    throw new Error('Invalid retained oracle valuation')
  }
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    return fail()
  }
  if (
    !encoded ||
    new TextEncoder().encode(encoded).length > MAX_ORACLE_VIEW_BYTES
  )
    return fail()
  const time = (at: unknown): at is number =>
    finite(at) && Number.isInteger(at) && at >= 0 && at <= nowSeconds
  const keys = (object: Record<string, unknown>, allowed: string[]) =>
    Object.keys(object).every(key => allowed.includes(key))
  if (
    !record(value) ||
    !keys(value, [
      'at',
      'rates',
      'priceAt',
      'priceStale',
      'avuHash',
      'avuSpot',
    ]) ||
    !time(value.at) ||
    !record(value.rates) ||
    !record(value.priceAt) ||
    !record(value.priceStale)
  )
    return fail()
  const { rates, priceAt, priceStale, at } = value
  const names = Object.keys(rates)
  if (
    !names.every(
      name =>
        assets.has(name) &&
        positive(rates[name]) &&
        time(priceAt[name]) &&
        Number(priceAt[name]) <= at &&
        typeof priceStale[name] === 'boolean',
    ) ||
    Object.keys(priceAt).length !== names.length ||
    Object.keys(priceStale).length !== names.length ||
    !Object.keys(priceAt).every(name => names.includes(name)) ||
    !Object.keys(priceStale).every(name => names.includes(name))
  )
    return fail()
  const hash = value.avuHash
  if (hash !== undefined) {
    if (
      !record(hash) ||
      !keys(hash, [
        'kwhPerValue',
        'entries',
        'leftOut',
        'basketSize',
        'oldestInputAt',
        'stale',
      ]) ||
      !positive(hash.kwhPerValue) ||
      !time(hash.oldestInputAt) ||
      hash.oldestInputAt > value.at ||
      typeof hash.stale !== 'boolean' ||
      !Array.isArray(hash.entries) ||
      !Array.isArray(hash.leftOut) ||
      hash.entries.length === 0 ||
      hash.entries.length > MAX_ENTRIES ||
      hash.leftOut.length > MAX_ENTRIES ||
      hash.basketSize !== hash.entries.length + hash.leftOut.length
    )
      return fail()
    let total = 0,
      weighted = 0
    const ids = new Set<string>()
    for (const entry of hash.entries) {
      if (
        !record(entry) ||
        !keys(entry, [
          'id',
          'label',
          'valuePerKwh',
          'kwhPerValue',
          'marketCap',
          'weight',
          'estimated',
          'feesIncluded',
        ]) ||
        !text(entry.id) ||
        ids.has(entry.id) ||
        !text(entry.label) ||
        !positive(entry.valuePerKwh) ||
        !positive(entry.kwhPerValue) ||
        !close(entry.valuePerKwh * entry.kwhPerValue, 1) ||
        !positive(entry.marketCap) ||
        !positive(entry.weight) ||
        entry.weight > 1 ||
        typeof entry.estimated !== 'boolean' ||
        typeof entry.feesIncluded !== 'boolean'
      )
        return fail()
      ids.add(entry.id)
      total += entry.weight
      weighted += entry.weight * entry.kwhPerValue
    }
    for (const entry of hash.leftOut) {
      if (
        !record(entry) ||
        !keys(entry, ['id', 'label', 'reason']) ||
        !text(entry.id) ||
        ids.has(entry.id) ||
        !text(entry.label) ||
        !['efficiency', 'price', 'chain'].includes(String(entry.reason))
      )
        return fail()
      ids.add(entry.id)
    }
    if (!close(total, 1) || !close(weighted, hash.kwhPerValue)) return fail()
  } else if (names.length) return fail()
  const spot = value.avuSpot
  if (
    !record(spot) ||
    !keys(spot, ['kwhPerValue', 'pricePerKwh', 'at', 'stale', 'unavailable']) ||
    typeof spot.stale !== 'boolean'
  )
    return fail()
  if (spot.kwhPerValue !== undefined) {
    if (
      !positive(spot.kwhPerValue) ||
      !positive(spot.pricePerKwh) ||
      !time(spot.at) ||
      !close(spot.kwhPerValue * spot.pricePerKwh, 1) ||
      spot.unavailable !== undefined
    )
      return fail()
  } else if (spot.unavailable === 'not-positive') {
    if (!finite(spot.pricePerKwh) || spot.pricePerKwh > 0 || !time(spot.at))
      return fail()
  } else if (
    spot.unavailable !== 'no-data' ||
    spot.pricePerKwh !== undefined ||
    spot.at !== undefined
  )
    return fail()
  if (requireValue && hash === undefined && spot.kwhPerValue === undefined)
    return fail()
  return JSON.parse(encoded) as OracleRates
}

/** Keep the hash and ALL its asset rates together. Spot has its own observation basis. */
export function retainOracleView(
  computed: OracleRates,
  previous: OracleRates | undefined,
  nowSeconds: number,
): OracleRates {
  // Pure computation may itself have no valid value; malformed/nonfinite output cannot
  // become trusted provenance. Preserve independent valid spot/hash parts when possible.
  let bundle: OracleRates
  try {
    bundle = validateOracleView(
      { ...computed, avuSpot: { stale: false, unavailable: 'no-data' } },
      nowSeconds,
      false,
    )
  } catch {
    bundle = unavailableOracleRates(computed.at)
  }
  if (
    previous?.avuHash &&
    (!bundle.avuHash ||
      Object.keys(previous.rates).some(
        asset => !positive(bundle.rates[asset as keyof typeof bundle.rates]),
      ))
  ) {
    bundle = {
      ...previous,
      avuHash: { ...previous.avuHash, stale: true },
      priceStale: Object.fromEntries(
        Object.keys(previous.rates).map(asset => [asset, true]),
      ),
    }
  }
  let spot = computed.avuSpot
  try {
    spot = validateOracleView(
      { ...unavailableOracleRates(computed.at), avuSpot: spot },
      nowSeconds,
      false,
    ).avuSpot
  } catch {
    spot = { stale: false, unavailable: 'no-data' }
  }
  if (
    !positive(spot.kwhPerValue) &&
    previous?.avuSpot.kwhPerValue !== undefined
  )
    spot = { ...previous.avuSpot, stale: true }
  return validateOracleView({ ...bundle, avuSpot: spot }, nowSeconds, false)
}
