import { PublicKey, VersionedMessage, VersionedTransaction, PACKET_DATA_SIZE } from '@solana/web3.js'
import { getBase58Decoder, getBase58Encoder } from '@solana/codecs-strings'
import { parseJsonWithBigInts } from '@solana/rpc-spec-types'
import { ed25519 } from '@noble/curves/ed25519'
import protocol from '../../../docs/protocol/chains/v1.json'
import type { SolanaPaymentAsset } from './types'
import type { ExperimentalSolanaPaymentRpc } from './engine'
import type { SolanaReceiptEvidence, SolanaTokenBalanceEvidence } from './receipt'
import { u64 } from './amount'
import { associatedAccount } from './transaction-policy'

const CLASSIC_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const base58 = getBase58Decoder(), unbase58 = getBase58Encoder()
export interface SolanaJsonRpcTransport {
  /** HTTP text parser preserves integer tokens as bigints; fractional tokens are
   * untrusted for every critical numeric field. Injected decoded transports may
   * omit this marker only when they already provide safe, exact numeric values. */
  readonly integerEncoding?: 'bigint'

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
function integer(value: unknown, exactTokens = false): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe Solana RPC integer')
    return Number(value)
  }
  if (exactTokens) throw new Error('Expected exact Solana RPC integer token')
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe Solana RPC integer')
  return value
}
function numericU64(value: unknown, exactTokens = false): string {
  if (typeof value === 'bigint') return u64(value.toString()).toString()
  return u64(integer(value, exactTokens).toString()).toString()
}
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
function tokenRows(value: unknown, accountCount: number, exactTokens: boolean): SolanaTokenBalanceEvidence[] {
  const seen = new Set<number>()
  return list(value).map(item => {
    const row = record(item), accountIndex = integer(row.accountIndex, exactTokens), token = record(row.uiTokenAmount)
    if (accountIndex >= accountCount || seen.has(accountIndex) || row.programId !== CLASSIC_TOKEN || typeof token.amount !== 'string') throw new Error('Unsupported or malformed token balance evidence')
    seen.add(accountIndex)
    const decimals = integer(token.decimals, exactTokens)
    if (decimals > 255) throw new Error('Invalid token decimals')
    return { accountIndex, mint: address(row.mint), owner: address(row.owner), program: CLASSIC_TOKEN, decimals, amount: u64(token.amount).toString() }
  })
}

export interface SolanaOwnedBalances {
  finalizedSlot: number
  nativeBalance: string
  /** Null means absent ATA; initialized zero is a distinct exact observation. */
  assetBalance: { address: string; asset: SolanaPaymentAsset; balance: string } | null
}
export interface SolanaClassicAssetDiscovery {
  finalizedSlot: number
  assets: Extract<SolanaPaymentAsset, { kind: 'spl' }>[]
}

