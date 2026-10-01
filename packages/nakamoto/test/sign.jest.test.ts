import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'

import { Buffer } from 'buffer'

import { ripemd160 } from '@noble/hashes/ripemd160.js'
import { sha256 } from '@noble/hashes/sha256.js'

import { BCH_MAINNET, BTC_MAINNET, XPI_MAINNET } from '../src/chain/index.js'
import { internalHashFromBytes } from '../src/constructors.js'
import {
  isSignError,
  signAll,
  signInput,
  type InputSigner,
  type SignOptions,
} from '../src/sign.js'
import {
  SIGHASH_ALL,
  SIGHASH_FORKID,
  SIGHASH_LOTUS,
  SIGHASH_UTXOS,
  parseTransaction,
  serializeTransaction,
  sighash,
  type SpentOutput,
  type Transaction,
} from '../src/transaction.js'

interface OldHalfSigned {
  inputs: { isFullySigned(): boolean }[]
  isFullySigned(): boolean
}

const load = createRequire(__filename)
const old = load('bitcore-lib-xpi') as {
  Networks: { livenet: object }
  PrivateKey: new (data: {
    bn: string
    network: object
    compressed: boolean
  }) => {
    toPublicKey(): { toBuffer(): Buffer; toAddress(): object }
    toAddress(): object
  }
  Script: {
    buildPublicKeyHashOut(key: object): { toBuffer(): Buffer }
  }
  Transaction: new () => {
    from(utxo: unknown): {
      to(
        address: object,
        satoshis: number,
      ): {
        sign(key: unknown): OldHalfSigned
      }
    }
  }
}

const PUB_A =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PUB_B =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81799'
const DER = '3006020101020101'
const FORKID_ALL = SIGHASH_ALL | SIGHASH_FORKID

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

function hash160(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(ripemd160(sha256(bytes)))
}

function p2pkh(hash: Uint8Array): Uint8Array {
  const out = new Uint8Array(25)
  out[0] = 0x76
  out[1] = 0xa9
  out[2] = 20
  out.set(hash, 3)
  out[23] = 0x88
  out[24] = 0xac
  return out
}

function p2pk(publicKey: Uint8Array): Uint8Array {
  const out = new Uint8Array(publicKey.length + 2)
  out[0] = publicKey.length
  out.set(publicKey, 1)
  out[publicKey.length + 1] = 0xac
  return out
}

function p2wpkh(hash: Uint8Array): Uint8Array {
  const out = new Uint8Array(22)
  out[0] = 0x00
  out[1] = 20
  out.set(hash, 2)
  return out
}

function p2tr(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(34)
  out[0] = 0x51
  out[1] = 32
  out.set(key, 2)
  return out
}

function p2sh(hash: Uint8Array): Uint8Array {
  const out = new Uint8Array(23)
  out[0] = 0xa9
  out[1] = 20
  out.set(hash, 2)
  out[22] = 0x87
  return out
}

function txid(byte: number) {
  const raw = new Uint8Array(32)
  raw[31] = byte
  const branded = internalHashFromBytes(raw)
  if (!branded.ok) throw new Error(branded.error.code)
  return branded.value
}

function input(byte: number, vout: number) {
  return {
    prevout: { txid: txid(byte), vout },
    scriptSig: new Uint8Array(),
    sequence: 0xffffffff,
  }
}

function transaction(scripts: readonly Uint8Array[]): Transaction {
  return {
    version: 2,
    inputs: scripts.map((_, index) => input(index + 1, index)),
    outputs: [{ value: 1000n, scriptPubKey: scripts[0] ?? new Uint8Array() }],
    locktime: 0,
  }
}

function spent(scripts: readonly Uint8Array[]): SpentOutput[] {
  return scripts.map((scriptPubKey, index) => ({
    value: 5000n + BigInt(index),
    scriptPubKey,
  }))
}

function recorder(
  publicKey: Uint8Array,
  signature: Uint8Array,
): InputSigner & { readonly calls: Uint8Array[] } {
  const calls: Uint8Array[] = []
  return {
    publicKey,
    calls,
    sign(digest) {
      calls.push(digest)
      return signature
    },
  }
}

function options(
  chain: typeof BCH_MAINNET,
  algorithm: SignOptions['algorithm'],
  sighashType: number,
  outputs: readonly SpentOutput[],
  extra: Partial<SignOptions> = {},
): SignOptions {
  return {
    chain,
    algorithm,
    sighashType,
    spent: outputs,
    ...extra,
  }
}

