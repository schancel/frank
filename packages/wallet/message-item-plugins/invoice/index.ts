import {
  decodeCanonical,
  encodeCanonical,
  type Encodable,
  type FrankValue,
} from '@frank/codec'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import { formatBaseUnit, parseBaseUnit } from '../../chain/base-unit'
import type {
  ApplicationItemPlugin,
  MessageItemDecodeContext,
  MessageItemPlugin,
  MessageItemPluginCapabilities,
  MessageItemRegistry,
} from '../registry'

export * from './invoice-lifecycle'

export const INVOICE_PLUGIN_ID = 'invoice-v1'
export const INVOICE_ITEM_TYPE = INVOICE_PLUGIN_ID
export const INVOICE_SCHEMA_VERSION = 1
export const INVOICE_MAX_DESCRIPTION_BYTES = 280

export interface InvoiceRequestPayload {
  action: 'request'
  schemaVersion: 1
  invoiceId: string
  payeeIdentity: string
  chainKey: string
  networkId: string
  nativeSymbol: string
  nativeDecimals: number
  amountBaseUnits: string
  receiveAddress: string
  description: string
  expiresAtIso?: string
}

export interface InvoiceReceiptPayload {
  action: 'receipt'
  schemaVersion: 1
  invoiceId: string
  txHash: string
  chainKey: string
  networkId: string
  amountBaseUnits: string
  payerIdentity?: string
}

export type InvoicePayload = InvoiceRequestPayload | InvoiceReceiptPayload

const ALLOWED_REQUEST_KEYS = new Set<string>([
  'action',
  'schemaVersion',
  'invoiceId',
  'payeeIdentity',
  'chainKey',
  'networkId',
  'nativeSymbol',
  'nativeDecimals',
  'amountBaseUnits',
  'receiveAddress',
  'description',
  'expiresAtIso',
])

const ALLOWED_RECEIPT_KEYS = new Set<string>([
  'action',
  'schemaVersion',
  'invoiceId',
  'txHash',
  'chainKey',
  'networkId',
  'amountBaseUnits',
  'payerIdentity',
])

const CBOR_KEY_ACTION = 0
const CBOR_KEY_SCHEMA_VERSION = 1
const CBOR_KEY_INVOICE_ID = 2
const CBOR_KEY_CHAIN_KEY = 3
const CBOR_KEY_NETWORK_ID = 4
const CBOR_KEY_AMOUNT_BASE_UNITS = 5
const CBOR_KEY_PAYEE_IDENTITY = 6
const CBOR_KEY_NATIVE_SYMBOL = 7
const CBOR_KEY_NATIVE_DECIMALS = 8
const CBOR_KEY_RECEIVE_ADDRESS = 9
const CBOR_KEY_DESCRIPTION = 10
const CBOR_KEY_EXPIRES_AT_ISO = 11
const CBOR_KEY_TX_HASH = 12
const CBOR_KEY_PAYER_IDENTITY = 13

const utf8Encoder = new TextEncoder()

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

export function generateInvoiceId(): string {
  const runtimeCrypto = (
    globalThis as unknown as {
      crypto?: {
        randomUUID?: () => string
        getRandomValues?: <T extends Uint8Array>(arr: T) => T
      }
    }
  ).crypto
  if (runtimeCrypto?.randomUUID) {
    return runtimeCrypto.randomUUID().replace(/-/g, '')
  }
  const bytes = new Uint8Array(16)
  if (runtimeCrypto?.getRandomValues) {
    runtimeCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function parseHumanAmountToBaseUnits(
  displayAmount: string,
  decimals: number,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TypeError('nativeDecimals must be an integer between 0 and 18')
  }
  if (typeof displayAmount !== 'string') {
    throw new TypeError('Display amount must be a string')
  }
  const trimmed = displayAmount.trim()
  if (!trimmed || trimmed.startsWith('-')) {
    throw new TypeError('Invoice amount must be a positive decimal number')
  }
  const raw = parseBaseUnit(trimmed, decimals)
  if (raw <= 0n) {
    throw new TypeError('Invoice amount must be greater than zero')
  }
  return raw.toString(10)
}

export function formatInvoiceAmount(
  amountBaseUnits: string,
  decimals: number,
): string {
  if (!/^[1-9]\d{0,77}$/.test(String(amountBaseUnits))) {
    return '0'
  }
  return formatBaseUnit(BigInt(amountBaseUnits), decimals)
}

function assertBoundedString(
  value: unknown,
  field: string,
  minChars: number,
  maxChars: number,
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`invoice ${field} must be a string`)
  }
  if (value.length < minChars || value.length > maxChars) {
    throw new TypeError(
      `invoice ${field} must be ${minChars}..${maxChars} chars`,
    )
  }
  return value
}

