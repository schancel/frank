// BIP-174 Partially Signed Bitcoin Transaction (PSBT v0) codec, signing,
// finalization, and extraction.

import { decodeAddress } from './address.js'
import { cryptoBackend } from './backend.js'
import {
  concatBytes,
  copyBytes,
  decodeUnsignedLE,
  encodeUnsignedLE,
  isPlainBytes,
} from './bytes.js'
import { BTC_MAINNET } from './chain/btc.js'
import type { ChainDescriptor } from './chain/types.js'
import { ecdsaSignatureFromBytes } from './constructors.js'
import { ByteReader, ByteWriter } from './reader.js'
import type { SigningKey } from './signing-key.js'
import {
  SIGHASH_ALL,
  SIGHASH_FORKID,
  parseTransaction,
  serializeTransaction,
  sighash,
  transactionId,
  type SighashAlgorithm,
  type SpentOutput,
  type Transaction,
  type TxInput,
} from './transaction.js'

const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff)

export const PSBT_GLOBAL_UNSIGNED_TX = 0x00

export const PSBT_IN_NON_WITNESS_UTXO = 0x00
export const PSBT_IN_WITNESS_UTXO = 0x01
export const PSBT_IN_PARTIAL_SIG = 0x02
export const PSBT_IN_SIGHASH_TYPE = 0x03
export const PSBT_IN_REDEEM_SCRIPT = 0x04
export const PSBT_IN_WITNESS_SCRIPT = 0x05
export const PSBT_IN_BIP32_DERIVATION = 0x06
export const PSBT_IN_FINAL_SCRIPTSIG = 0x07
export const PSBT_IN_FINAL_SCRIPTWITNESS = 0x08
export const PSBT_IN_TAP_KEY_SIG = 0x13

const OP_0 = 0x00
const OP_DUP = 0x76
const OP_HASH160 = 0xa9
const OP_EQUALVERIFY = 0x88
const OP_CHECKSIG = 0xac
const ECDSA_BODY_MAX = 72

export interface PsbtKeyValue {
  readonly keyType: number
  readonly keyData: Uint8Array
  readonly value: Uint8Array
}

export interface PsbtWitnessUtxo {
  readonly value: bigint
  readonly script: Uint8Array
}

export interface PsbtInput {
  readonly nonWitnessUtxo?: Transaction
  readonly nonWitnessUtxoBytes?: Uint8Array
  readonly witnessUtxo?: PsbtWitnessUtxo
  readonly partialSigs: ReadonlyArray<readonly [Uint8Array, Uint8Array]>
  readonly sighashType?: number
  readonly redeemScript?: Uint8Array
  readonly witnessScript?: Uint8Array
  readonly bip32Derivations: ReadonlyArray<readonly [Uint8Array, Uint8Array]>
  readonly finalScriptSig?: Uint8Array
  readonly finalScriptWitness?: Uint8Array
  readonly tapKeySig?: Uint8Array
  readonly unknownKeyVals: readonly PsbtKeyValue[]
}

export interface PsbtOutput {
  readonly unknownKeyVals: readonly PsbtKeyValue[]
}

export interface Psbt {
  readonly unsignedTx: Transaction
  readonly inputs: readonly PsbtInput[]
  readonly outputs: readonly PsbtOutput[]
  readonly globalUnknownKeyVals: readonly PsbtKeyValue[]
}

export interface PsbtToSignInput {
  readonly index: number
  readonly publicKeyHex?: string
  readonly address?: string
  readonly sighashTypes?: readonly number[]
}