/** Explicit endpoint, explicit HTTP dependency. No global/default network or wallet state. */
export function createSolanaHttpTransport(endpoint: string, fetcher: typeof fetch): SolanaJsonRpcTransport {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid Solana RPC endpoint')
  let nextId = 0
  return { integerEncoding: 'bigint', async request(method, params) {
    const id = ++nextId
    const response = await fetcher(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`)
    const text = await response.text()
    // Upstream reserves {$n:...} internally. Reject such wire objects before its
    // parser can reinterpret them; no rounded value from this scan is consumed.
    JSON.parse(text, (_key, value: unknown) => {
      if (value && typeof value === 'object' && Object.hasOwn(value, '$n')) throw new Error('Reserved Solana RPC numeric representation')
      return value
    })
    const envelope = record(parseJsonWithBigInts(text))
    if (envelope.jsonrpc !== '2.0' || integer(envelope.id, true) !== id || Object.hasOwn(envelope, 'error') || !Object.hasOwn(envelope, 'result')) throw new Error('Invalid or rejected Solana RPC response')
    return envelope.result
  } }
}

/** Financial reads always recheck the bound registry identity, including after reopen.
 * No result cache can turn a switched endpoint into an implicitly trusted network. */
export class CanonicalSolanaPaymentRpc implements ExperimentalSolanaPaymentRpc {
  private readonly expectedGenesis: string
  private integer(value: unknown): number { return integer(value, this.transport.integerEncoding === 'bigint') }
  private amount(value: unknown): string { return numericU64(value, this.transport.integerEncoding === 'bigint') }
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
    this.integer(record(response.context).slot)
    const value = record(response.value)
    return { blockhash: address(value.blockhash), lastValidBlockHeight: this.integer(value.lastValidBlockHeight) }
  }
  private classicMint(value: unknown, expectedDecimals?: number): number {
    const mint = record(value), bytes = encodedBytes(mint.data, 82)
    if (mint.owner !== CLASSIC_TOKEN || mint.executable !== false || bytes.length !== 82 || bytes[45] !== 1) throw new Error('Invalid classic mint observation')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (![0, 1].includes(view.getUint32(0, true)) || ![0, 1].includes(view.getUint32(46, true)) || (expectedDecimals !== undefined && bytes[44] !== expectedDecimals)) throw new Error('Invalid classic mint observation')
    this.amount(mint.lamports)
    return bytes[44]
  }
  private classicAccount(value: unknown, expectedOwner: string): { mint: string; balance: string; eligible: boolean } {
    const account = record(value), bytes = encodedBytes(account.data, 165)
    if (account.owner !== CLASSIC_TOKEN || account.executable !== false || bytes.length !== 165) throw new Error('Invalid classic token account observation')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const options = [view.getUint32(72, true), view.getUint32(109, true), view.getUint32(129, true)]
    if (new PublicKey(bytes.slice(32, 64)).toBase58() !== expectedOwner || !options.every(flag => flag === 0 || flag === 1) || ![0, 1, 2].includes(bytes[108])) throw new Error('Invalid classic token account ownership/layout')
    this.amount(account.lamports)
    return { mint: new PublicKey(bytes.slice(0, 32)).toBase58(), balance: view.getBigUint64(64, true).toString(), eligible: bytes[108] === 1 && options.every(flag => flag === 0) }
  }
  private selectedAsset(value: SolanaPaymentAsset): SolanaPaymentAsset {
    const asset = structuredClone(value)
    if (!asset || (asset.kind === 'native' ? Object.keys(asset).join() !== 'kind' : asset.kind !== 'spl' || Object.keys(asset).sort().join() !== 'decimals,kind,mint,program' || asset.program !== CLASSIC_TOKEN || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255)) throw new Error('Unsupported selected Solana asset')
    if (asset.kind === 'spl') address(asset.mint)
    return asset
  }
  private async accounts(addresses: readonly string[], minContextSlot?: number): Promise<{ slot: number; values: unknown[] }> {
    if (!addresses.length || addresses.length > 100) throw new Error('Invalid Solana RPC account batch')
    addresses.forEach(address)
    const response = record(await this.financial('getMultipleAccounts', [addresses, { commitment: 'finalized', encoding: 'base64', ...(minContextSlot === undefined ? {} : { minContextSlot }) }]))
    const slot = this.integer(record(response.context).slot), values = list(response.value)
    if (values.length !== addresses.length || (minContextSlot !== undefined && slot < minContextSlot)) throw new Error('Incomplete or incoherent finalized account context')
    return { slot, values }
  }
  async hasInitializedTokenAccount(accountAddress: string, expected: { owner: string; mint: string; program: string; decimals: number }): Promise<boolean> {
    address(accountAddress); address(expected.owner)
    const asset = this.selectedAsset({ kind: 'spl', mint: expected.mint, program: expected.program, decimals: expected.decimals })
    if (asset.kind !== 'spl' || accountAddress !== associatedAccount(expected.owner, asset.mint)) throw new Error('Expected classic associated token account')
    const response = await this.accounts([accountAddress, asset.mint])
    this.classicMint(response.values[1], asset.decimals)
    if (response.values[0] === null) return false
    const token = this.classicAccount(response.values[0], expected.owner)
    if (!token.eligible || token.mint !== asset.mint) throw new Error('Invalid classic initialized token account')
    return true
  }
  /** First-receipt metadata does not require an existing recipient ATA. */
  async readClassicMint(input: { mint: string; program: string }): Promise<{ mint: string; program: string; decimals: number; finalizedSlot: number }> {
    if (!input || Object.keys(input).sort().join() !== 'mint,program' || input.program !== CLASSIC_TOKEN) throw new Error('Only the classic token program is supported')
    const mint = address(input.mint)
    const observed = await this.accounts([mint])
    const decimals = this.classicMint(observed.values[0])
    return { mint, program: CLASSIC_TOKEN, decimals, finalizedSlot: observed.slot }
  }
  async readOwnedBalances(input: { owner: string; selectedAsset: SolanaPaymentAsset }): Promise<SolanaOwnedBalances> {
    const owner = address(input.owner), asset = this.selectedAsset(input.selectedAsset)
    const ata = asset.kind === 'spl' ? associatedAccount(owner, asset.mint) : undefined
    const observed = await this.accounts(asset.kind === 'spl' ? [owner, ata!, asset.mint] : [owner])
    let nativeBalance = '0'
    if (observed.values[0] !== null) {
      const native = record(observed.values[0])
      if (native.owner !== '11111111111111111111111111111111' || native.executable !== false || encodedBytes(native.data, 0).length) throw new Error('Invalid owned native System account')
      nativeBalance = this.amount(native.lamports)
    }
    if (asset.kind === 'native') return { finalizedSlot: observed.slot, nativeBalance, assetBalance: { address: owner, asset, balance: nativeBalance } }
    this.classicMint(observed.values[2], asset.decimals)
    if (observed.values[1] === null) return { finalizedSlot: observed.slot, nativeBalance, assetBalance: null }
    const token = this.classicAccount(observed.values[1], owner)
    if (!token.eligible || token.mint !== asset.mint) throw new Error('Invalid owned classic ATA')
    return { finalizedSlot: observed.slot, nativeBalance, assetBalance: { address: ata!, asset, balance: token.balance } }
  }
  async discoverClassicAssets(owner: string): Promise<SolanaClassicAssetDiscovery> {
    address(owner)
    const response = record(await this.financial('getTokenAccountsByOwner', [owner, { programId: CLASSIC_TOKEN }, { commitment: 'finalized', encoding: 'base64' }]))
    const discoverySlot = this.integer(record(response.context).slot), candidates: { ata: string; mint: string }[] = [], seen = new Set<string>()
    for (const item of list(response.value)) {
      const row = record(item), accountAddress = address(row.pubkey)
      if (seen.has(accountAddress)) throw new Error('Duplicate discovered token account')
      seen.add(accountAddress)
      const token = this.classicAccount(row.account, owner)
      if (token.eligible && accountAddress === associatedAccount(owner, token.mint)) candidates.push({ ata: accountAddress, mint: token.mint })
    }
    if (!candidates.length) return { finalizedSlot: discoverySlot, assets: [] }
    // Account query is an index lead, not complete evidence. Re-read all ATAs and
    // mints in coherent finalized batches, respecting Solana's 100-address cap.
    const addresses = [...new Set(candidates.flatMap(candidate => [candidate.ata, candidate.mint]))]
    const observed = new Map<string, unknown>()
    let finalizedSlot: number | undefined
    for (let offset = 0; offset < addresses.length; offset += 100) {
      const batch = addresses.slice(offset, offset + 100), current = await this.accounts(batch, discoverySlot)
      if (finalizedSlot !== undefined && current.slot !== finalizedSlot) throw new Error('Incoherent finalized discovery contexts')
      finalizedSlot = current.slot
      batch.forEach((key, index) => observed.set(key, current.values[index]))
    }
    const assets = candidates.map(candidate => {
      const token = this.classicAccount(observed.get(candidate.ata), owner)
      if (!token.eligible || token.mint !== candidate.mint) throw new Error('Discovered ATA changed during finalized observation')
      const decimals = this.classicMint(observed.get(candidate.mint))
      return { kind: 'spl' as const, mint: candidate.mint, program: CLASSIC_TOKEN, decimals }
    }).sort((a, b) => a.mint.localeCompare(b.mint))
    return { finalizedSlot: finalizedSlot!, assets }
  }
  async getFeeForMessage(message: Uint8Array): Promise<string | null> {
    const captured = Uint8Array.from(message)
    if (!captured.length || captured.length > PACKET_DATA_SIZE || VersionedMessage.deserialize(captured).version !== 0) throw new Error('Unsupported fee message')
    const response = record(await this.financial('getFeeForMessage', [Buffer.from(captured).toString('base64'), { commitment: 'finalized' }]))
    this.integer(record(response.context).slot)
    return response.value === null ? null : this.amount(response.value)
  }
  async getTokenAccountRentLamports(): Promise<string> {
    return this.amount(await this.financial('getMinimumBalanceForRentExemption', [165, { commitment: 'finalized' }]))
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
    this.integer(record(response.context).slot)
    const values = list(response.value)
    if (values.length !== 1) throw new Error('Malformed signature status cardinality')
    if (values[0] === null) return null
    const status = record(values[0]), slot = this.integer(status.slot), err = errorField(status)
    if (!['processed', 'confirmed', 'finalized'].includes(String(status.confirmationStatus))) throw new Error('Malformed signature finality')
    if (status.confirmationStatus !== 'finalized') return null
    if (status.confirmations !== null) throw new Error('Inconsistent finalized signature status')
    return { outcome: err === null ? 'confirmed' : 'failed', slot }
  }
  async getFinalizedTransaction(txSignature: string): Promise<SolanaReceiptEvidence | null> {
    signature(txSignature)
    const response = await this.financial('getTransaction', [txSignature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }])
    if (response === null) return null
    const row = record(response), slot = this.integer(row.slot)
    if (this.integer(row.version) !== 0) throw new Error('Unsupported finalized transaction version')
    const signedTransaction = encodedBytes(row.transaction, PACKET_DATA_SIZE), tx = transaction(signedTransaction)
    if (base58.decode(tx.signatures[0]) !== txSignature) throw new Error('Finalized transaction signature mismatch')
    const meta = record(row.meta), err = errorField(meta), count = tx.message.staticAccountKeys.length
    const preBalances = list(meta.preBalances).map(value => this.amount(value)), postBalances = list(meta.postBalances).map(value => this.amount(value))
    if (preBalances.length !== count || postBalances.length !== count) throw new Error('Incomplete finalized balance metadata')
    const loaded = record(meta.loadedAddresses)
    if (list(loaded.writable).length || list(loaded.readonly).length) throw new Error('Unsupported loaded address evidence')
    return { signedTransaction, slot, err, preBalances, postBalances, preTokenBalances: tokenRows(meta.preTokenBalances, count, this.transport.integerEncoding === 'bigint'), postTokenBalances: tokenRows(meta.postTokenBalances, count, this.transport.integerEncoding === 'bigint') }
  }
}
