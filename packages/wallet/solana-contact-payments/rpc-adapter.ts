import { PublicKey, VersionedMessage, VersionedTransaction, PACKET_DATA_SIZE } from '@solana/web3.js'
import { getBase58Decoder, getBase58Encoder } from '@solana/codecs-strings'
import { ed25519 } from '@noble/curves/ed25519'
import protocol from '../../../docs/protocol/chains/v1.json'
import type { ExperimentalSolanaPaymentRpc } from './engine'
import type { SolanaReceiptEvidence, SolanaTokenBalanceEvidence } from './receipt'
import { u64 } from './amount'
import { associatedAccount } from './transaction-policy'

const CLASSIC_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const base58 = getBase58Decoder(), unbase58 = getBase58Encoder()
export interface SolanaJsonRpcTransport {
  /** Returns the JSON-RPC result, or throws; endpoint selection belongs to composition. */
  request(method: string, params: readonly unknown[]): Promise<unknown>
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Solana RPC object')
  return value as Record<string, unknown>
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Malformed Solana RPC array')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe Solana RPC integer')
  return value
}
function numericU64(value: unknown): string { return u64(integer(value).toString()).toString() }
function address(value: unknown): string {
  if (typeof value !== 'string' || value.length > 44 || new PublicKey(value).toBase58() !== value) throw new Error('Malformed Solana RPC public key')
  return value
}
function signature(value: unknown): string {
  if (typeof value !== 'string' || value.length > 88 || unbase58.encode(value).length !== 64 || base58.decode(unbase58.encode(value)) !== value) throw new Error('Malformed Solana RPC signature')
  return value
}
function encodedBytes(value: unknown, maxLength: number): Uint8Array {
  const tuple = list(value)
  if (tuple.length !== 2 || tuple[1] !== 'base64' || typeof tuple[0] !== 'string' || tuple[0].length > Math.ceil(maxLength / 3) * 4) throw new Error('Malformed Solana RPC base64 tuple')
  const bytes = Buffer.from(tuple[0], 'base64')
  if (bytes.length > maxLength || bytes.toString('base64') !== tuple[0]) throw new Error('Noncanonical Solana RPC base64')
  return Uint8Array.from(bytes)
}
function errorField(row: Record<string, unknown>): unknown | null {
  if (!Object.hasOwn(row, 'err') || row.err === undefined || (row.err !== null && !(typeof row.err === 'string' && row.err.length > 0 && row.err.length <= 128) && (typeof row.err !== 'object' || Array.isArray(row.err)))) throw new Error('Malformed Solana transaction error')
  return row.err
}
function transaction(original: Uint8Array): VersionedTransaction {
  if (!original.length || original.length > PACKET_DATA_SIZE) throw new Error('Invalid original transaction size')
  const tx = VersionedTransaction.deserialize(original), message = tx.message
  if (message.version !== 0 || message.addressTableLookups.length || tx.signatures.length !== 1 || message.header.numRequiredSignatures !== 1 || !Buffer.from(tx.serialize()).equals(Buffer.from(original)) || !ed25519.verify(tx.signatures[0], message.serialize(), message.staticAccountKeys[0].toBytes(), { zip215: false })) throw new Error('Unsupported or invalid original transaction')
  return tx
}
function tokenRows(value: unknown, accountCount: number): SolanaTokenBalanceEvidence[] {
  const seen = new Set<number>()
  return list(value).map(item => {
    const row = record(item), accountIndex = integer(row.accountIndex), token = record(row.uiTokenAmount)
    if (accountIndex >= accountCount || seen.has(accountIndex) || row.programId !== CLASSIC_TOKEN || typeof token.amount !== 'string') throw new Error('Unsupported or malformed token balance evidence')
    seen.add(accountIndex)
    const decimals = integer(token.decimals)
    if (decimals > 255) throw new Error('Invalid token decimals')
    return { accountIndex, mint: address(row.mint), owner: address(row.owner), program: CLASSIC_TOKEN, decimals, amount: u64(token.amount).toString() }
  })
}

