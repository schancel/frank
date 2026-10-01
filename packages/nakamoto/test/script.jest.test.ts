import { createRequire } from 'module'

import { Buffer } from 'buffer'

import { ripemd160 } from '@noble/hashes/ripemd160.js'
import { sha1 } from '@noble/hashes/sha1.js'
import { sha256 } from '@noble/hashes/sha256.js'

import {
  BCH_MAINNET,
  BTC_MAINNET,
  XEC_MAINNET,
  XPI_MAINNET,
  type ChainDescriptor,
} from '../src/chain/index.js'
import { internalHashFromBytes } from '../src/constructors.js'
import { bytesToBigint } from '../src/integer.js'
import {
  evaluateScript,
  verifyScript,
  type ScriptCode,
  type ScriptContext,
  type ScriptResult,
} from '../src/script.js'
import {
  SIGHASH_ALL,
  SIGHASH_LOTUS,
  parseTransaction,
  sighash,
  type SpentOutput,
  type Transaction,
} from '../src/transaction.js'

const load = createRequire(__filename)
const old = load('bitcore-lib-xpi') as {
  Networks: { livenet: object }
  PrivateKey: new (data: {
    bn: string
    network: object
    compressed: boolean
  }) => {
    toPublicKey(): { toBuffer(): Buffer }
  }
  crypto: {
    ECDSA: {
      sign(
        hash: Buffer,
        key: {
          toPublicKey(): { toBuffer(): Buffer }
        },
      ): { toDER(): Buffer }
      verify(hash: Buffer, sig: object, pubkey: object): boolean
    }
    Signature: {
      fromDER(buf: Buffer): object
    }
  }
}

const PRIV = '18E14A7B6A307F426A94F8114701E7C8E774E7F9A47E2C2035DB29A206321725'
const PUB = '0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352'
const DER =
  '30440220225671a9b396b3fec658562586f7f0fe9e256966450b19884bf7fab805de367c0220513cfe27782ca3bd17114c42897ef5de2938b2c0870a7c76cda2d8ed2b68c344'
const ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const key = new old.PrivateKey({
  bn: PRIV,
  network: old.Networks.livenet,
  compressed: true,
})

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function push(data: Uint8Array): Uint8Array {
  if (data.length >= 76) throw new Error('test push is longer than 75')
  const out = new Uint8Array(1 + data.length)
  out[0] = data.length
  out.set(data, 1)
  return out
}

function scriptOf(hex: string): Uint8Array {
  return fromHex(hex)
}

function withRules(
  descriptor: ChainDescriptor,
  patch: Partial<ChainDescriptor['script']>,
): ChainDescriptor {
  return { ...descriptor, script: { ...descriptor.script, ...patch } }
}

function zeroTxid() {
  const branded = internalHashFromBytes(new Uint8Array(32))
  if (!branded.ok) throw new Error('txid')
  return branded.value
}

function oneInput(locktime: number, sequence: number): Transaction {
  return {
    version: 1,
    inputs: [
      {
        prevout: { txid: zeroTxid(), vout: 0 },
        scriptSig: new Uint8Array(0),
        sequence,
      },
    ],
    outputs: [{ value: 1n, scriptPubKey: Uint8Array.of(0x51) }],
    locktime,
  }
}

function twoInput(): Transaction {
  return {
    version: 2,
    inputs: [
      {
        prevout: { txid: zeroTxid(), vout: 0 },
        scriptSig: new Uint8Array(0),
        sequence: 0,
      },
      {
        prevout: { txid: zeroTxid(), vout: 1 },
        scriptSig: Uint8Array.of(0x51),
        sequence: 5,
      },
    ],
    outputs: [
      { value: 9n, scriptPubKey: Uint8Array.of(0x51) },
      { value: 8n, scriptPubKey: Uint8Array.of(0x00) },
    ],
    locktime: 0,
  }
}

function ctx(
  chain: ChainDescriptor,
  extra: Omit<ScriptContext, 'chain'> = {},
): ScriptContext {
  return { chain, ...extra }
}

function codes(result: ScriptResult<unknown>): ScriptCode | 'ok' {
  return result.ok ? 'ok' : result.error.code
}

function expectStack(
  result: ScriptResult<Uint8Array[]>,
  hexes: string[],
): void {
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.map(toHex)).toEqual(hexes)
}