const pubA = fromHex(PUB_A)
const pubB = fromHex(PUB_B)
const hashA = hash160(pubA)
const hashB = hash160(pubB)
const der = fromHex(DER)

describe('explicit signing', () => {
  test('the source does not default to ALL|FORKID', () => {
    const source = readFileSync(join(__dirname, '../src/sign.ts'), 'utf8')
    expect(source).not.toContain('SIGHASH_ALL |')
    expect(source).not.toContain('| SIGHASH_FORKID')
    expect(source).not.toContain('0x41')
  })

  test('a matching p2pkh key signs only the named input', () => {
    const scripts = [p2pkh(hashA), p2pkh(hashB)]
    const tx = transaction(scripts)
    const coins = spent(scripts)
    const signer = recorder(pubA, der)
    const sighashType = FORKID_ALL
    const signed = signInput(
      tx,
      0,
      signer,
      options(BCH_MAINNET, 'forkid', sighashType, coins),
    )
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    expect(signed.value.inputIndex).toBe(0)
    expect(signed.value.unsigned).toEqual([1])
    expect(signer.calls).toHaveLength(1)
    const expected = sighash(tx, 0, BCH_MAINNET, sighashType, {
      algorithm: 'forkid',
      scriptCode: scripts[0],
      amount: coins[0]?.value,
      spent: coins,
    })
    if (!expected.ok) throw new Error(expected.error.code)
    expect(toHex(signer.calls[0] ?? new Uint8Array())).toBe(
      toHex(expected.value),
    )
    const scriptSig = signed.value.scriptSig
    expect(scriptSig[0]).toBe(der.length + 1)
    expect(toHex(scriptSig.subarray(1, 1 + der.length))).toBe(DER)
    expect(scriptSig[1 + der.length]).toBe(sighashType)
    expect(scriptSig[der.length + 2]).toBe(pubA.length)
    expect(toHex(scriptSig.subarray(der.length + 3))).toBe(PUB_A)
    expect(signed.value.witness).toBeNull()
    expect(signed.value.transaction.inputs[1]).toBe(tx.inputs[1])
    expect(tx.inputs[0]?.scriptSig).toHaveLength(0)
    const raw = serializeTransaction(signed.value.transaction, BCH_MAINNET)
    if (!raw.ok) throw new Error(raw.error.code)
    const parsed = parseTransaction(raw.value, BCH_MAINNET)
    if (!parsed.ok) throw new Error(parsed.error.code)
    expect(toHex(parsed.value.inputs[0]?.scriptSig ?? new Uint8Array())).toBe(
      toHex(scriptSig),
    )
  })

  test('sighash type 0 is kept and is not rewritten to ALL|FORKID', () => {
    const scripts = [p2pkh(hashA)]
    const tx = transaction(scripts)
    const coins = spent(scripts)
    const signer = recorder(pubA, der)
    const signed = signInput(
      tx,
      0,
      signer,
      options(BTC_MAINNET, 'legacy', 0, coins),
    )
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    expect(signed.value.scriptSig[1 + der.length]).toBe(0)
    expect(signed.value.unsigned).toEqual([])
    const asZero = sighash(tx, 0, BTC_MAINNET, 0, {
      algorithm: 'legacy',
      scriptCode: scripts[0],
      amount: coins[0]?.value,
      spent: coins,
    })
    const asFork = sighash(tx, 0, BTC_MAINNET, FORKID_ALL, {
      algorithm: 'legacy',
      scriptCode: scripts[0],
      amount: coins[0]?.value,
      spent: coins,
    })
    if (!asZero.ok || !asFork.ok) throw new Error('digest')
    expect(toHex(signer.calls[0] ?? new Uint8Array())).toBe(toHex(asZero.value))
    expect(toHex(asZero.value)).not.toBe(toHex(asFork.value))
  })

  test('a missing sighash type is an error and does not sign', () => {
    const scripts = [p2pkh(hashA)]
    const tx = transaction(scripts)
    const signer = recorder(pubA, der)
    const bare = {
      ...options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
      sighashType: undefined,
    } as unknown as SignOptions
    const signed = signInput(tx, 0, signer, bare)
    expect(signed).toEqual({
      ok: false,
      error: { code: 'sign-sighash-required' },
    })
    expect(signer.calls).toHaveLength(0)
    expect(isSignError(signed.ok ? null : signed.error)).toBe(true)
  })

  test('a missing algorithm is an error and does not sign', () => {
    const scripts = [p2pkh(hashA)]
    const signer = recorder(pubA, der)
    const bare = {
      ...options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
      algorithm: undefined,
    } as unknown as SignOptions
    const signed = signInput(transaction(scripts), 0, signer, bare)
    expect(signed).toEqual({
      ok: false,
      error: { code: 'sign-algorithm-required' },
    })
    expect(signer.calls).toHaveLength(0)
  })

  test('a pubkey that misses the previous script is not an empty signature', () => {
    const scripts = [p2pkh(hashA)]
    const tx = transaction(scripts)
    const signer = recorder(pubB, der)
    const signed = signInput(
      tx,
      0,
      signer,
      options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
    )
    expect(signed.ok).toBe(false)
    if (signed.ok) return
    expect(signed.error.code).toBe('sign-pubkey-mismatch')
    expect(signed).not.toHaveProperty('value')
    expect(signer.calls).toHaveLength(0)
    expect(tx.inputs[0]?.scriptSig).toHaveLength(0)
  })

  test('p2pkh with a witness algorithm is rejected on BTC', () => {
    const scripts = [p2pkh(hashA)]
    const signer = recorder(pubA, der)
    const signed = signInput(
      transaction(scripts),
      0,
      signer,
      options(BTC_MAINNET, 'bip143', SIGHASH_ALL, spent(scripts)),
    )
    expect(signed).toEqual({ ok: false, error: { code: 'sign-algorithm' } })
    expect(signer.calls).toHaveLength(0)
  })

  test('an unsupported script is not signed', () => {
    const scripts = [p2sh(hashA)]
    const signer = recorder(pubA, der)
    const signed = signInput(
      transaction(scripts),
      0,
      signer,
      options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
    )
    expect(signed).toEqual({
      ok: false,
      error: { code: 'sign-script-unsupported' },
    })
    expect(signer.calls).toHaveLength(0)
  })

  test('an empty signature is not attached', () => {
    const scripts = [p2pkh(hashA)]
    const signer = recorder(pubA, new Uint8Array())
    const signed = signInput(
      transaction(scripts),
      0,
      signer,
      options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
    )
    expect(signed).toEqual({ ok: false, error: { code: 'sign-signature' } })
    expect(signer.calls).toHaveLength(1)
    expect(signed.ok ? null : signed).not.toHaveProperty('value')
  })

  test('an ecdsa body longer than 72 bytes is not attached', () => {
    const scripts = [p2pkh(hashA)]
    const coins = spent(scripts)
    const tooLong = new Uint8Array(73)
    tooLong[0] = 0x30
    const rejected = signInput(
      transaction(scripts),
      0,
      recorder(pubA, tooLong),
      options(BTC_MAINNET, 'legacy', SIGHASH_ALL, coins),
    )
    expect(rejected).toEqual({ ok: false, error: { code: 'sign-signature' } })
    expect(rejected.ok ? null : rejected).not.toHaveProperty('value')

    const body = new Uint8Array(72)
    body[0] = 0x30
    const accepted = signInput(
      transaction(scripts),
      0,
      recorder(pubA, body),
      options(BTC_MAINNET, 'legacy', SIGHASH_ALL, coins),
    )
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.value.scriptSig[0]).toBe(73)
    expect(accepted.value.scriptSig[73]).toBe(SIGHASH_ALL)
  })

  test('two inputs and one key do not look like success', () => {
    const key = new old.PrivateKey({
      bn: '11'.repeat(32),
      network: old.Networks.livenet,
      compressed: true,
    })
    const other = new old.PrivateKey({
      bn: '22'.repeat(32),
      network: old.Networks.livenet,
      compressed: true,
    })
    const legacy = new old.Transaction().from([
      {
        txId: '11'.repeat(32),
        outputIndex: 0,
        satoshis: 5000,
        script: old.Script.buildPublicKeyHashOut(key.toPublicKey()),
      },
      {
        txId: '22'.repeat(32),
        outputIndex: 1,
        satoshis: 6000,
        script: old.Script.buildPublicKeyHashOut(other.toPublicKey()),
      },
    ])
    const signed = legacy.to(key.toAddress(), 1000).sign(key)
    expect(signed.inputs[0]?.isFullySigned()).toBe(true)
    expect(signed.inputs[1]?.isFullySigned()).toBe(false)
    expect(signed.isFullySigned()).toBe(false)

    const scripts = [p2pkh(hashA), p2pkh(hashB)]
    const tx = transaction(scripts)
    const signer = recorder(pubA, der)
    const partial = signAll(
      tx,
      [{ inputIndex: 0, signer }],
      options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
    )
    expect(partial.ok).toBe(false)
    if (partial.ok) return
    expect(partial.error).toEqual({
      code: 'sign-partial',
      missing: [1],
      inputs: [
        { index: 0, status: 'matched' },
        { index: 1, status: 'unassigned' },
      ],
    })
    expect(partial).not.toHaveProperty('value')
    expect(JSON.stringify(partial)).not.toContain('transaction')
    expect(signer.calls).toHaveLength(0)
    expect(isSignError(partial.error)).toBe(true)
  })

  test('signAll signs every assigned input and no others', () => {
    const scripts = [p2pkh(hashA), p2pk(pubB)]
    const tx = transaction(scripts)
    const first = recorder(pubA, der)
    const second = recorder(pubB, der)
    const signed = signAll(
      tx,
      [
        { inputIndex: 1, signer: second },
        { inputIndex: 0, signer: first },
      ],
      options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
    )
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(1)
    expect(signed.value.inputs).toHaveLength(2)
    expect(
      signed.value.transaction.inputs[0]?.scriptSig.length,
    ).toBeGreaterThan(0)
    expect(signed.value.transaction.inputs[1]?.scriptSig[0]).toBe(
      der.length + 1,
    )
    expect(signed.value.transaction.inputs[1]?.scriptSig).toHaveLength(
      der.length + 2,
    )
    const raw = serializeTransaction(signed.value.transaction, BCH_MAINNET)
    if (!raw.ok) throw new Error(raw.error.code)
    const parsed = parseTransaction(raw.value, BCH_MAINNET)
    expect(parsed.ok).toBe(true)
  })

  test('a mismatched assignment does not sign the input that did match', () => {
    const scripts = [p2pkh(hashA), p2pkh(hashB)]
    const signer = recorder(pubA, der)
    const wrong = recorder(pubA, der)
    const signed = signAll(
      transaction(scripts),
      [
        { inputIndex: 0, signer },
        { inputIndex: 1, signer: wrong },
      ],
      options(BCH_MAINNET, 'forkid', FORKID_ALL, spent(scripts)),
    )
    expect(signed.ok).toBe(false)
    if (signed.ok) return
    expect(signed.error.code).toBe('sign-pubkey-mismatch')
    expect(signer.calls).toHaveLength(0)
    expect(wrong.calls).toHaveLength(0)
    expect(signed).not.toHaveProperty('value')
  })

  test('duplicate and out-of-range assignments are errors', () => {
    const scripts = [p2pkh(hashA)]
    const signer = recorder(pubA, der)
    const coins = spent(scripts)
    const tx = transaction(scripts)
    const duplicate = signAll(
      tx,
      [
        { inputIndex: 0, signer },
        { inputIndex: 0, signer },
      ],
      options(BCH_MAINNET, 'forkid', FORKID_ALL, coins),
    )
    expect(duplicate).toEqual({ ok: false, error: { code: 'sign-assignment' } })
    const range = signAll(
      tx,
      [{ inputIndex: 3, signer }],
      options(BCH_MAINNET, 'forkid', FORKID_ALL, coins),
    )
    expect(range).toEqual({ ok: false, error: { code: 'sign-index' } })
    expect(signer.calls).toHaveLength(0)
  })

  test('p2wpkh uses bip143 and puts the signature in the witness', () => {
    const scripts = [p2wpkh(hashA)]
    const tx = transaction(scripts)
    const coins = spent(scripts)
    const signer = recorder(pubA, der)
    const signed = signInput(
      tx,
      0,
      signer,
      options(BTC_MAINNET, 'bip143', SIGHASH_ALL, coins),
    )
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    expect(signed.value.scriptSig).toHaveLength(0)
    expect(signed.value.witness).toHaveLength(2)
    expect(signed.value.witness?.[1] && toHex(signed.value.witness[1])).toBe(
      PUB_A,
    )
    expect(signed.value.witness?.[0]?.[der.length]).toBe(SIGHASH_ALL)
    const expected = sighash(tx, 0, BTC_MAINNET, SIGHASH_ALL, {
      algorithm: 'bip143',
      scriptCode: p2pkh(hashA),
      amount: coins[0]?.value,
      spent: coins,
    })
    if (!expected.ok) throw new Error(expected.error.code)
    expect(toHex(signer.calls[0] ?? new Uint8Array())).toBe(
      toHex(expected.value),
    )
    const raw = serializeTransaction(signed.value.transaction, BTC_MAINNET)
    if (!raw.ok) throw new Error(raw.error.code)
    expect(raw.value[4]).toBe(0x00)
    expect(raw.value[5]).toBe(0x01)
  })

  test('p2tr default keeps a 64-byte witness and type 1 appends the byte', () => {
    const key = pubA.subarray(1)
    const scripts = [p2tr(key)]
    const tx = transaction(scripts)
    const coins = spent(scripts)
    const schnorr = new Uint8Array(64).fill(0x11)
    const plain = recorder(key, schnorr)
    const def = signInput(
      tx,
      0,
      plain,
      options(BTC_MAINNET, 'bip341', 0, coins),
    )
    expect(def.ok).toBe(true)
    if (!def.ok) return
    expect(def.value.witness?.[0]?.length).toBe(64)
    expect(toHex(def.value.witness?.[0] ?? new Uint8Array())).toBe(
      toHex(schnorr),
    )
    const typed = recorder(key, schnorr)
    const all = signInput(
      tx,
      0,
      typed,
      options(BTC_MAINNET, 'bip341', SIGHASH_ALL, coins),
    )
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.value.witness?.[0]?.length).toBe(65)
    expect(all.value.witness?.[0]?.[64]).toBe(SIGHASH_ALL)
    const expected = sighash(tx, 0, BTC_MAINNET, 0, {
      algorithm: 'bip341',
      spent: coins,
    })
    if (!expected.ok) throw new Error(expected.error.code)
    expect(toHex(plain.calls[0] ?? new Uint8Array())).toBe(
      toHex(expected.value),
    )
  })

  test('lotus p2pkh matches lotusd VerifyScript executed-script commitment', () => {
    // lotusd src/test/data/sighash_lotus.json row "1->2 Lotus sighash ALL":
    // script OP_3, codeseparator 0xffffffff, CHash256 preimage.
    const script = Uint8Array.of(0x53)
    const raw = fromHex(
      '01000000010123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0000000000ffffffff02ffff0000000000000151ffffff0000000000015200000000',
    )
    const parsed = parseTransaction(raw, XPI_MAINNET)
    if (!parsed.ok) throw new Error(parsed.error.code)
    const executed = new Uint8Array(sha256(sha256(script)))
    const vector = sighash(
      parsed.value,
      0,
      XPI_MAINNET,
      SIGHASH_LOTUS | SIGHASH_ALL,
      {
        algorithm: 'lotus',
        spent: [{ value: 1245n, scriptPubKey: script }],
        executedScriptHash: executed,
        codeSeparatorPosition: 0xffffffff,
      },
    )
    if (!vector.ok) throw new Error(vector.error.code)
    expect(toHex(vector.value)).toBe(
      '75eb0eea1ee2fcd6fccd7a340ef4d0928d82b8e741a04b9fd94039254639aa21',
    )

    const scripts = [p2pkh(hashA)]
    const tx = transaction(scripts)
    const coins = spent(scripts)
    const sighashType = SIGHASH_LOTUS | SIGHASH_ALL
    const signer = recorder(pubA, der)
    const signed = signInput(
      tx,
      0,
      signer,
      options(XPI_MAINNET, 'lotus', sighashType, coins),
    )
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    const scriptCode = scripts[0] as Uint8Array
    const consensus = sighash(tx, 0, XPI_MAINNET, sighashType, {
      algorithm: 'lotus',
      spent: coins,
      executedScriptHash: new Uint8Array(sha256(sha256(scriptCode))),
      codeSeparatorPosition: 0xffffffff,
    })
    const bare = sighash(tx, 0, XPI_MAINNET, sighashType, {
      algorithm: 'lotus',
      spent: coins,
    })
    if (!consensus.ok || !bare.ok) throw new Error('digest')
    expect(toHex(consensus.value)).not.toBe(toHex(bare.value))
    expect(toHex(signer.calls[0] ?? new Uint8Array())).toBe(
      toHex(consensus.value),
    )
  })

  test('lotus uses the explicit lotus type and the spent output', () => {
    const scripts = [p2pkh(hashA)]
    const tx = transaction(scripts)
    const coins = spent(scripts)
    const sighashType = SIGHASH_LOTUS | SIGHASH_ALL
    const signer = recorder(pubA, der)
    const signed = signInput(
      tx,
      0,
      signer,
      options(XPI_MAINNET, 'lotus', sighashType, coins),
    )
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    const expected = sighash(tx, 0, XPI_MAINNET, sighashType, {
      algorithm: 'lotus',
      spent: coins,
      executedScriptHash: new Uint8Array(
        sha256(sha256(scripts[0] as Uint8Array)),
      ),
      codeSeparatorPosition: 0xffffffff,
    })
    if (!expected.ok) throw new Error(expected.error.code)
    expect(toHex(signer.calls[0] ?? new Uint8Array())).toBe(
      toHex(expected.value),
    )
    const plainSigner = recorder(pubA, der)
    const plain = signInput(
      tx,
      0,
      plainSigner,
      options(XPI_MAINNET, 'forkid', FORKID_ALL, coins),
    )
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    const plainDigest = sighash(tx, 0, XPI_MAINNET, FORKID_ALL, {
      algorithm: 'forkid',
      scriptCode: scripts[0],
      amount: coins[0]?.value,
      spent: coins,
    })
    if (!plainDigest.ok) throw new Error(plainDigest.error.code)
    expect(toHex(plainSigner.calls[0] ?? new Uint8Array())).toBe(
      toHex(plainDigest.value),
    )
    const replaySigner = recorder(pubA, der)
    const replay = signInput(
      tx,
      0,
      replaySigner,
      options(XPI_MAINNET, 'forkid', FORKID_ALL, coins, {
        replayProtection: true,
      }),
    )
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    const replayDigest = sighash(tx, 0, XPI_MAINNET, FORKID_ALL, {
      algorithm: 'forkid',
      scriptCode: scripts[0],
      amount: coins[0]?.value,
      spent: coins,
      replayProtection: true,
    })
    if (!replayDigest.ok) throw new Error(replayDigest.error.code)
    expect(toHex(replaySigner.calls[0] ?? new Uint8Array())).toBe(
      toHex(replayDigest.value),
    )
    expect(toHex(replayDigest.value)).not.toBe(toHex(plainDigest.value))
  })

  test('BCH commitUtxos is passed through to the digest', () => {
    const scripts = [p2pkh(hashA)]
    const tx = transaction(scripts)
    const coins = spent(scripts)
    const sighashType = SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID
    const signer = recorder(pubA, der)
    const signed = signInput(
      tx,
      0,
      signer,
      options(BCH_MAINNET, 'forkid', sighashType, coins, { commitUtxos: true }),
    )
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    const expected = sighash(tx, 0, BCH_MAINNET, sighashType, {
      algorithm: 'forkid',
      scriptCode: scripts[0],
      amount: coins[0]?.value,
      spent: coins,
      commitUtxos: true,
    })
    const dropped = sighash(tx, 0, BCH_MAINNET, sighashType, {
      algorithm: 'forkid',
      scriptCode: scripts[0],
      amount: coins[0]?.value,
      spent: coins,
    })
    if (!expected.ok || !dropped.ok) throw new Error('digest')
    expect(toHex(signer.calls[0] ?? new Uint8Array())).toBe(
      toHex(expected.value),
    )
    expect(toHex(expected.value)).not.toBe(toHex(dropped.value))
  })

  test('a tapleaf request is unsupported and does not sign', () => {
    const scripts = [p2tr(pubA.subarray(1))]
    const signer = recorder(pubA.subarray(1), new Uint8Array(64))
    const signed = signInput(
      transaction(scripts),
      0,
      signer,
      options(BTC_MAINNET, 'bip341', 0, spent(scripts), {
        tapleafHash: new Uint8Array(32),
      }),
    )
    expect(signed).toEqual({
      ok: false,
      error: { code: 'sign-script-unsupported' },
    })
    expect(signer.calls).toHaveLength(0)
  })

  test('spent outputs must cover every input', () => {
    const scripts = [p2pkh(hashA), p2pkh(hashB)]
    const signer = recorder(pubA, der)
    const signed = signInput(
      transaction(scripts),
      0,
      signer,
      options(
        BCH_MAINNET,
        'forkid',
        FORKID_ALL,
        spent([scripts[0] as Uint8Array]),
      ),
    )
    expect(signed).toEqual({ ok: false, error: { code: 'sign-spent' } })
    expect(signer.calls).toHaveLength(0)
  })
})