function assertInvoiceId(value: unknown): string {
  const id = assertBoundedString(value, 'invoiceId', 16, 64)
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(id)) {
    throw new TypeError(
      'invoice invoiceId must contain only alphanumeric, hyphen, or underscore characters (16..64 chars)',
    )
  }
  return id
}

function assertPositiveBaseUnits(value: unknown): string {
  const str = assertBoundedString(value, 'amountBaseUnits', 1, 78)
  if (!/^[1-9]\d{0,77}$/.test(str)) {
    throw new TypeError(
      'invoice amountBaseUnits must be a positive base-10 integer string without leading zeros or decimals',
    )
  }
  return str
}

export function validateInvoicePayload(value: unknown): InvoicePayload {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError('Expected plain invoice payload object')
  }

  const raw = value as Record<string, unknown>
  const action = raw.action
  if (action !== 'request' && action !== 'receipt') {
    throw new TypeError(
      `invoice action must be 'request' or 'receipt', got ${String(action)}`,
    )
  }

  const allowedKeys =
    action === 'request' ? ALLOWED_REQUEST_KEYS : ALLOWED_RECEIPT_KEYS

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new TypeError(`Unexpected invoice payload property: ${String(key)}`)
    }
    const desc = Object.getOwnPropertyDescriptor(value, key)
    if (!desc || !desc.enumerable || !('value' in desc)) {
      throw new TypeError(
        `Invoice payload property ${key} must be an enumerable data property`,
      )
    }
  }

  if (raw.schemaVersion !== INVOICE_SCHEMA_VERSION) {
    throw new TypeError(
      `invoice schemaVersion must be ${INVOICE_SCHEMA_VERSION}`,
    )
  }

  const invoiceId = assertInvoiceId(raw.invoiceId)
  const chainKey = assertBoundedString(raw.chainKey, 'chainKey', 1, 64).trim()
  if (!chainKey) {
    throw new TypeError('invoice chainKey must not be blank')
  }
  const networkId = assertBoundedString(
    raw.networkId,
    'networkId',
    1,
    64,
  ).trim()
  if (!networkId) {
    throw new TypeError('invoice networkId must not be blank')
  }
  const amountBaseUnits = assertPositiveBaseUnits(raw.amountBaseUnits)

  if (action === 'request') {
    const payeeIdentity = assertBoundedString(
      raw.payeeIdentity,
      'payeeIdentity',
      1,
      256,
    ).trim()
    if (!payeeIdentity) {
      throw new TypeError('invoice payeeIdentity must not be blank')
    }
    const nativeSymbol = assertBoundedString(
      raw.nativeSymbol,
      'nativeSymbol',
      1,
      16,
    ).trim()
    if (!nativeSymbol) {
      throw new TypeError('invoice nativeSymbol must not be blank')
    }
    if (
      typeof raw.nativeDecimals !== 'number' ||
      !Number.isInteger(raw.nativeDecimals) ||
      raw.nativeDecimals < 0 ||
      raw.nativeDecimals > 18 ||
      Object.is(raw.nativeDecimals, -0)
    ) {
      throw new TypeError('invoice nativeDecimals must be an integer 0..18')
    }
    const receiveAddress = assertBoundedString(
      raw.receiveAddress,
      'receiveAddress',
      1,
      256,
    ).trim()
    if (!receiveAddress) {
      throw new TypeError('invoice receiveAddress must not be blank')
    }
    if (typeof raw.description !== 'string') {
      throw new TypeError('invoice description must be a string')
    }
    const descBytes = utf8ByteLength(raw.description)
    if (descBytes > INVOICE_MAX_DESCRIPTION_BYTES) {
      throw new TypeError(
        `invoice description must be at most ${INVOICE_MAX_DESCRIPTION_BYTES} UTF-8 bytes (got ${descBytes})`,
      )
    }

    const requestPayload: InvoiceRequestPayload = {
      action: 'request',
      schemaVersion: 1,
      invoiceId,
      payeeIdentity,
      chainKey,
      networkId,
      nativeSymbol,
      nativeDecimals: raw.nativeDecimals,
      amountBaseUnits,
      receiveAddress,
      description: raw.description,
    }

    if (raw.expiresAtIso !== undefined) {
      const expiresAtIso = assertBoundedString(
        raw.expiresAtIso,
        'expiresAtIso',
        10,
        64,
      )
      if (Number.isNaN(Date.parse(expiresAtIso))) {
        throw new TypeError(
          'invoice expiresAtIso must be a valid ISO-8601 timestamp',
        )
      }
      requestPayload.expiresAtIso = expiresAtIso
    }

    return requestPayload
  }

  const txHash = assertBoundedString(raw.txHash, 'txHash', 1, 256).trim()
  if (!txHash) {
    throw new TypeError('invoice receipt txHash must not be blank')
  }

  const receiptPayload: InvoiceReceiptPayload = {
    action: 'receipt',
    schemaVersion: 1,
    invoiceId,
    txHash,
    chainKey,
    networkId,
    amountBaseUnits,
  }

  if (raw.payerIdentity !== undefined) {
    const payerIdentity = assertBoundedString(
      raw.payerIdentity,
      'payerIdentity',
      1,
      256,
    ).trim()
    if (!payerIdentity) {
      throw new TypeError('invoice payerIdentity must not be blank')
    }
    receiptPayload.payerIdentity = payerIdentity
  }

  return receiptPayload
}