function p2sh(redeem: Uint8Array): Uint8Array {
  const hash = ripemd160(sha256(redeem))
  const out = new Uint8Array(23)
  out[0] = 0xa9
  out[1] = 20
  out.set(hash, 2)
  out[22] = 0x87
  return out
}

function derInt(value: bigint): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2 === 1) hex = `0${hex}`
  const raw = fromHex(hex)
  const first = raw[0] ?? 0
  if ((first & 0x80) === 0) return raw
  const padded = new Uint8Array(raw.length + 1)
  padded.set(raw, 1)
  return padded
}

function derSig(r: Uint8Array, s: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + r.length + s.length)
  body[0] = 0x02
  body[1] = r.length
  body.set(r, 2)
  body[2 + r.length] = 0x02
  body[3 + r.length] = s.length
  body.set(s, 4 + r.length)
  const out = new Uint8Array(2 + body.length)
  out[0] = 0x30
  out[1] = body.length
  out.set(body, 2)
  return out
}

function signDigest(digest: Uint8Array, hashType: number): Uint8Array {
  const der = old.crypto.ECDSA.sign(Buffer.from(digest), key).toDER()
  const out = new Uint8Array(der.length + 1)
  out.set(der, 0)
  out[der.length] = hashType
  return out
}

function mustSighash(
  tx: Transaction,
  chain: ChainDescriptor,
  hashType: number,
  scriptCode: Uint8Array,
  amount?: bigint,
  spent?: readonly SpentOutput[],
): Uint8Array {
  const algorithm =
    chain.family === 'btc'
      ? 'legacy'
      : chain.family === 'xpi'
      ? 'lotus'
      : 'forkid'
  const hashed = sighash(tx, 0, chain, hashType, {
    algorithm,
    scriptCode,
    amount,
    spent,
    commitUtxos: false,
  })
  if (!hashed.ok) throw new Error(hashed.error.code)
  return hashed.value
}

