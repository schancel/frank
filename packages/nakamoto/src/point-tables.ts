// Precomputed multiplication tables for public points this process multiplies again and
// again: a wallet's own keys and its peers' keys, which every sealed message and stamp
// multiplies by fresh secrets. A tabled point multiplies in constant time about six times
// faster. The generator has @noble/curves' own tables (Point.BASE). Only public points are
// tabled; whether a point has been seen before is not secret.

import { secp256k1 } from '@noble/curves/secp256k1.js'

const Point = secp256k1.ProjectivePoint
type Projective = typeof Point.BASE

export interface Multiplicand {
  readonly point: Projective
  /** True for a point with precomputed tables. Those multiply only by the constant-time path:
   * @noble/curves 1.9.1's variable-time multiplication over tables returns wrong points. */
  readonly tabled: boolean
}

/** Window bits: 520 precomputed points per table, built in about one plain multiplication. */
const WINDOW = 4
/** Tables kept (about 100 KB each), least recently used dropped first. */
const TABLES_KEPT = 16
/** Points seen once; a point gets a table the second time it is multiplied. */
const SEEN_KEPT = 256

const tables = new Map<string, Projective>()
const seen = new Set<string>()

/**
 * A parsed, valid `point` ready to multiply: the generator as `Point.BASE`, a point multiplied
 * before with its tables, otherwise the point itself.
 */
export function multiplicand(point: Projective): Multiplicand {
  if (point.equals(Point.BASE)) return { point: Point.BASE, tabled: true }
  const key = String.fromCharCode(...point.toRawBytes(true))
  const known = tables.get(key)
  if (known) {
    tables.delete(key)
    tables.set(key, known)
    return { point: known, tabled: true }
  }
  if (!seen.has(key)) {
    if (seen.size >= SEEN_KEPT) seen.clear()
    seen.add(key)
    return { point, tabled: false }
  }
  seen.delete(key)
  // A fresh object: tables are attached to the point object they were built for.
  const tabled = Point.fromAffine(point.toAffine())
  tabled._setWindowSize(WINDOW)
  const oldest = tables.keys().next()
  if (tables.size >= TABLES_KEPT && !oldest.done) tables.delete(oldest.value)
  tables.set(key, tabled)
  return { point: tabled, tabled: true }
}