export const readInvoicePayload = validateInvoicePayload

function encodeInvoiceCborMap(payload: InvoicePayload): Map<number, Encodable> {
  const map = new Map<number, Encodable>([
    [CBOR_KEY_ACTION, payload.action],
    [CBOR_KEY_SCHEMA_VERSION, payload.schemaVersion],
    [CBOR_KEY_INVOICE_ID, payload.invoiceId],
    [CBOR_KEY_CHAIN_KEY, payload.chainKey],
    [CBOR_KEY_NETWORK_ID, payload.networkId],
    [CBOR_KEY_AMOUNT_BASE_UNITS, payload.amountBaseUnits],
  ])

  if (payload.action === 'request') {
    map.set(CBOR_KEY_PAYEE_IDENTITY, payload.payeeIdentity)
    map.set(CBOR_KEY_NATIVE_SYMBOL, payload.nativeSymbol)
    map.set(CBOR_KEY_NATIVE_DECIMALS, payload.nativeDecimals)
    map.set(CBOR_KEY_RECEIVE_ADDRESS, payload.receiveAddress)
    map.set(CBOR_KEY_DESCRIPTION, payload.description)
    if (payload.expiresAtIso !== undefined) {
      map.set(CBOR_KEY_EXPIRES_AT_ISO, payload.expiresAtIso)
    }
  } else {
    map.set(CBOR_KEY_TX_HASH, payload.txHash)
    if (payload.payerIdentity !== undefined) {
      map.set(CBOR_KEY_PAYER_IDENTITY, payload.payerIdentity)
    }
  }

  return map
}

function decodeInvoiceCborMap(decoded: FrankValue): InvoicePayload {
  if (!(decoded instanceof Map)) {
    throw new TypeError('Expected canonical CBOR map for invoice-v1')
  }
  for (const key of decoded.keys()) {
    if (typeof key !== 'bigint' || key < 0n || key > 13n) {
      throw new TypeError(`Unexpected CBOR key in invoice-v1: ${String(key)}`)
    }
  }

  const action = decoded.get(BigInt(CBOR_KEY_ACTION))
  const rawSchemaVersion = decoded.get(BigInt(CBOR_KEY_SCHEMA_VERSION))
  if (rawSchemaVersion !== 1n) {
    throw new TypeError('invoice-v1 schemaVersion must be 1')
  }

  const candidate: Record<string, unknown> = {
    action,
    schemaVersion: 1,
    invoiceId: decoded.get(BigInt(CBOR_KEY_INVOICE_ID)),
    chainKey: decoded.get(BigInt(CBOR_KEY_CHAIN_KEY)),
    networkId: decoded.get(BigInt(CBOR_KEY_NETWORK_ID)),
    amountBaseUnits: decoded.get(BigInt(CBOR_KEY_AMOUNT_BASE_UNITS)),
  }

  if (action === 'request') {
    const rawDecimals = decoded.get(BigInt(CBOR_KEY_NATIVE_DECIMALS))
    if (typeof rawDecimals !== 'bigint' || rawDecimals < 0n || rawDecimals > 18n) {
      throw new TypeError('invoice-v1 nativeDecimals must be 0..18')
    }
    candidate.payeeIdentity = decoded.get(BigInt(CBOR_KEY_PAYEE_IDENTITY))
    candidate.nativeSymbol = decoded.get(BigInt(CBOR_KEY_NATIVE_SYMBOL))
    candidate.nativeDecimals = Number(rawDecimals)
    candidate.receiveAddress = decoded.get(BigInt(CBOR_KEY_RECEIVE_ADDRESS))
    candidate.description = decoded.get(BigInt(CBOR_KEY_DESCRIPTION))
    if (decoded.has(BigInt(CBOR_KEY_EXPIRES_AT_ISO))) {
      candidate.expiresAtIso = decoded.get(BigInt(CBOR_KEY_EXPIRES_AT_ISO))
    }
  } else if (action === 'receipt') {
    candidate.txHash = decoded.get(BigInt(CBOR_KEY_TX_HASH))
    if (decoded.has(BigInt(CBOR_KEY_PAYER_IDENTITY))) {
      candidate.payerIdentity = decoded.get(BigInt(CBOR_KEY_PAYER_IDENTITY))
    }
  }

  return validateInvoicePayload(candidate)
}