describe('per-chain script eras', () => {
  test('each descriptor names the upgrade its opcodes claim', () => {
    expect(BTC_MAINNET.script.era).toBe('btc-core-standard')
    expect(BTC_MAINNET.script.cat).toBe(false)
    expect(BTC_MAINNET.script.introspection).toBe(false)
    expect(BTC_MAINNET.script.tapscript).toBe('rejected')
    expect(BCH_MAINNET.script.era).toBe('bch-2022-05-15')
    expect(BCH_MAINNET.script.introspection).toBe(true)
    expect(BCH_MAINNET.script.cat).toBe(true)
    expect(BCH_MAINNET.script.reverseBytes).toBe(true)
    expect(BCH_MAINNET.script.checkDataSig).toBe(true)
    expect(BCH_MAINNET.script.maxElementBytes).toBe(520)
    expect(BCH_MAINNET.script.maxOps).toBe(201)
    expect(BCH_MAINNET.script.maxScriptBytes).toBe(10000)
    expect(BCH_MAINNET.script.maxStackItems).toBe(1000)
    expect(BCH_MAINNET.script.maxScriptNumBytes).toBe(4)
    expect(BCH_MAINNET.script.schnorr).toBe('rejected')
    expect(XEC_MAINNET.script.era).toBe('xec-pre-introspection')
    expect(XEC_MAINNET.script.introspection).toBe(false)
    expect(XEC_MAINNET.script.cat).toBe(true)
    expect(XPI_MAINNET.script.era).toBe('xpi-old-interpreter')
    expect(XPI_MAINNET.script.reverseBytes).toBe(true)
    expect(XPI_MAINNET.script.introspection).toBe(false)
  })

  // No mutator tool ran. These three flips are the survivors that change a
  // result: a smaller element limit, a stack bound of exactly N, and
  // minimalData off. Schnorr success, token success, witness success, and
  // the May 2025 density model are unimplemented and fail closed, so a
  // mutant that made them succeed would not be covered here.
  test('a smaller element limit, stack bound, and minimalData flag change the result', () => {
    const three = scriptOf('03010203')
    expectStack(evaluateScript(three, ctx(BTC_MAINNET)), ['010203'])
    expect(
      codes(
        evaluateScript(
          three,
          ctx(withRules(BTC_MAINNET, { maxElementBytes: 2 })),
        ),
      ),
    ).toBe('script-push-size')
    const two = scriptOf('5151')
    const threeOps = scriptOf('515151')
    const tight = withRules(BTC_MAINNET, { maxStackItems: 2 })
    expect(evaluateScript(two, ctx(tight)).ok).toBe(true)
    expect(codes(evaluateScript(threeOps, ctx(tight)))).toBe(
      'script-stack-size',
    )
    const direct = scriptOf('0101')
    expect(codes(evaluateScript(direct, ctx(BTC_MAINNET)))).toBe(
      'script-minimal-data',
    )
    expectStack(
      evaluateScript(
        direct,
        ctx(withRules(BTC_MAINNET, { minimalData: false })),
      ),
      ['01'],
    )
  })

  test('disabled opcodes fail in a dead branch and unknown opcodes do not', () => {
    expect(
      codes(evaluateScript(scriptOf('00637e6851'), ctx(BTC_MAINNET))),
    ).toBe('script-disabled')
    expectStack(evaluateScript(scriptOf('0063626851'), ctx(BTC_MAINNET)), [
      '01',
    ])
    expect(
      codes(evaluateScript(scriptOf('0063656851'), ctx(BTC_MAINNET))),
    ).toBe('script-bad-opcode')
    expectStack(evaluateScript(scriptOf('0063c06851'), ctx(BTC_MAINNET)), [
      '01',
    ])
    expect(codes(evaluateScript(scriptOf('c0'), ctx(BTC_MAINNET)))).toBe(
      'script-bad-opcode',
    )
    expect(codes(evaluateScript(scriptOf('c0'), ctx(XEC_MAINNET)))).toBe(
      'script-bad-opcode',
    )
    expect(codes(evaluateScript(scriptOf('c0'), ctx(XPI_MAINNET)))).toBe(
      'script-bad-opcode',
    )
    expect(codes(evaluateScript(scriptOf('515195'), ctx(BCH_MAINNET)))).toBe(
      'script-disabled',
    )
    expect(codes(evaluateScript(scriptOf('ce'), ctx(BCH_MAINNET)))).toBe(
      'script-token',
    )
    expectStack(evaluateScript(scriptOf('0063ba6851'), ctx(BTC_MAINNET)), [
      '01',
    ])
    expect(codes(evaluateScript(scriptOf('ba'), ctx(BTC_MAINNET)))).toBe(
      'script-tapscript',
    )
  })

  test('BCH introspection reads the named input and XPI does not treat 0xc0 as NOP', () => {
    const tx = twoInput()
    expectStack(
      evaluateScript(
        scriptOf('c0'),
        ctx(BCH_MAINNET, { transaction: tx, inputIndex: 1 }),
      ),
      ['01'],
    )
    expectStack(
      evaluateScript(
        scriptOf('00cc'),
        ctx(BCH_MAINNET, { transaction: tx, inputIndex: 0 }),
      ),
      ['09'],
    )
    expect(
      evaluateScript(
        scriptOf('c0'),
        ctx(XPI_MAINNET, { transaction: tx, inputIndex: 0 }),
      ).ok,
    ).toBe(false)
  })

  test('BCH numeric and byte opcodes match the era, including toward-zero division', () => {
    const bch = ctx(BCH_MAINNET)
    expectStack(evaluateScript(scriptOf('016101627e'), bch), ['6162'])
    expectStack(evaluateScript(scriptOf('026162517f'), bch), ['61', '62'])
    expectStack(evaluateScript(scriptOf('026162bc'), bch), ['6261'])
    expectStack(evaluateScript(scriptOf('01ff013c84'), bch), ['3c'])
    expectStack(evaluateScript(scriptOf('01855296'), bch), ['82'])
    expectStack(evaluateScript(scriptOf('01855297'), bch), ['81'])
    expect(codes(evaluateScript(scriptOf('510096'), bch))).toBe('script-div')
    expectStack(evaluateScript(scriptOf('515480'), bch), ['01000000'])
    expectStack(evaluateScript(scriptOf('040100000081'), bch), ['01'])
    expect(codes(evaluateScript(scriptOf('04ffffff7f5193'), bch))).toBe(
      'script-number',
    )
  })

  test('hash opcodes of byte 0x61 match the known digests', () => {
    const btc = ctx(BTC_MAINNET)
    expect(toHex(sha256(Uint8Array.of(0x61)))).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    )
    expect(toHex(ripemd160(sha256(Uint8Array.of(0x61))))).toBe(
      '994355199e516ff76c4fa4aab39337b9d84cf12b',
    )
    expect(toHex(sha1(Uint8Array.of(0x61)))).toBe(
      '86f7e437faa5a7fce15d1ddcb9eaeaea377667b8',
    )
    expectStack(evaluateScript(scriptOf('0161a8'), btc), [
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    ])
    expectStack(evaluateScript(scriptOf('0161a9'), btc), [
      '994355199e516ff76c4fa4aab39337b9d84cf12b',
    ])
    expectStack(evaluateScript(scriptOf('0161a7'), btc), [
      '86f7e437faa5a7fce15d1ddcb9eaeaea377667b8',
    ])
    expectStack(evaluateScript(scriptOf('0161aa'), btc), [
      'bf5d3affb73efd2ec6c36ad3112dd933efed63c4e1cbffcfa88e2759c144f2d8',
    ])
    expectStack(evaluateScript(scriptOf('0161a6'), btc), [
      '0bdc9d2d256b3ee9daae347be6f4dc835a467ffe',
    ])
  })

  test('witness programs fail closed and a bare OP_1 still succeeds', () => {
    const v1 = new Uint8Array(34)
    v1[0] = 0x51
    v1[1] = 32
    expect(codes(verifyScript(new Uint8Array(0), v1, ctx(BTC_MAINNET)))).toBe(
      'script-tapscript',
    )
    const v0 = new Uint8Array(22)
    v0[0] = 0x00
    v0[1] = 20
    expect(codes(verifyScript(new Uint8Array(0), v0, ctx(BTC_MAINNET)))).toBe(
      'script-witness',
    )
    expect(
      verifyScript(new Uint8Array(0), Uint8Array.of(0x51), ctx(BTC_MAINNET)),
    ).toEqual({ ok: true, value: true })
  })

  test('P2SH redeems OP_1 and rejects a witness program hiding in the redeem', () => {
    const redeem = Uint8Array.of(0x51)
    expect(verifyScript(push(redeem), p2sh(redeem), ctx(BTC_MAINNET))).toEqual({
      ok: true,
      value: true,
    })
    const witness = new Uint8Array(22)
    witness[1] = 20
    expect(
      codes(verifyScript(push(witness), p2sh(witness), ctx(BTC_MAINNET))),
    ).toBe('script-witness')
  })

  test('cleanstack requires one true item unless the flag is off', () => {
    expect(
      codes(
        verifyScript(scriptOf('5151'), Uint8Array.of(0x51), ctx(BTC_MAINNET)),
      ),
    ).toBe('script-cleanstack')
    const loose = withRules(BTC_MAINNET, { cleanStack: false })
    expect(
      verifyScript(scriptOf('5151'), Uint8Array.of(0x51), ctx(loose)),
    ).toEqual({ ok: true, value: true })
  })

  test('CSV rejects a disabled or differently typed input sequence', () => {
    const height = scriptOf('51b2')
    const spend = (version: number, sequence: number, script = height) =>
      evaluateScript(
        script,
        ctx(BTC_MAINNET, {
          transaction: { ...oneInput(0, sequence), version },
          inputIndex: 0,
        }),
      )
    expectStack(spend(2, 1), ['01'])
    expect(codes(spend(2, 0))).toBe('script-locktime')
    expect(codes(spend(2, 0xffffffff))).toBe('script-locktime')
    expect(codes(spend(2, 0x80000001))).toBe('script-locktime')
    expect(codes(spend(2, (1 << 22) | 1))).toBe('script-locktime')
    expect(codes(spend(1, 1))).toBe('script-locktime')
    expectStack(spend(2, (1 << 22) | 5, scriptOf('03010040b2')), ['010040'])
    // Wire version is uint32. int32 -1 is bytes ffffffff, which is not < 2.
    // bitcoin/bitcoin interpreter.cpp CheckSequence (BIP112, 93c85d4),
    // bitcoin-cash-node TransactionSignatureChecker::CheckSequence,
    // Bitcoin-ABC GenericTransactionSignatureChecker::CheckSequence, and
    // lotusd src/script/interpreter.cpp CheckSequence all cast nVersion
    // with static_cast<uint32_t> before comparing to 2. A signed `< 2`
    // rejects that version even when sequence 1 satisfies operand 1.
    expectStack(spend(-1, 1), ['01'])
    expectStack(spend(-0x80000000, 1), ['01'])
    const highVersion = parseTransaction(
      fromHex(
        'ffffffff01' +
          '00'.repeat(32) +
          '00000000000100000001' +
          '01000000000000000151' +
          '00000000',
      ),
      XPI_MAINNET,
    )
    if (!highVersion.ok) throw new Error(highVersion.error.code)
    expect(highVersion.value.version).toBe(-1)
    expect(highVersion.value.inputs[0]?.sequence).toBe(1)
    expectStack(
      evaluateScript(
        height,
        ctx(XPI_MAINNET, {
          transaction: highVersion.value,
          inputIndex: 0,
        }),
      ),
      ['01'],
    )
  })

  test('CLTV compares the transaction locktime and rejects a final sequence', () => {
    const script = scriptOf('0164b1')
    const open = oneInput(100, 0)
    expectStack(
      evaluateScript(
        script,
        ctx(BTC_MAINNET, { transaction: open, inputIndex: 0 }),
      ),
      ['64'],
    )
    const final = oneInput(100, 0xffffffff)
    expect(
      codes(
        evaluateScript(
          script,
          ctx(BTC_MAINNET, { transaction: final, inputIndex: 0 }),
        ),
      ),
    ).toBe('script-locktime')
  })

  test('PUSHDATA4 length is an unsigned integer', () => {
    const truncated = Uint8Array.of(0x4e, 0x00, 0x00, 0x00, 0x80)
    expect(codes(evaluateScript(truncated, ctx(BTC_MAINNET)))).toBe(
      'script-encoding',
    )
    const loose = withRules(BTC_MAINNET, { minimalData: false })
    expect(codes(evaluateScript(truncated, ctx(loose)))).toBe('script-encoding')
    const pushed = Uint8Array.of(0x4e, 0x01, 0x00, 0x00, 0x00, 0x61)
    expectStack(evaluateScript(pushed, ctx(loose)), ['61'])
    expect(codes(evaluateScript(pushed, ctx(BTC_MAINNET)))).toBe(
      'script-minimal-data',
    )
  })

  test('unbalanced IF and OP_RETURN fail', () => {
    expect(codes(evaluateScript(scriptOf('5163'), ctx(BTC_MAINNET)))).toBe(
      'script-unbalanced',
    )
    expect(codes(evaluateScript(scriptOf('6a'), ctx(BTC_MAINNET)))).toBe(
      'script-return',
    )
  })

  test('CHECKDATASIG verifies the RFC6979 digest of abc and fail-closes bad signatures', () => {
    const message = Uint8Array.of(0x61, 0x62, 0x63)
    const digest = sha256(message)
    expect(toHex(digest)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const der = fromHex(DER)
    const pub = fromHex(PUB)
    expect(toHex(Uint8Array.from(key.toPublicKey().toBuffer()))).toBe(PUB)
    expect(
      old.crypto.ECDSA.verify(
        Buffer.from(digest),
        old.crypto.Signature.fromDER(Buffer.from(der)),
        key.toPublicKey(),
      ),
    ).toBe(true)
    const program = concat(
      push(der),
      push(message),
      push(pub),
      Uint8Array.of(0xba),
    )
    expectStack(evaluateScript(program, ctx(BCH_MAINNET)), ['01'])
    const r = der.subarray(4, 36)
    const s = bytesToBigint(der.subarray(38, 70))
    const high = derSig(r, derInt(ORDER - s))
    const highProgram = concat(
      push(high),
      push(message),
      push(pub),
      Uint8Array.of(0xba),
    )
    expect(codes(evaluateScript(highProgram, ctx(BCH_MAINNET)))).toBe(
      'script-signature',
    )
    const flipped = der.slice()
    const last = flipped[flipped.length - 1] ?? 0
    flipped[flipped.length - 1] = last + 1
    const bad = concat(
      push(flipped),
      push(message),
      push(pub),
      Uint8Array.of(0xba),
    )
    expect(codes(evaluateScript(bad, ctx(BCH_MAINNET)))).toBe('script-nullfail')
    const loose = withRules(BCH_MAINNET, { nullFail: false })
    expectStack(evaluateScript(bad, ctx(loose)), [''])
    const empty = concat(
      Uint8Array.of(0x00),
      push(message),
      push(pub),
      Uint8Array.of(0xba),
    )
    expectStack(evaluateScript(empty, ctx(BCH_MAINNET)), [''])
  })

  test('CHECKSIG matches a legacy digest and a fork-id digest signed by bitcore', () => {
    const pub = fromHex(PUB)
    const locking = concat(push(pub), Uint8Array.of(0xac))
    const btcTx = oneInput(0, 0xffffffff)
    const btcDigest = mustSighash(btcTx, BTC_MAINNET, 0x01, locking)
    const btcSig = signDigest(btcDigest, 0x01)
    expect(
      verifyScript(
        push(btcSig),
        locking,
        ctx(BTC_MAINNET, {
          transaction: btcTx,
          inputIndex: 0,
        }),
      ),
    ).toEqual({ ok: true, value: true })
    const amount = 50_000n
    const spent: SpentOutput[] = [{ value: amount, scriptPubKey: locking }]
    const bchTx = oneInput(0, 0)
    const bchDigest = mustSighash(
      bchTx,
      BCH_MAINNET,
      0x41,
      locking,
      amount,
      spent,
    )
    const bchSig = signDigest(bchDigest, 0x41)
    expect(
      verifyScript(
        push(bchSig),
        locking,
        ctx(BCH_MAINNET, {
          transaction: bchTx,
          inputIndex: 0,
          spent,
        }),
      ),
    ).toEqual({ ok: true, value: true })
    const multisig = concat(
      Uint8Array.of(0x51),
      push(pub),
      Uint8Array.of(0x51, 0xae),
    )
    const multiDigest = mustSighash(btcTx, BTC_MAINNET, 0x01, multisig)
    const multiSig = signDigest(multiDigest, 0x01)
    expect(
      verifyScript(
        concat(Uint8Array.of(0x00), push(multiSig)),
        multisig,
        ctx(BTC_MAINNET, {
          transaction: btcTx,
          inputIndex: 0,
        }),
      ),
    ).toEqual({ ok: true, value: true })
  })

  test('lotus CHECKSIG commits the executed script the way lotusd VerifyScript does', () => {
    // lotusd src/script/interpreter.cpp VerifyScript builds
    // ScriptExecutionData{scriptPubKey} (P2SH uses the redeem script).
    // script_exec_data.h hashes that whole script with CHash256 and starts
    // codeseparator at 0xffffffff. EvalChecksig always passes that execdata,
    // so SignatureHashLotus sets ext_flag. sighash_lotus.json row
    // "1->2 Lotus sighash ALL" is the same preimage (script OP_3, codesep
    // 4294967295). A matching script must not drop the extension.
    const pub = fromHex(PUB)
    const hashType = SIGHASH_LOTUS | SIGHASH_ALL
    const locking = concat(push(pub), Uint8Array.of(0xac))
    const tx = oneInput(0, 0xffffffff)
    const amount = 50_000n
    const spent: SpentOutput[] = [{ value: amount, scriptPubKey: locking }]
    const executed = sha256(sha256(locking))
    const consensus = sighash(tx, 0, XPI_MAINNET, hashType, {
      algorithm: 'lotus',
      scriptCode: locking,
      amount,
      spent,
      commitUtxos: false,
      executedScriptHash: executed,
      codeSeparatorPosition: 0xffffffff,
    })
    const bare = sighash(tx, 0, XPI_MAINNET, hashType, {
      algorithm: 'lotus',
      scriptCode: locking,
      amount,
      spent,
      commitUtxos: false,
    })
    if (!consensus.ok || !bare.ok) throw new Error('digest')
    expect(toHex(consensus.value)).not.toBe(toHex(bare.value))
    const sig = signDigest(consensus.value, hashType)
    expect(
      verifyScript(
        push(sig),
        locking,
        ctx(XPI_MAINNET, { transaction: tx, inputIndex: 0, spent }),
      ),
    ).toEqual({ ok: true, value: true })
    expect(
      codes(
        verifyScript(
          push(signDigest(bare.value, hashType)),
          locking,
          ctx(XPI_MAINNET, { transaction: tx, inputIndex: 0, spent }),
        ),
      ),
    ).not.toBe('ok')

    // OP_CODESEPARATOR is instruction 0. The byte offset after it is 1.
    // lotusd stores opcode_pos, not that byte offset, and still hashes the
    // whole script (interpreter.cpp OP_CODESEPARATOR).
    const separated = concat(
      Uint8Array.of(0xab),
      push(pub),
      Uint8Array.of(0xac),
    )
    const separatedSpent: SpentOutput[] = [
      { value: amount, scriptPubKey: separated },
    ]
    const separatedDigest = sighash(tx, 0, XPI_MAINNET, hashType, {
      algorithm: 'lotus',
      scriptCode: separated,
      amount,
      spent: separatedSpent,
      commitUtxos: false,
      executedScriptHash: sha256(sha256(separated)),
      codeSeparatorPosition: 0,
    })
    if (!separatedDigest.ok) throw new Error(separatedDigest.error.code)
    expect(
      verifyScript(
        push(signDigest(separatedDigest.value, hashType)),
        separated,
        ctx(XPI_MAINNET, {
          transaction: tx,
          inputIndex: 0,
          spent: separatedSpent,
        }),
      ),
    ).toEqual({ ok: true, value: true })
    const byteOffset = sighash(tx, 0, XPI_MAINNET, hashType, {
      algorithm: 'lotus',
      scriptCode: separated,
      amount,
      spent: separatedSpent,
      commitUtxos: false,
      executedScriptHash: sha256(sha256(separated)),
      codeSeparatorPosition: 1,
    })
    if (!byteOffset.ok) throw new Error(byteOffset.error.code)
    expect(
      codes(
        verifyScript(
          push(signDigest(byteOffset.value, hashType)),
          separated,
          ctx(XPI_MAINNET, {
            transaction: tx,
            inputIndex: 0,
            spent: separatedSpent,
          }),
        ),
      ),
    ).not.toBe('ok')

    // A separator in a false branch is not executed, so the position stays
    // 0xffffffff. lotusd only assigns m_codeseparator_pos inside fExec.
    const skipped = concat(
      Uint8Array.of(0x00, 0x63, 0xab, 0x68),
      push(pub),
      Uint8Array.of(0xac),
    )
    const skippedSpent: SpentOutput[] = [
      { value: amount, scriptPubKey: skipped },
    ]
    const skippedDigest = sighash(tx, 0, XPI_MAINNET, hashType, {
      algorithm: 'lotus',
      scriptCode: skipped,
      amount,
      spent: skippedSpent,
      commitUtxos: false,
      executedScriptHash: sha256(sha256(skipped)),
      codeSeparatorPosition: 0xffffffff,
    })
    if (!skippedDigest.ok) throw new Error(skippedDigest.error.code)
    expect(
      verifyScript(
        push(signDigest(skippedDigest.value, hashType)),
        skipped,
        ctx(XPI_MAINNET, {
          transaction: tx,
          inputIndex: 0,
          spent: skippedSpent,
        }),
      ),
    ).toEqual({ ok: true, value: true })

    const redeem = locking
    const p2shLock = p2sh(redeem)
    const p2shSpent: SpentOutput[] = [{ value: amount, scriptPubKey: p2shLock }]
    const redeemDigest = sighash(tx, 0, XPI_MAINNET, hashType, {
      algorithm: 'lotus',
      scriptCode: redeem,
      amount,
      spent: p2shSpent,
      commitUtxos: false,
      executedScriptHash: sha256(sha256(redeem)),
      codeSeparatorPosition: 0xffffffff,
    })
    if (!redeemDigest.ok) throw new Error(redeemDigest.error.code)
    expect(
      verifyScript(
        concat(push(signDigest(redeemDigest.value, hashType)), push(redeem)),
        p2shLock,
        ctx(XPI_MAINNET, {
          transaction: tx,
          inputIndex: 0,
          spent: p2shSpent,
        }),
      ),
    ).toEqual({ ok: true, value: true })
  })

  test('a lotus CHECKSIG without a transaction is script-spent, and Schnorr fails closed', () => {
    const pub = fromHex(PUB)
    const sig = concat(fromHex(DER), Uint8Array.of(0x61))
    const program = concat(push(sig), push(pub), Uint8Array.of(0xac))
    expect(codes(evaluateScript(program, ctx(XPI_MAINNET)))).toBe(
      'script-spent',
    )
    const schnorr = new Uint8Array(64)
    schnorr.fill(0x11)
    const schnorrScript = concat(push(schnorr), push(pub), Uint8Array.of(0xac))
    expect(codes(evaluateScript(schnorrScript, ctx(BCH_MAINNET)))).toBe(
      'script-schnorr',
    )
  })
})
