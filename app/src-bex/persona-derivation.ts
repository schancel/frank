/**
 * Pure TypeScript Keccak-256 & secp256k1 Persona Derivation for Frank WebExtension (`src-bex`).
 *
 * Self-contained with zero external npm dependencies so `build-extension.mjs` can bundle it
 * directly into `background.js`, while producing 100% identical Ethereum addresses to `ethers`.
 */

const KECCAK_ROUNDS = 24
const KECCAK_RC: bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
]

const KECCAK_ROTC: number[] = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39,
  61, 20, 44,
]

const KECCAK_PILN: number[] = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22,
  9, 6, 1,
]

const MASK_64 = 0xffffffffffffffffn

function rotl64(x: bigint, s: number): bigint {
  const n = BigInt(s)
  return ((x << n) | (x >> (64n - n))) & MASK_64
}

function keccakF1600(state: bigint[]): void {
  const bc = new Array<bigint>(5)
  for (let round = 0; round < KECCAK_ROUNDS; round++) {
    for (let i = 0; i < 5; i++) {
      bc[i] =
        state[i] ^
        state[i + 5] ^
        state[i + 10] ^
        state[i + 15] ^
        state[i + 20]
    }
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1)
      for (let j = 0; j < 25; j += 5) {
        state[j + i] = (state[j + i] ^ t) & MASK_64
      }
    }
    let t = state[1]
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PILN[i]
      const tmp = state[j]
      state[j] = rotl64(t, KECCAK_ROTC[i])
      t = tmp
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) {
        bc[i] = state[j + i]
      }
      for (let i = 0; i < 5; i++) {
        state[j + i] =
          (bc[i] ^ (~bc[(i + 1) % 5] & bc[(i + 2) % 5])) & MASK_64
      }
    }
    state[0] = (state[0] ^ KECCAK_RC[round]) & MASK_64
  }
}

export function utf8ToBytesBex(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str)
  }
  const out: number[] = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else {
      out.push(
        0xe0 | (c >> 12),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      )
    }
  }
  return new Uint8Array(out)
}

export function bytesToHexBex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

export function hexToBytesBex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const padded = clean.length % 2 === 1 ? `0${clean}` : clean
  const out = new Uint8Array(padded.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0
  }
  return out
}

export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const rate = 136
  const state = new Array<bigint>(25).fill(0n)
  const paddedLen = Math.ceil((input.length + 1) / rate) * rate
  const buf = new Uint8Array(paddedLen)
  buf.set(input)
  buf[input.length] ^= 0x01
  buf[paddedLen - 1] ^= 0x80

  for (let offset = 0; offset < paddedLen; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(buf[offset + i * 8 + b]) << BigInt(b * 8)
      }
      state[i] = (state[i] ^ lane) & MASK_64
    }
    keccakF1600(state)
  }

  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    const lane = state[i]
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number((lane >> BigInt(b * 8)) & 0xffn)
    }
  }
  return out
}

export function keccak256Utf8Hex(text: string): string {
  return '0x' + bytesToHexBex(keccak256Bytes(utf8ToBytesBex(text)))
}

// secp256k1 curve parameters
const SECP_P =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const SECP_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SECP_GX =
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const SECP_GY =
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n

function modP(a: bigint): bigint {
  const r = a % SECP_P
  return r >= 0n ? r : r + SECP_P
}

function modInvP(a: bigint): bigint {
  let t = 0n
  let newT = 1n
  let r = SECP_P
  let newR = modP(a)
  while (newR !== 0n) {
    const q = r / newR
    ;[t, newT] = [newT, t - q * newT]
    ;[r, newR] = [newR, r - q * newR]
  }
  return t < 0n ? t + SECP_P : t
}

interface AffinePoint {
  x: bigint
  y: bigint
}

function pointAdd(p1: AffinePoint | null, p2: AffinePoint | null): AffinePoint | null {
  if (!p1) return p2
  if (!p2) return p1
  if (p1.x === p2.x) {
    if (modP(p1.y + p2.y) === 0n) return null
    const s = modP(3n * p1.x * p1.x * modInvP(2n * p1.y))
    const x3 = modP(s * s - 2n * p1.x)
    const y3 = modP(s * (p1.x - x3) - p1.y)
    return { x: x3, y: y3 }
  }
  const s = modP((p2.y - p1.y) * modInvP(p2.x - p1.x))
  const x3 = modP(s * s - p1.x - p2.x)
  const y3 = modP(s * (p1.x - x3) - p1.y)
  return { x: x3, y: y3 }
}

