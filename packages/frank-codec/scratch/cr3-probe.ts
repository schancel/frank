/* CR-3 probe: zero-valued DER INTEGER across the exported primitives. */
import { fromHex, parseStrictDer, verifyAlgorithm1, hasLowS } from '../src'

// r = 0, s = 1: `SEQUENCE { INTEGER 0, INTEGER 1 }` = 30 07 02 01 00 02 01 01
const derR0 = fromHex('3006020100020101')
try {
  const p = parseStrictDer(derR0)
  console.log('TS parseStrictDer(r=0): ACCEPTED', p)
} catch (e) {
  console.log(
    'TS parseStrictDer(r=0): REJECTED —',
    (e as Error).message,
    '| category/stage:',
    (e as { category?: string; stage?: string }).category,
    (e as { stage?: string }).stage,
  )
}

// r = 1, s = 1 sanity: parses (verify will be false against a random key).
const derR1 = fromHex('3006020101020101')
console.log('TS parseStrictDer(r=1):', (() => { try { return parseStrictDer(derR1) } catch (e) { return (e as Error).message } })())

// Stage-10.6 reachability: does a r=0 DER change verifyAlgorithm1's outcome vs an unparseable DER?
const key = fromHex('02'.padEnd(66, '0')) // garbage key; verify should be false either way
console.log('TS verifyAlgorithm1(der r=0) =', verifyAlgorithm1(new Uint8Array(32), derR0, key))
console.log('TS verifyAlgorithm1(der r=1) =', verifyAlgorithm1(new Uint8Array(32), derR1, key))