/** Explicit endpoint, explicit HTTP dependency. No global/default network or wallet state. */
export function createSolanaHttpTransport(endpoint: string, fetcher: typeof fetch): SolanaJsonRpcTransport {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid Solana RPC endpoint')
  let nextId = 0
  return { async request(method, params) {
    const id = ++nextId
    const response = await fetcher(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`)
    const envelope = record(await response.json())
    if (envelope.jsonrpc !== '2.0' || envelope.id !== id || Object.hasOwn(envelope, 'error') || !Object.hasOwn(envelope, 'result')) throw new Error('Invalid or rejected Solana RPC response')
    return envelope.result
  } }
}

/** Financial reads always recheck the bound registry identity, including after reopen.
 * No result cache can turn a switched endpoint into an implicitly trusted network. */
export class CanonicalSolanaPaymentRpc implements ExperimentalSolanaPaymentRpc {
  private readonly expectedGenesis: string
  constructor(readonly chainIdentifier: string, private readonly transport: SolanaJsonRpcTransport) {
    const expected = protocol.chains.find(row => row.id === chainIdentifier && row.family === 'solana')?.identity_probes.find(probe => probe.kind === 'genesis-hash')?.expected
    if (!expected) throw new Error('Unsupported canonical Solana chain')
    this.expectedGenesis = expected
  }
  async getGenesisHash(): Promise<string> {
    const actual = await this.transport.request('getGenesisHash', [])
    if (actual !== this.expectedGenesis) throw new Error('Solana RPC chain identity mismatch')
    return this.expectedGenesis
  }
  private async financial(method: string, params: readonly unknown[]): Promise<unknown> {
    await this.getGenesisHash()
    return this.transport.request(method, params)
  }
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const response = record(await this.financial('getLatestBlockhash', [{ commitment: 'finalized' }]))
    integer(record(response.context).slot)
    const value = record(response.value)
    return { blockhash: address(value.blockhash), lastValidBlockHeight: integer(value.lastValidBlockHeight) }
  }
  async hasInitializedTokenAccount(accountAddress: string, expected: { owner: string; mint: string; program: string; decimals: number }): Promise<boolean> {
    address(accountAddress); address(expected.owner); address(expected.mint)
    if (accountAddress !== associatedAccount(expected.owner, expected.mint)) throw new Error('Expected classic associated token account')
    if (expected.program !== CLASSIC_TOKEN || !Number.isInteger(expected.decimals) || expected.decimals < 0 || expected.decimals > 255) throw new Error('Unsupported token account policy')
    const response = record(await this.financial('getMultipleAccounts', [[accountAddress, expected.mint], { commitment: 'finalized', encoding: 'base64' }]))
    integer(record(response.context).slot)
    const values = list(response.value)
    if (values.length !== 2) throw new Error('Incomplete token account observation')
    const mint = record(values[1]), mintBytes = encodedBytes(mint.data, 82)
    if (mint.owner !== CLASSIC_TOKEN || mint.executable !== false || mintBytes.length !== 82 || mintBytes[45] !== 1 || mintBytes[44] !== expected.decimals) throw new Error('Invalid classic mint observation')
    numericU64(mint.lamports)
    if (values[0] === null) return false
    const account = record(values[0]), bytes = encodedBytes(account.data, 165)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (account.owner !== CLASSIC_TOKEN || account.executable !== false || bytes.length !== 165 || new PublicKey(bytes.slice(0, 32)).toBase58() !== expected.mint || new PublicKey(bytes.slice(32, 64)).toBase58() !== expected.owner || bytes[108] !== 1 || view.getUint32(72, true) !== 0 || view.getUint32(109, true) !== 0 || view.getUint32(129, true) !== 0) throw new Error('Invalid classic initialized token account')
    numericU64(account.lamports)
    return true
  }
  async getFeeForMessage(message: Uint8Array): Promise<string | null> {
    const captured = Uint8Array.from(message)
    if (!captured.length || captured.length > PACKET_DATA_SIZE || VersionedMessage.deserialize(captured).version !== 0) throw new Error('Unsupported fee message')
    const response = record(await this.financial('getFeeForMessage', [Buffer.from(captured).toString('base64'), { commitment: 'finalized' }]))
    integer(record(response.context).slot)
    return response.value === null ? null : numericU64(response.value)
  }
  async getTokenAccountRentLamports(): Promise<string> {
    return numericU64(await this.financial('getMinimumBalanceForRentExemption', [165, { commitment: 'finalized' }]))
  }
  async sendRawTransaction(original: Uint8Array): Promise<string> {
    const captured = Uint8Array.from(original), tx = transaction(captured), expected = base58.decode(tx.signatures[0])
    const actual = signature(await this.financial('sendTransaction', [Buffer.from(captured).toString('base64'), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 }]))
    if (actual !== expected) throw new Error('RPC returned another original signature')
    return actual
  }
  async getFinalizedSignature(txSignature: string): Promise<{ outcome: 'confirmed' | 'failed'; slot: number } | null> {
    signature(txSignature)
    const response = record(await this.financial('getSignatureStatuses', [[txSignature], { searchTransactionHistory: true }]))
    integer(record(response.context).slot)
    const values = list(response.value)
    if (values.length !== 1) throw new Error('Malformed signature status cardinality')
    if (values[0] === null) return null
    const status = record(values[0]), slot = integer(status.slot), err = errorField(status)
    if (!['processed', 'confirmed', 'finalized'].includes(String(status.confirmationStatus))) throw new Error('Malformed signature finality')
    if (status.confirmationStatus !== 'finalized') return null
    if (status.confirmations !== null) throw new Error('Inconsistent finalized signature status')
    return { outcome: err === null ? 'confirmed' : 'failed', slot }
  }
  async getFinalizedTransaction(txSignature: string): Promise<SolanaReceiptEvidence | null> {
    signature(txSignature)
    const response = await this.financial('getTransaction', [txSignature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }])
    if (response === null) return null
    const row = record(response), slot = integer(row.slot)
    if (row.version !== 0) throw new Error('Unsupported finalized transaction version')
    const signedTransaction = encodedBytes(row.transaction, PACKET_DATA_SIZE), tx = transaction(signedTransaction)
    if (base58.decode(tx.signatures[0]) !== txSignature) throw new Error('Finalized transaction signature mismatch')
    const meta = record(row.meta), err = errorField(meta), count = tx.message.staticAccountKeys.length
    const preBalances = list(meta.preBalances).map(numericU64), postBalances = list(meta.postBalances).map(numericU64)
    if (preBalances.length !== count || postBalances.length !== count) throw new Error('Incomplete finalized balance metadata')
    const loaded = record(meta.loadedAddresses)
    if (list(loaded.writable).length || list(loaded.readonly).length) throw new Error('Unsupported loaded address evidence')
    return { signedTransaction, slot, err, preBalances, postBalances, preTokenBalances: tokenRows(meta.preTokenBalances, count), postTokenBalances: tokenRows(meta.postTokenBalances, count) }
  }
}