export function encodeInvoicePayload(payload: InvoicePayload): Uint8Array {
  const validated = validateInvoicePayload(payload)
  return encodeCanonical(encodeInvoiceCborMap(validated))
}

export function decodeInvoicePayload(
  bytes: Uint8Array,
  context?: MessageItemDecodeContext,
): InvoicePayload {
  const decoded = context?.budget
    ? context.budget.decodeCbor(bytes, INVOICE_PLUGIN_ID)
    : decodeCanonical(bytes)
  return decodeInvoiceCborMap(decoded)
}

export function formatInvoicePreviewText(payload: InvoicePayload): string {
  const validated = validateInvoicePayload(payload)
  if (validated.action === 'request') {
    const display = formatInvoiceAmount(
      validated.amountBaseUnits,
      validated.nativeDecimals,
    )
    const memo = validated.description.trim()
      ? ` — ${validated.description.trim()}`
      : ''
    return `🧾 Invoice: ${display} ${validated.nativeSymbol} (${validated.chainKey})${memo}`
  }
  return `🧾 Invoice receipt: ${validated.invoiceId.slice(0, 8)} (${validated.txHash.slice(0, 10)}…)`
}

export function toInvoiceApplicationItem(
  payload: InvoicePayload,
): ApplicationMessageItem {
  return {
    type: 'application',
    itemType: INVOICE_PLUGIN_ID,
    value: validateInvoicePayload(payload),
  }
}

export const createInvoiceItem = toInvoiceApplicationItem

export function parseInvoiceApplicationItem(item: unknown): InvoicePayload {
  if (typeof item !== 'object' || item === null) {
    throw new TypeError('Expected invoice application item or payload')
  }
  const record = item as Record<string, unknown>
  if (record.type === 'application') {
    if (record.itemType !== INVOICE_PLUGIN_ID) {
      throw new TypeError(
        `Expected application itemType '${INVOICE_PLUGIN_ID}', got '${String(record.itemType)}'`,
      )
    }
    return validateInvoicePayload(record.value)
  }
  return validateInvoicePayload(item)
}

export function createInvoicePlugin(): ApplicationItemPlugin<InvoicePayload> {
  return {
    itemType: INVOICE_PLUGIN_ID,
    read: validateInvoicePayload,
    encode: encodeInvoicePayload,
    decode(
      bytes: Uint8Array,
      context: MessageItemDecodeContext,
    ): InvoicePayload {
      return decodeInvoicePayload(bytes, context)
    },
    previewText: formatInvoicePreviewText,
  }
}

export const invoiceApplicationPlugin: ApplicationItemPlugin<InvoicePayload> =
  createInvoicePlugin()

export const invoicePlugin: ApplicationItemPlugin<InvoicePayload> & {
  readonly type: typeof INVOICE_PLUGIN_ID
  readonly carrier: 'application'
  hydrate(raw: ApplicationMessageItem | InvoicePayload): InvoicePayload
} = {
  itemType: INVOICE_PLUGIN_ID,
  type: INVOICE_PLUGIN_ID,
  carrier: 'application',
  read: validateInvoicePayload,
  hydrate(raw: ApplicationMessageItem | InvoicePayload): InvoicePayload {
    return parseInvoiceApplicationItem(raw)
  },
  previewText(raw: ApplicationMessageItem | InvoicePayload): string {
    return formatInvoicePreviewText(parseInvoiceApplicationItem(raw))
  },
  encode(raw: ApplicationMessageItem | InvoicePayload): Uint8Array {
    return encodeInvoicePayload(parseInvoiceApplicationItem(raw))
  },
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): InvoicePayload {
    return decodeInvoicePayload(bytes, context)
  },
}

export function initInvoicePlugin(
  registry: MessageItemRegistry,
  _capabilities?: MessageItemPluginCapabilities,
): void {
  registry.registerApplication(createInvoicePlugin())
}