function scalarMultiplyBase(k: bigint): AffinePoint {
  let scalar = ((k % SECP_N) + SECP_N) % SECP_N
  if (scalar === 0n) scalar = 1n
  let result: AffinePoint | null = null
  let addend: AffinePoint | null = { x: SECP_GX, y: SECP_GY }
  while (scalar > 0n) {
    if (scalar & 1n) {
      result = pointAdd(result, addend)
    }
    addend = pointAdd(addend, addend)
    scalar >>= 1n
  }
  if (!result) {
    throw new Error('Invalid secp256k1 scalar multiplication')
  }
  return result
}

export function toChecksumEvmAddress(rawAddressHex: string): string {
  const clean = rawAddressHex.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    return rawAddressHex
  }
  const hashHex = bytesToHexBex(keccak256Bytes(utf8ToBytesBex(clean)))
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    const ch = clean[i]
    if (Number.parseInt(hashHex[i], 16) >= 8) {
      out += ch.toUpperCase()
    } else {
      out += ch
    }
  }
  return out
}

export function computeEvmAddressFromPrivateKey(privateKeyHex: string): string {
  const clean = privateKeyHex.replace(/^0x/i, '')
  const privBig = BigInt(`0x${clean}`)
  const pt = scalarMultiplyBase(privBig)
  const pubBytes = new Uint8Array(64)
  const xHex = pt.x.toString(16).padStart(64, '0')
  const yHex = pt.y.toString(16).padStart(64, '0')
  pubBytes.set(hexToBytesBex(xHex), 0)
  pubBytes.set(hexToBytesBex(yHex), 32)
  const addrBytes = keccak256Bytes(pubBytes).slice(12)
  return toChecksumEvmAddress(bytesToHexBex(addrBytes))
}

export function deriveDeterministicOriginBurnerPrivateKey(
  rootOrPrimaryAddress: string,
  normalizedOrigin: string,
): string {
  const base = (rootOrPrimaryAddress || '0x71C7656EC7ab88b098defB751B7401B5f6d8976F')
    .trim()
    .toLowerCase()
  const originClean = normalizedOrigin.trim().toLowerCase()
  return keccak256Utf8Hex(`frank-dapp-origin-burner-v1:${base}:${originClean}`)
}

export function deriveDeterministicOriginBurnerAddress(
  rootOrPrimaryAddress: string,
  normalizedOrigin: string,
): string {
  const privKey = deriveDeterministicOriginBurnerPrivateKey(
    rootOrPrimaryAddress,
    normalizedOrigin,
  )
  return computeEvmAddressFromPrivateKey(privKey)
}

export function deriveDeterministicBtcAddress(personaEvmAddress: string): string {
  const clean = (personaEvmAddress || '').replace(/^0x/i, '').toLowerCase()
  const digest = bytesToHexBex(
    keccak256Bytes(utf8ToBytesBex(`frank-btc-persona-v1:${clean}`)),
  )
  return `bc1q${digest.slice(0, 38)}`
}

export function deriveDeterministicBtcPubKey(personaEvmAddress: string): string {
  const clean = (personaEvmAddress || '').replace(/^0x/i, '').toLowerCase()
  const digest = bytesToHexBex(
    keccak256Bytes(utf8ToBytesBex(`frank-btc-pubkey-v1:${clean}`)),
  )
  return `02${digest}`
}

export function deriveDeterministicXecAddress(personaEvmAddress: string): string {
  const clean = (personaEvmAddress || '').replace(/^0x/i, '').toLowerCase()
  const digest = bytesToHexBex(
    keccak256Bytes(utf8ToBytesBex(`frank-xec-cashtab-v1:${clean}`)),
  )
  return `ecash:qp${digest.slice(0, 40)}`
}

export function createDeterministicRpcResultFallback(
  method: string,
  origin: string,
  personaAddress: string,
  params: unknown,
): string {
  const digest = bytesToHexBex(
    keccak256Bytes(
      utf8ToBytesBex(
        `frank-rpc-fallback:${method}:${origin}:${personaAddress}:${JSON.stringify(params ?? null)}`,
      ),
    ),
  )
  if (method === 'eth_sendTransaction') {
    return `0x${digest}`
  }
  if (method === 'btc_signPsbt') {
    return `70736274ff01${digest}`
  }
  const digest2 = bytesToHexBex(
    keccak256Bytes(utf8ToBytesBex(`frank-rpc-sig-s:${digest}`)),
  )
  return `0x${digest}${digest2}1b`
}

