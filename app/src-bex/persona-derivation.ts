/**
 * Pure TypeScript Keccak-256 helpers for the Frank WebExtension background (`src-bex`).
 *
 * The background holds no persona keys and derives no persona addresses: dApp persona keys are
 * hardened custody derivations (`@frank/wallet/dapp-bridge/persona-keys`) and Frank provisions
 * only their addresses to the extension.
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