export interface SignPsbtOptions {
  readonly toSignInputs?: readonly PsbtToSignInput[]
  readonly autoFinalized?: boolean
  readonly chain?: ChainDescriptor
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

function hexToBytes(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 2 !== 0) return null
  if (!/^[0-9a-fA-F]+$/.test(text)) return null
  const out = new Uint8Array(text.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    const byte = parseInt(text.slice(index * 2, index * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[index] = byte
  }
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  let index = 0
  while (index < bytes.length) {
    const b0 = bytes[index] ?? 0
    const has1 = index + 1 < bytes.length
    const has2 = index + 2 < bytes.length
    const b1 = has1 ? bytes[index + 1] ?? 0 : 0
    const b2 = has2 ? bytes[index + 2] ?? 0 : 0
    const triplet = (b0 << 16) | (b1 << 8) | b2
    out += BASE64_ALPHABET.charAt((triplet >> 18) & 0x3f)
    out += BASE64_ALPHABET.charAt((triplet >> 12) & 0x3f)
    out += has1 ? BASE64_ALPHABET.charAt((triplet >> 6) & 0x3f) : '='
    out += has2 ? BASE64_ALPHABET.charAt(triplet & 0x3f) : '='
    index += 3
  }
  return out
}

function base64ToBytes(text: string): Uint8Array | null {
  const cleaned = text.replace(/\s+/g, '')
  if (cleaned.length === 0 || cleaned.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null
  const pad = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0
  const outLength = (cleaned.length / 4) * 3 - pad
  const out = new Uint8Array(outLength)
  let outIndex = 0
  for (let index = 0; index < cleaned.length; index += 4) {
    const c0 = BASE64_ALPHABET.indexOf(cleaned.charAt(index))
    const c1 = BASE64_ALPHABET.indexOf(cleaned.charAt(index + 1))
    const ch2 = cleaned.charAt(index + 2)
    const ch3 = cleaned.charAt(index + 3)
    const c2 = ch2 === '=' ? 0 : BASE64_ALPHABET.indexOf(ch2)
    const c3 = ch3 === '=' ? 0 : BASE64_ALPHABET.indexOf(ch3)
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
    if (outIndex < outLength) out[outIndex++] = (triplet >> 16) & 0xff
    if (outIndex < outLength) out[outIndex++] = (triplet >> 8) & 0xff
    if (outIndex < outLength) out[outIndex++] = triplet & 0xff
  }
  return out
}

function decodeInputBytes(bytesOrHexOrBase64: Uint8Array | string): Uint8Array {
  if (isPlainBytes(bytesOrHexOrBase64)) {
    return copyBytes(bytesOrHexOrBase64)
  }
  const rawUnknown: unknown = bytesOrHexOrBase64
  if (rawUnknown instanceof Uint8Array) {
    return new Uint8Array(rawUnknown)
  }
  if (typeof bytesOrHexOrBase64 !== 'string') {
    throw new Error(
      'PSBT input must be a Uint8Array, hex string, or base64 string',
    )
  }
  const trimmed = bytesOrHexOrBase64.trim()
  const fromHex = hexToBytes(trimmed)
  if (fromHex !== null && hasMagic(fromHex)) {
    return fromHex
  }
  const fromBase64 = base64ToBytes(trimmed)
  if (fromBase64 !== null && hasMagic(fromBase64)) {
    return fromBase64
  }
  if (fromHex !== null) return fromHex
  if (fromBase64 !== null) return fromBase64
  throw new Error('Invalid PSBT encoding: expected valid hex or base64')
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PSBT_MAGIC.length) return false
  for (let index = 0; index < PSBT_MAGIC.length; index += 1) {
    if (bytes[index] !== PSBT_MAGIC[index]) return false
  }
  return true
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function hash160(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(cryptoBackend.hash160(bytes))
}

function readMap(reader: ByteReader): PsbtKeyValue[] {
  const entries: PsbtKeyValue[] = []
  const seenKeys = new Set<string>()
  for (;;) {
    const keyLen = reader.readVarint()
    if (!keyLen.ok)
      throw new Error('PSBT map truncated while reading key length')
    if (keyLen.value === 0n) break
    if (keyLen.value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('PSBT key length out of range')
    }
    const keyBytes = reader.read(Number(keyLen.value))
    if (!keyBytes.ok) throw new Error('PSBT map truncated while reading key')
    const keyHex = bytesToHex(keyBytes.value)
    if (seenKeys.has(keyHex)) {
      throw new Error(`Duplicate key in PSBT map: 0x${keyHex}`)
    }
    seenKeys.add(keyHex)
    const keyType = keyBytes.value[0] ?? 0
    const keyData = keyBytes.value.slice(1)
    const valueBytes = reader.readBytesPrefixed()
    if (!valueBytes.ok)
      throw new Error('PSBT map truncated while reading value')
    entries.push({
      keyType,
      keyData,
      value: valueBytes.value,
    })
  }
  return entries
}

function writeKeyValue(
  writer: ByteWriter,
  keyType: number,
  keyData: Uint8Array,
  value: Uint8Array,
): void {
  writer.writeVarint(BigInt(1 + keyData.length))
  writer.writeUInt8(keyType)
  if (keyData.length > 0) writer.write(keyData)
  writer.writeVarint(BigInt(value.length))
  if (value.length > 0) writer.write(value)
}

function validateUnsignedTx(tx: Transaction): void {
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const input = tx.inputs[index]
    if (input === undefined) continue
    if (input.scriptSig.length > 0) {
      throw new Error(
        `PSBT unsigned transaction input ${index} has non-empty scriptSig`,
      )
    }
    if (input.witness !== undefined && input.witness.length > 0) {
      throw new Error(
        `PSBT unsigned transaction input ${index} has non-empty witness`,
      )
    }
  }
}

function parseWitnessUtxo(bytes: Uint8Array): PsbtWitnessUtxo {
  const reader = new ByteReader(bytes)
  const value = reader.readUInt64LE()
  const script = reader.readBytesPrefixed()
  if (!value.ok || !script.ok || !reader.finished()) {
    throw new Error('Invalid PSBT_IN_WITNESS_UTXO encoding')
  }
  return {
    value: value.value,
    script: script.value,
  }
}

function serializeWitnessUtxo(utxo: PsbtWitnessUtxo): Uint8Array {
  const writer = new ByteWriter()
  writer.writeUInt64LE(utxo.value)
  writer.writeVarint(BigInt(utxo.script.length))
  if (utxo.script.length > 0) writer.write(utxo.script)
  return writer.finish()
}

function parseInputMap(
  entries: readonly PsbtKeyValue[],
  txInput: TxInput,
): PsbtInput {
  let nonWitnessUtxo: Transaction | undefined
  let nonWitnessUtxoBytes: Uint8Array | undefined
  let witnessUtxo: PsbtWitnessUtxo | undefined
  const partialSigs: Array<readonly [Uint8Array, Uint8Array]> = []
  let sighashType: number | undefined
  let redeemScript: Uint8Array | undefined
  let witnessScript: Uint8Array | undefined
  const bip32Derivations: Array<readonly [Uint8Array, Uint8Array]> = []
  let finalScriptSig: Uint8Array | undefined
  let finalScriptWitness: Uint8Array | undefined
  let tapKeySig: Uint8Array | undefined
  const unknownKeyVals: PsbtKeyValue[] = []

  for (const entry of entries) {
    switch (entry.keyType) {
      case PSBT_IN_NON_WITNESS_UTXO: {
        if (entry.keyData.length !== 0) {
          throw new Error(
            'PSBT_IN_NON_WITNESS_UTXO key must have empty keyData',
          )
        }
        const parsed = parseTransaction(entry.value, BTC_MAINNET)
        if (!parsed.ok) {
          throw new Error(
            `Invalid PSBT_IN_NON_WITNESS_UTXO: ${parsed.error.code}`,
          )
        }
        const id = transactionId(parsed.value, BTC_MAINNET)
        if (!id.ok) {
          throw new Error(
            `Failed to compute PSBT_IN_NON_WITNESS_UTXO txid: ${id.error.code}`,
          )
        }
        if (!equalBytes(id.value, txInput.prevout.txid)) {
          throw new Error(
            'PSBT_IN_NON_WITNESS_UTXO txid does not match input prevout txid',
          )
        }
        if (txInput.prevout.vout >= parsed.value.outputs.length) {
          throw new Error(
            'PSBT_IN_NON_WITNESS_UTXO does not contain input prevout vout',
          )
        }
        nonWitnessUtxo = parsed.value
        nonWitnessUtxoBytes = copyBytes(entry.value)
        break
      }
      case PSBT_IN_WITNESS_UTXO: {
        if (entry.keyData.length !== 0) {
          throw new Error('PSBT_IN_WITNESS_UTXO key must have empty keyData')
        }
        witnessUtxo = parseWitnessUtxo(entry.value)
        break
      }
      case PSBT_IN_PARTIAL_SIG: {
        if (entry.keyData.length !== 33 && entry.keyData.length !== 65) {
          throw new Error(
            `PSBT_IN_PARTIAL_SIG keyData must be 33 or 65 bytes (got ${entry.keyData.length})`,
          )
        }
        if (entry.value.length < 1) {
          throw new Error('PSBT_IN_PARTIAL_SIG value must not be empty')
        }
        partialSigs.push([copyBytes(entry.keyData), copyBytes(entry.value)])
        break
      }
      case PSBT_IN_SIGHASH_TYPE: {
        if (entry.keyData.length !== 0) {
          throw new Error('PSBT_IN_SIGHASH_TYPE key must have empty keyData')
        }
        if (entry.value.length !== 4) {
          throw new Error('PSBT_IN_SIGHASH_TYPE value must be 4 bytes')
        }
        sighashType = Number(decodeUnsignedLE(entry.value))
        break
      }
      case PSBT_IN_REDEEM_SCRIPT: {
        if (entry.keyData.length !== 0) {
          throw new Error('PSBT_IN_REDEEM_SCRIPT key must have empty keyData')
        }
        redeemScript = copyBytes(entry.value)
        break
      }
      case PSBT_IN_WITNESS_SCRIPT: {
        if (entry.keyData.length !== 0) {
          throw new Error('PSBT_IN_WITNESS_SCRIPT key must have empty keyData')
        }
        witnessScript = copyBytes(entry.value)
        break
      }
      case PSBT_IN_BIP32_DERIVATION: {
        if (entry.keyData.length !== 33 && entry.keyData.length !== 65) {
          throw new Error(
            `PSBT_IN_BIP32_DERIVATION keyData must be 33 or 65 bytes (got ${entry.keyData.length})`,
          )
        }
        if (entry.value.length % 4 !== 0) {
          throw new Error(
            'PSBT_IN_BIP32_DERIVATION value length must be a multiple of 4',
          )
        }
        bip32Derivations.push([
          copyBytes(entry.keyData),
          copyBytes(entry.value),
        ])
        break
      }
      case PSBT_IN_FINAL_SCRIPTSIG: {
        if (entry.keyData.length !== 0) {
          throw new Error('PSBT_IN_FINAL_SCRIPTSIG key must have empty keyData')
        }
        finalScriptSig = copyBytes(entry.value)
        break
      }
      case PSBT_IN_FINAL_SCRIPTWITNESS: {
        if (entry.keyData.length !== 0) {
          throw new Error(
            'PSBT_IN_FINAL_SCRIPTWITNESS key must have empty keyData',
          )
        }
        finalScriptWitness = copyBytes(entry.value)
        break
      }
      case PSBT_IN_TAP_KEY_SIG: {
        if (entry.keyData.length !== 0) {
          throw new Error('PSBT_IN_TAP_KEY_SIG key must have empty keyData')
        }
        if (entry.value.length !== 64 && entry.value.length !== 65) {
          throw new Error('PSBT_IN_TAP_KEY_SIG value must be 64 or 65 bytes')
        }
        tapKeySig = copyBytes(entry.value)
        break
      }
      default:
        unknownKeyVals.push({
          keyType: entry.keyType,
          keyData: copyBytes(entry.keyData),
          value: copyBytes(entry.value),
        })
        break
    }
  }

  return {
    ...(nonWitnessUtxo !== undefined ? { nonWitnessUtxo } : {}),
    ...(nonWitnessUtxoBytes !== undefined ? { nonWitnessUtxoBytes } : {}),
    ...(witnessUtxo !== undefined ? { witnessUtxo } : {}),
    partialSigs,
    ...(sighashType !== undefined ? { sighashType } : {}),
    ...(redeemScript !== undefined ? { redeemScript } : {}),
    ...(witnessScript !== undefined ? { witnessScript } : {}),
    bip32Derivations,
    ...(finalScriptSig !== undefined ? { finalScriptSig } : {}),
    ...(finalScriptWitness !== undefined ? { finalScriptWitness } : {}),
    ...(tapKeySig !== undefined ? { tapKeySig } : {}),
    unknownKeyVals,
  }
}

export function parsePsbt(bytesOrHexOrBase64: Uint8Array | string): Psbt {
  const raw = decodeInputBytes(bytesOrHexOrBase64)
  if (!hasMagic(raw)) {
    throw new Error('Invalid PSBT magic header')
  }
  const reader = new ByteReader(raw, PSBT_MAGIC.length)
  const globalEntries = readMap(reader)
  let unsignedTx: Transaction | undefined
  const globalUnknownKeyVals: PsbtKeyValue[] = []

  for (const entry of globalEntries) {
    if (entry.keyType === PSBT_GLOBAL_UNSIGNED_TX) {
      if (entry.keyData.length !== 0) {
        throw new Error('PSBT_GLOBAL_UNSIGNED_TX key must have empty keyData')
      }
      // BIP-174: unsigned tx is serialized in legacy format (no witness marker/flag).
      const parsed = parseTransaction(entry.value, BTC_MAINNET)
      if (!parsed.ok) {
        throw new Error(`Invalid PSBT_GLOBAL_UNSIGNED_TX: ${parsed.error.code}`)
      }
      validateUnsignedTx(parsed.value)
      unsignedTx = parsed.value
    } else {
      globalUnknownKeyVals.push({
        keyType: entry.keyType,
        keyData: copyBytes(entry.keyData),
        value: copyBytes(entry.value),
      })
    }
  }

  if (unsignedTx === undefined) {
    throw new Error('Missing required PSBT_GLOBAL_UNSIGNED_TX in global map')
  }

  const inputs: PsbtInput[] = []
  for (let index = 0; index < unsignedTx.inputs.length; index += 1) {
    const txInput = unsignedTx.inputs[index]
    if (txInput === undefined) {
      throw new Error(`Missing unsigned transaction input at ${index}`)
    }
    const entries = readMap(reader)
    inputs.push(parseInputMap(entries, txInput))
  }

  const outputs: PsbtOutput[] = []
  for (let index = 0; index < unsignedTx.outputs.length; index += 1) {
    const entries = readMap(reader)
    outputs.push({
      unknownKeyVals: entries.map(entry => ({
        keyType: entry.keyType,
        keyData: copyBytes(entry.keyData),
        value: copyBytes(entry.value),
      })),
    })
  }

  if (!reader.finished()) {
    throw new Error('Trailing bytes after PSBT output maps')
  }

  return {
    unsignedTx,
    inputs,
    outputs,
    globalUnknownKeyVals,
  }
}

export function serializePsbt(psbt: Psbt): Uint8Array {
  validateUnsignedTx(psbt.unsignedTx)
  if (psbt.inputs.length !== psbt.unsignedTx.inputs.length) {
    throw new Error('PSBT input map count does not match unsignedTx inputs')
  }
  if (psbt.outputs.length !== psbt.unsignedTx.outputs.length) {
    throw new Error('PSBT output map count does not match unsignedTx outputs')
  }

  const writer = new ByteWriter()
  writer.write(PSBT_MAGIC)

  const unsignedBytes = serializeTransaction(psbt.unsignedTx, BTC_MAINNET)
  if (!unsignedBytes.ok) {
    throw new Error(
      `Failed to serialize PSBT unsignedTx: ${unsignedBytes.error.code}`,
    )
  }
  writeKeyValue(
    writer,
    PSBT_GLOBAL_UNSIGNED_TX,
    new Uint8Array(0),
    unsignedBytes.value,
  )
  for (const entry of psbt.globalUnknownKeyVals) {
    writeKeyValue(writer, entry.keyType, entry.keyData, entry.value)
  }
  writer.writeUInt8(0x00)

  for (let index = 0; index < psbt.inputs.length; index += 1) {
    const input = psbt.inputs[index]
    const txInput = psbt.unsignedTx.inputs[index]
    if (input === undefined || txInput === undefined) continue
    if (input.nonWitnessUtxo !== undefined) {
      const id = transactionId(input.nonWitnessUtxo, BTC_MAINNET)
      if (!id.ok || !equalBytes(id.value, txInput.prevout.txid)) {
        throw new Error(
          'PSBT_IN_NON_WITNESS_UTXO txid does not match input prevout txid',
        )
      }
      const rawUtxo =
        input.nonWitnessUtxoBytes ??
        (() => {
          const serialized = serializeTransaction(
            input.nonWitnessUtxo,
            BTC_MAINNET,
          )
          if (!serialized.ok) {
            throw new Error(
              `Failed to serialize nonWitnessUtxo: ${serialized.error.code}`,
            )
          }
          return serialized.value
        })()
      writeKeyValue(
        writer,
        PSBT_IN_NON_WITNESS_UTXO,
        new Uint8Array(0),
        rawUtxo,
      )
    }
    if (input.witnessUtxo !== undefined) {
      writeKeyValue(
        writer,
        PSBT_IN_WITNESS_UTXO,
        new Uint8Array(0),
        serializeWitnessUtxo(input.witnessUtxo),
      )
    }
    for (const [pubkey, sig] of input.partialSigs) {
      writeKeyValue(writer, PSBT_IN_PARTIAL_SIG, pubkey, sig)
    }
    if (input.sighashType !== undefined) {
      const encoded = encodeUnsignedLE(BigInt(input.sighashType >>> 0), 4)
      if (!encoded.ok) throw new Error('Invalid sighashType')
      writeKeyValue(
        writer,
        PSBT_IN_SIGHASH_TYPE,
        new Uint8Array(0),
        encoded.value,
      )
    }
    if (input.redeemScript !== undefined) {
      writeKeyValue(
        writer,
        PSBT_IN_REDEEM_SCRIPT,
        new Uint8Array(0),
        input.redeemScript,
      )
    }
    if (input.witnessScript !== undefined) {
      writeKeyValue(
        writer,
        PSBT_IN_WITNESS_SCRIPT,
        new Uint8Array(0),
        input.witnessScript,
      )
    }
    for (const [pubkey, derivation] of input.bip32Derivations) {
      writeKeyValue(writer, PSBT_IN_BIP32_DERIVATION, pubkey, derivation)
    }
    if (input.finalScriptSig !== undefined) {
      writeKeyValue(
        writer,
        PSBT_IN_FINAL_SCRIPTSIG,
        new Uint8Array(0),
        input.finalScriptSig,
      )
    }
    if (input.finalScriptWitness !== undefined) {
      writeKeyValue(
        writer,
        PSBT_IN_FINAL_SCRIPTWITNESS,
        new Uint8Array(0),
        input.finalScriptWitness,
      )
    }
    if (input.tapKeySig !== undefined) {
      writeKeyValue(
        writer,
        PSBT_IN_TAP_KEY_SIG,
        new Uint8Array(0),
        input.tapKeySig,
      )
    }
    for (const entry of input.unknownKeyVals) {
      writeKeyValue(writer, entry.keyType, entry.keyData, entry.value)
    }
    writer.writeUInt8(0x00)
  }

  for (const output of psbt.outputs) {
    for (const entry of output.unknownKeyVals) {
      writeKeyValue(writer, entry.keyType, entry.keyData, entry.value)
    }
    writer.writeUInt8(0x00)
  }

  return writer.finish()
}

export function psbtToHex(psbt: Psbt): string {
  return bytesToHex(serializePsbt(psbt))
}

export function psbtToBase64(psbt: Psbt): string {
  return bytesToBase64(serializePsbt(psbt))
}

export function createPsbt(params: {
  unsignedTx: Transaction
  inputs?: ReadonlyArray<{
    witnessUtxo?: { value: bigint; script: Uint8Array }
    nonWitnessUtxo?: Transaction
    sighashType?: number
    redeemScript?: Uint8Array
    witnessScript?: Uint8Array
  }>
}): Psbt {
  validateUnsignedTx(params.unsignedTx)
  const inputs: PsbtInput[] = params.unsignedTx.inputs.map((txInput, index) => {
    const provided = params.inputs?.[index]
    if (provided?.nonWitnessUtxo !== undefined) {
      const id = transactionId(provided.nonWitnessUtxo, BTC_MAINNET)
      if (!id.ok || !equalBytes(id.value, txInput.prevout.txid)) {
        throw new Error(
          `PSBT input ${index} nonWitnessUtxo txid does not match prevout txid`,
        )
      }
      if (txInput.prevout.vout >= provided.nonWitnessUtxo.outputs.length) {
        throw new Error(
          `PSBT input ${index} nonWitnessUtxo does not contain prevout vout`,
        )
      }
    }
    return {
      ...(provided?.nonWitnessUtxo !== undefined
        ? { nonWitnessUtxo: provided.nonWitnessUtxo }
        : {}),
      ...(provided?.witnessUtxo !== undefined
        ? {
            witnessUtxo: {
              value: provided.witnessUtxo.value,
              script: copyBytes(provided.witnessUtxo.script),
            },
          }
        : {}),
      partialSigs: [],
      ...(provided?.sighashType !== undefined
        ? { sighashType: provided.sighashType }
        : {}),
      ...(provided?.redeemScript !== undefined
        ? { redeemScript: copyBytes(provided.redeemScript) }
        : {}),
      ...(provided?.witnessScript !== undefined
        ? { witnessScript: copyBytes(provided.witnessScript) }
        : {}),
      bip32Derivations: [],
      unknownKeyVals: [],
    }
  })

  const outputs: PsbtOutput[] = params.unsignedTx.outputs.map(() => ({
    unknownKeyVals: [],
  }))

  return {
    unsignedTx: params.unsignedTx,
    inputs,
    outputs,
    globalUnknownKeyVals: [],
  }
}

type InputScriptTemplate =
  | {
      readonly kind: 'p2wpkh'
      readonly pubkeyHash: Uint8Array
      readonly scriptCode: Uint8Array
    }
  | {
      readonly kind: 'p2pkh'
      readonly pubkeyHash: Uint8Array
      readonly scriptCode: Uint8Array
    }

function p2pkhScriptFromHash(pubkeyHash: Uint8Array): Uint8Array {
  const out = new Uint8Array(25)
  out[0] = OP_DUP
  out[1] = OP_HASH160
  out[2] = 20
  out.set(pubkeyHash, 3)
  out[23] = OP_EQUALVERIFY
  out[24] = OP_CHECKSIG
  return out
}

function classifyLockingScript(
  script: Uint8Array,
): InputScriptTemplate | undefined {
  if (script.length === 22 && script[0] === OP_0 && script[1] === 0x14) {
    const pubkeyHash = script.slice(2, 22)
    return {
      kind: 'p2wpkh',
      pubkeyHash,
      scriptCode: p2pkhScriptFromHash(pubkeyHash),
    }
  }
  if (
    script.length === 25 &&
    script[0] === OP_DUP &&
    script[1] === OP_HASH160 &&
    script[2] === 0x14 &&
    script[23] === OP_EQUALVERIFY &&
    script[24] === OP_CHECKSIG
  ) {
    const pubkeyHash = script.slice(3, 23)
    return {
      kind: 'p2pkh',
      pubkeyHash,
      scriptCode: copyBytes(script),
    }
  }
  return undefined
}

function resolveInputUtxo(
  input: PsbtInput,
  txInput: TxInput,
): { readonly value: bigint; readonly script: Uint8Array } | undefined {
  if (input.witnessUtxo !== undefined) {
    return input.witnessUtxo
  }
  if (input.nonWitnessUtxo !== undefined) {
    const prevOut = input.nonWitnessUtxo.outputs[txInput.prevout.vout]
    if (prevOut !== undefined) {
      return {
        value: prevOut.value,
        script: prevOut.scriptPubKey,
      }
    }
  }
  return undefined
}

function addressMatchesPubkeyHash(
  address: string,
  pubkeyHash: Uint8Array,
  chain: ChainDescriptor | undefined,
): boolean {
  const trimmed = address.trim()
  const candidates =
    chain?.cashaddrPrefix && !trimmed.includes(':')
      ? [trimmed, `${chain.cashaddrPrefix}:${trimmed}`]
      : [trimmed]
  for (const candidate of candidates) {
    const decoded = decodeAddress(candidate, chain)
    if (decoded.ok) {
      const dest = decoded.value.destination
      if (dest.kind === 'p2wpkh' || dest.kind === 'p2pkh') {
        return equalBytes(dest.hash, pubkeyHash)
      }
      return false
    }
  }
  return false
}

export function signPsbt(
  psbt: Psbt,
  signers: readonly SigningKey[],
  options?: SignPsbtOptions,
): Psbt {
  const chain = options?.chain ?? BTC_MAINNET
  const toSign = options?.toSignInputs
  const nextInputs: PsbtInput[] = []
  const signedIndices = new Set<number>()

  const allSpent: SpentOutput[] = []
  let allSpentAvailable = true
  for (let i = 0; i < psbt.inputs.length; i += 1) {
    const inp = psbt.inputs[i]
    const txInp = psbt.unsignedTx.inputs[i]
    if (inp === undefined || txInp === undefined) {
      allSpentAvailable = false
      break
    }
    const resolved = resolveInputUtxo(inp, txInp)
    if (resolved === undefined) {
      allSpentAvailable = false
      break
    }
    allSpent.push({ value: resolved.value, scriptPubKey: resolved.script })
  }

  for (let index = 0; index < psbt.inputs.length; index += 1) {
    const input = psbt.inputs[index]
    const txInput = psbt.unsignedTx.inputs[index]
    if (input === undefined || txInput === undefined) continue

    if (
      input.finalScriptSig !== undefined ||
      input.finalScriptWitness !== undefined
    ) {
      nextInputs.push(input)
      continue
    }

    const filterEntries =
      toSign !== undefined
        ? toSign.filter(entry => entry.index === index)
        : undefined
    if (filterEntries !== undefined && filterEntries.length === 0) {
      nextInputs.push(input)
      continue
    }

    const utxo = resolveInputUtxo(input, txInput)
    if (utxo === undefined) {
      nextInputs.push(input)
      continue
    }

    const template = classifyLockingScript(utxo.script)
    if (template === undefined) {
      nextInputs.push(input)
      continue
    }

    const sighashType =
      input.sighashType ??
      (chain.sighash.kind === 'forkid'
        ? SIGHASH_ALL | SIGHASH_FORKID
        : SIGHASH_ALL)

    if (filterEntries !== undefined) {
      const allowedSighash = filterEntries.every(
        entry =>
          entry.sighashTypes === undefined ||
          entry.sighashTypes.length === 0 ||
          entry.sighashTypes.includes(sighashType),
      )
      if (!allowedSighash) {
        nextInputs.push(input)
        continue
      }
    }

    const partialSigs: Array<readonly [Uint8Array, Uint8Array]> = [
      ...input.partialSigs,
    ]
    let inputSigned = false

    for (const signer of signers) {
      const pubkey = copyBytes(signer.publicKey)
      if (template.kind === 'p2wpkh' && pubkey.length !== 33) continue
      if (
        template.kind === 'p2pkh' &&
        pubkey.length !== 33 &&
        pubkey.length !== 65
      ) {
        continue
      }
      const pubkeyHash = hash160(pubkey)
      if (!equalBytes(pubkeyHash, template.pubkeyHash)) continue

      if (filterEntries !== undefined) {
        const pubHex = bytesToHex(pubkey).toLowerCase()
        const matchesFilter = filterEntries.some(entry => {
          if (
            entry.publicKeyHex !== undefined &&
            entry.publicKeyHex.toLowerCase() !== pubHex
          ) {
            return false
          }
          if (
            entry.address !== undefined &&
            !addressMatchesPubkeyHash(entry.address, pubkeyHash, options?.chain)
          ) {
            return false
          }
          return true
        })
        if (!matchesFilter) continue
      }

      const algorithm: SighashAlgorithm =
        template.kind === 'p2wpkh'
          ? 'bip143'
          : (sighashType & SIGHASH_FORKID) !== 0 ||
            chain.sighash.kind === 'forkid'
          ? 'forkid'
          : 'legacy'

      const digestChain =
        algorithm === 'bip143' && chain.sighash.kind !== 'btc-legacy-and-segwit'
          ? BTC_MAINNET
          : chain

      const digest = sighash(psbt.unsignedTx, index, digestChain, sighashType, {
        algorithm,
        scriptCode: template.scriptCode,
        amount: utxo.value,
        ...(allSpentAvailable ? { spent: allSpent } : {}),
      })
      if (!digest.ok) {
        throw new Error(
          `Failed to compute PSBT sighash for input ${index}: ${digest.error.code}`,
        )
      }

      const rawSig = signer.sign(copyBytes(digest.value))
      const checkedSig = ecdsaSignatureFromBytes(rawSig)
      if (!checkedSig.ok || checkedSig.value.length > ECDSA_BODY_MAX) {
        throw new Error(`Invalid ECDSA signature produced for input ${index}`)
      }
      const sigWithHashtype = new Uint8Array(checkedSig.value.length + 1)
      sigWithHashtype.set(checkedSig.value, 0)
      sigWithHashtype[checkedSig.value.length] = sighashType & 0xff

      const existingIdx = partialSigs.findIndex(([existingPub]) =>
        equalBytes(existingPub, pubkey),
      )
      if (existingIdx >= 0) {
        partialSigs[existingIdx] = [pubkey, sigWithHashtype]
      } else {
        partialSigs.push([pubkey, sigWithHashtype])
      }
      inputSigned = true
    }

    if (inputSigned) {
      signedIndices.add(index)
    }

    nextInputs.push({
      ...input,
      partialSigs,
    })
  }

  const signedPsbt: Psbt = {
    ...psbt,
    inputs: nextInputs,
  }

  if (options?.autoFinalized === true) {
    return finalizePsbtInputs(
      signedPsbt,
      toSign !== undefined ? signedIndices : undefined,
    )
  }

  return signedPsbt
}

function encodePushData(data: Uint8Array): Uint8Array {
  if (data.length < 0x4c) {
    const out = new Uint8Array(1 + data.length)
    out[0] = data.length
    out.set(data, 1)
    return out
  }
  if (data.length <= 0xff) {
    const out = new Uint8Array(2 + data.length)
    out[0] = 0x4c
    out[1] = data.length
    out.set(data, 2)
    return out
  }
  throw new Error('Script push data too large for standard P2PKH scriptSig')
}

function encodeWitnessStack(items: readonly Uint8Array[]): Uint8Array {
  const writer = new ByteWriter()
  writer.writeVarint(BigInt(items.length))
  for (const item of items) {
    writer.writeVarint(BigInt(item.length))
    if (item.length > 0) writer.write(item)
  }
  return writer.finish()
}

function decodeWitnessStack(bytes: Uint8Array): Uint8Array[] {
  const reader = new ByteReader(bytes)
  const count = reader.readVarint()
  if (!count.ok) throw new Error('Invalid finalScriptWitness stack count')
  const items: Uint8Array[] = []
  for (let index = 0; index < Number(count.value); index += 1) {
    const item = reader.readBytesPrefixed()
    if (!item.ok) throw new Error('Invalid finalScriptWitness item')
    items.push(item.value)
  }
  if (!reader.finished()) {
    throw new Error('Trailing bytes in finalScriptWitness')
  }
  return items
}

function finalizeSingleInput(input: PsbtInput, txInput: TxInput): PsbtInput {
  if (
    input.finalScriptSig !== undefined ||
    input.finalScriptWitness !== undefined
  ) {
    return input
  }
  const firstSig = input.partialSigs[0]
  if (firstSig === undefined) {
    return input
  }
  const [pubkey, sig] = firstSig
  const utxo = resolveInputUtxo(input, txInput)
  const template =
    utxo !== undefined ? classifyLockingScript(utxo.script) : undefined

  const isWitness =
    template !== undefined
      ? template.kind === 'p2wpkh'
      : input.witnessUtxo !== undefined && input.nonWitnessUtxo === undefined

  const rest = {
    ...(input.nonWitnessUtxo !== undefined
      ? { nonWitnessUtxo: input.nonWitnessUtxo }
      : {}),
    ...(input.nonWitnessUtxoBytes !== undefined
      ? { nonWitnessUtxoBytes: input.nonWitnessUtxoBytes }
      : {}),
    ...(input.witnessUtxo !== undefined
      ? { witnessUtxo: input.witnessUtxo }
      : {}),
    partialSigs: [] as ReadonlyArray<readonly [Uint8Array, Uint8Array]>,
    bip32Derivations: input.bip32Derivations,
    unknownKeyVals: input.unknownKeyVals,
  }

  if (isWitness) {
    return {
      ...rest,
      finalScriptWitness: encodeWitnessStack([sig, pubkey]),
    }
  }

  return {
    ...rest,
    finalScriptSig: concatBytes([encodePushData(sig), encodePushData(pubkey)]),
  }
}

function finalizePsbtInputs(
  psbt: Psbt,
  onlyIndices?: ReadonlySet<number>,
): Psbt {
  const nextInputs = psbt.inputs.map((input, index) => {
    if (onlyIndices !== undefined && !onlyIndices.has(index)) {
      return input
    }
    const txInput = psbt.unsignedTx.inputs[index]
    if (txInput === undefined) return input
    return finalizeSingleInput(input, txInput)
  })
  return {
    ...psbt,
    inputs: nextInputs,
  }
}

export function finalizePsbt(psbt: Psbt): Psbt {
  return finalizePsbtInputs(psbt)
}

export function extractPsbtTransaction(psbt: Psbt): Transaction {
  if (psbt.inputs.length !== psbt.unsignedTx.inputs.length) {
    throw new Error('PSBT input count mismatch')
  }
  const signedInputs: TxInput[] = []
  for (let index = 0; index < psbt.inputs.length; index += 1) {
    const input = psbt.inputs[index]
    const txInput = psbt.unsignedTx.inputs[index]
    if (input === undefined || txInput === undefined) {
      throw new Error(`Missing PSBT input at index ${index}`)
    }
    if (
      input.finalScriptSig === undefined &&
      input.finalScriptWitness === undefined
    ) {
      throw new Error(`PSBT input ${index} is not finalized`)
    }
    const scriptSig =
      input.finalScriptSig !== undefined
        ? copyBytes(input.finalScriptSig)
        : new Uint8Array(0)
    const witness =
      input.finalScriptWitness !== undefined
        ? decodeWitnessStack(input.finalScriptWitness)
        : undefined
    signedInputs.push({
      prevout: txInput.prevout,
      scriptSig,
      sequence: txInput.sequence,
      ...(witness !== undefined && witness.length > 0 ? { witness } : {}),
    })
  }
  return {
    version: psbt.unsignedTx.version,
    inputs: signedInputs,
    outputs: psbt.unsignedTx.outputs,
    locktime: psbt.unsignedTx.locktime,
  }
}
