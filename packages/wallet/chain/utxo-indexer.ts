/**
 * Unified UTXO Indexer abstraction.
 *
 * Provides a uniform API surface across UTXO blockchains:
 * - ChronikUtxoIndexer for eCash (XEC)
 * - ElectrumUtxoIndexer for Bitcoin (BTC), Bitcoin Cash (BCH), Dogecoin (DOGE), etc.
 */

import { ChronikClient, ScriptUtxos, WsEndpoint, ScriptType } from 'chronik-client'
import { Address } from 'ecash-lib/dist/address/address'
import {
  decodeAddress,
  lockingScript,
  decodeBase58Check,
  BTC_MAINNET,
  BTC_TESTNET,
  BCH_MAINNET,
  BCH_TESTNET,
  XEC_MAINNET,
  XEC_TESTNET,
} from '@frank/nakamoto'
import {
  ElectrumClient,
  toElectrumScriptHash,
  ElectrumClientOptions,
} from './electrum-client'
import type { ChainRegistryEntry } from './chains-registry'
import { getEcashChronikUrls } from './ecash-balance'
import type {
  ChainUtxoPool,
  ChainUtxoCoin,
  ChainUtxoOrigin,
} from '../chain-utxo-pool'

export interface UtxoItem {
  readonly txId: string
  readonly outputIndex: number
  readonly satoshis: bigint
  readonly script?: string
  readonly height?: number
}

export interface UtxoIndexer {
  readonly chainId: string
  fetchUtxos(scriptHashOrAddress: string): Promise<UtxoItem[]>
  fetchBalance(
    scriptHashOrAddress: string,
  ): Promise<{ confirmed: bigint; unconfirmed: bigint }>
  broadcastTx(rawTxHex: string): Promise<string>
  subscribe(
    scriptHashOrAddress: string,
    onUpdate: () => void,
  ): Promise<() => void>
  close(): Promise<void>
  syncToPool?(params: {
    address: string
    privateKey: string
    pool: ChainUtxoPool
    origin?: ChainUtxoOrigin
  }): Promise<ChainUtxoCoin[]>
}

/**
 * Synchronizes unspent transaction outputs from a UtxoIndexer into a ChainUtxoPool.
 */
export async function syncIndexerUtxosToPool(params: {
  indexer: UtxoIndexer
  address: string
  privateKey: string
  pool: ChainUtxoPool
  chain?: string
  origin?: ChainUtxoOrigin
}): Promise<ChainUtxoCoin[]> {
  const {
    indexer,
    address,
    privateKey,
    pool,
    chain = indexer.chainId,
    origin = 'utxo',
  } = params
  const utxos = await indexer.fetchUtxos(address)
  return utxos.map(u =>
    pool.utxo.registerOutpoint({
      chain,
      address,
      privateKey,
      txid: u.txId,
      vout: u.outputIndex,
      balanceWei: u.satoshis,
      origin,
    }),
  )
}

/**
 * Resolves an address (Base58Check, CashAddress, Bech32/Bech32m) or scriptPubKey hex
 * into a 64-character Electrum scripthash.
 */
export function resolveElectrumScriptHash(input: string): string {
  const trimmed = input.trim()

  // 1. Already an Electrum scripthash (32 bytes hex = 64 hex characters)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  // 2. CashAddress (BCH / eCash)
  try {
    const cash = Address.fromCashAddress(trimmed.toLowerCase())
    const hashHex =
      typeof cash.hash === 'string'
        ? cash.hash
        : Buffer.from(cash.hash).toString('hex')
    const scriptHex =
      cash.type === 'p2pkh' ? '76a914' + hashHex + '88ac' : 'a914' + hashHex + '87'
    return toElectrumScriptHash(scriptHex)
  } catch {}

  // 3. Bech32 / Bech32m Segwit (BTC mainnet / testnet)
  if (trimmed.startsWith('bc1') || trimmed.startsWith('tb1')) {
    const chain = trimmed.startsWith('tb1') ? BTC_TESTNET : BTC_MAINNET
    const dec = decodeAddress(trimmed, chain)
    if (dec.ok) {
      const script = lockingScript(dec.value.destination)
      return toElectrumScriptHash(script)
    }
  }

  // 4. Multi-chain address resolution via @frank/nakamoto
  const chains = [
    BTC_MAINNET,
    BCH_MAINNET,
    XEC_MAINNET,
    BTC_TESTNET,
    BCH_TESTNET,
    XEC_TESTNET,
  ]
  for (const chain of chains) {
    try {
      const dec = decodeAddress(trimmed, chain)
      if (dec.ok) {
        const script = lockingScript(dec.value.destination)
        return toElectrumScriptHash(script)
      }
    } catch {}
  }

  // 5. Base58Check for Dogecoin (0x1e P2PKH, 0x16 P2SH) and other UTXO networks
  try {
    const dec = decodeBase58Check(trimmed)
    if (dec.ok && dec.value.length === 21) {
      const ver = dec.value[0]
      const payload = dec.value.slice(1)
      if (ver === 0x1e || ver === 0x00 || ver === 0x6f) {
        const script = new Uint8Array([0x76, 0xa9, 0x14, ...payload, 0x88, 0xac])
        return toElectrumScriptHash(script)
      }
      if (ver === 0x16 || ver === 0x05 || ver === 0xc4) {
        const script = new Uint8Array([0xa9, 0x14, ...payload, 0x87])
        return toElectrumScriptHash(script)
      }
    }
  } catch {}

  // 6. Raw scriptPubKey hex
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return toElectrumScriptHash(trimmed)
  }

  throw new Error(`Unable to resolve Electrum scripthash from input: ${input}`)
}

export class ElectrumUtxoIndexer implements UtxoIndexer {
  readonly chainId: string
  readonly client: ElectrumClient

  constructor(chainId: string, client: ElectrumClient) {
    this.chainId = chainId
    this.client = client
  }

  async fetchUtxos(scriptHashOrAddress: string): Promise<UtxoItem[]> {
    const scriptHash = resolveElectrumScriptHash(scriptHashOrAddress)
    const elUtxos = await this.client.listUnspent(scriptHash)
    return elUtxos.map(u => ({
      txId: u.tx_hash,
      outputIndex: u.tx_pos,
      satoshis: BigInt(u.value),
      height: u.height > 0 ? u.height : undefined,
    }))
  }

  async fetchBalance(
    scriptHashOrAddress: string,
  ): Promise<{ confirmed: bigint; unconfirmed: bigint }> {
    const scriptHash = resolveElectrumScriptHash(scriptHashOrAddress)
    const balance = await this.client.getBalance(scriptHash)
    return {
      confirmed: BigInt(balance.confirmed),
      unconfirmed: BigInt(balance.unconfirmed),
    }
  }

  async broadcastTx(rawTxHex: string): Promise<string> {
    return this.client.broadcastTransaction(rawTxHex)
  }

  async subscribe(
    scriptHashOrAddress: string,
    onUpdate: () => void,
  ): Promise<() => void> {
    const scriptHash = resolveElectrumScriptHash(scriptHashOrAddress)
    await this.client.subscribeScriptHash(scriptHash, () => onUpdate())
    return async () => {
      await this.client.unsubscribeScriptHash(scriptHash)
    }
  }

  async close(): Promise<void> {
    await this.client.close()
  }

  async syncToPool(params: {
    address: string
    privateKey: string
    pool: ChainUtxoPool
    origin?: ChainUtxoOrigin
  }): Promise<ChainUtxoCoin[]> {
    return syncIndexerUtxosToPool({
      indexer: this,
      address: params.address,
      privateKey: params.privateKey,
      pool: params.pool,
      chain: this.chainId,
      origin: params.origin,
    })
  }
}

export class ChronikUtxoIndexer implements UtxoIndexer {
  readonly chainId: string
  readonly chronik: ChronikClient
  private wsEndpoint?: WsEndpoint
  private readonly subscribers = new Map<string, Set<() => void>>()

  constructor(chainId: string, chronik: ChronikClient) {
    this.chainId = chainId
    this.chronik = chronik
  }

  private parseTarget(scriptHashOrAddress: string): {
    type: ScriptType
    hash: string
  } {
    const trimmed = scriptHashOrAddress.trim().toLowerCase()

    try {
      const parsed = Address.fromCashAddress(trimmed)
      const hash =
        typeof parsed.hash === 'string'
          ? parsed.hash
          : Buffer.from(parsed.hash).toString('hex')
      return {
        type: parsed.type as ScriptType,
        hash,
      }
    } catch {}

    for (const chain of [XEC_MAINNET, XEC_TESTNET, BCH_MAINNET, BCH_TESTNET]) {
      try {
        const dec = decodeAddress(trimmed, chain)
        if (dec.ok) {
          if (dec.value.destination.kind === 'p2pkh') {
            return {
              type: 'p2pkh',
              hash: Buffer.from(dec.value.destination.hash).toString('hex'),
            }
          }
          if (dec.value.destination.kind === 'p2sh') {
            return {
              type: 'p2sh',
              hash: Buffer.from(dec.value.destination.hash).toString('hex'),
            }
          }
        }
      } catch {}
    }

    if (/^[0-9a-f]{40}$/.test(trimmed)) {
      return { type: 'p2pkh', hash: trimmed }
    }

    if (/^[0-9a-f]{64}$/.test(trimmed)) {
      return { type: 'p2sh', hash: trimmed }
    }

    throw new Error(
      `Unable to parse target script or address for Chronik: ${scriptHashOrAddress}`,
    )
  }

  async fetchUtxos(scriptHashOrAddress: string): Promise<UtxoItem[]> {
    const { type, hash } = this.parseTarget(scriptHashOrAddress)
    const scriptRes = await this.chronik.script(type, hash).utxos()
    const groups: ScriptUtxos[] = Array.isArray(scriptRes)
      ? scriptRes
      : (scriptRes as any)?.utxos
        ? [scriptRes as any]
        : []

    const utxos: UtxoItem[] = []
    for (const group of groups) {
      for (const u of (group.utxos ?? []) as any[]) {
        const rawSats = u.sats !== undefined ? u.sats : u.value !== undefined ? u.value : 0n
        const sats = typeof rawSats === 'bigint' ? rawSats : BigInt(rawSats)
        utxos.push({
          txId: u.outpoint.txid,
          outputIndex: u.outpoint.outIdx,
          satoshis: sats,
          script: group.outputScript,
          height: u.blockHeight > 0 ? u.blockHeight : undefined,
        })
      }
    }
    return utxos
  }

  async fetchBalance(
    scriptHashOrAddress: string,
  ): Promise<{ confirmed: bigint; unconfirmed: bigint }> {
    const { type, hash } = this.parseTarget(scriptHashOrAddress)
    const scriptRes = await this.chronik.script(type, hash).utxos()
    const groups: ScriptUtxos[] = Array.isArray(scriptRes)
      ? scriptRes
      : (scriptRes as any)?.utxos
        ? [scriptRes as any]
        : []

    let confirmed = 0n
    let unconfirmed = 0n
    for (const group of groups) {
      for (const u of (group.utxos ?? []) as any[]) {
        const rawSats = u.sats !== undefined ? u.sats : u.value !== undefined ? u.value : 0n
        const sats = typeof rawSats === 'bigint' ? rawSats : BigInt(rawSats)
        if (u.blockHeight > 0) {
          confirmed += sats
        } else {
          unconfirmed += sats
        }
      }
    }
    return { confirmed, unconfirmed }
  }

  async broadcastTx(rawTxHex: string): Promise<string> {
    const cleanHex = rawTxHex.replace(/^0x/, '')
    const res = await this.chronik.broadcastTx(cleanHex)
    return res.txid
  }

  async subscribe(
    scriptHashOrAddress: string,
    onUpdate: () => void,
  ): Promise<() => void> {
    const { type, hash } = this.parseTarget(scriptHashOrAddress)
    const key = `${type}:${hash}`
    let listeners = this.subscribers.get(key)
    if (!listeners) {
      listeners = new Set()
      this.subscribers.set(key, listeners)
    }
    listeners.add(onUpdate)

    this.ensureWs()
    try {
      const ep = this.wsEndpoint as any
      if (typeof ep?.subscribeToScript === 'function') {
        ep.subscribeToScript(type, hash)
      } else if (typeof ep?.subscribe === 'function') {
        ep.subscribe(type, hash)
      }
    } catch {}

    return () => {
      const list = this.subscribers.get(key)
      if (list) {
        list.delete(onUpdate)
        if (list.size === 0) {
          this.subscribers.delete(key)
          try {
            const ep = this.wsEndpoint as any
            if (typeof ep?.unsubscribeFromScript === 'function') {
              ep.unsubscribeFromScript(type, hash)
            } else if (typeof ep?.unsubscribe === 'function') {
              ep.unsubscribe(type, hash)
            }
          } catch {}
        }
      }
    }
  }

  private ensureWs(): void {
    if (!this.wsEndpoint) {
      this.wsEndpoint = this.chronik.ws({
        onMessage: (_msg: unknown) => {
          for (const set of this.subscribers.values()) {
            for (const cb of set) {
              try {
                cb()
              } catch {}
            }
          }
        },
      })
    }
  }

  async close(): Promise<void> {
    if (this.wsEndpoint) {
      try {
        this.wsEndpoint.close()
      } catch {}
      this.wsEndpoint = undefined
    }
    this.subscribers.clear()
  }

  async syncToPool(params: {
    address: string
    privateKey: string
    pool: ChainUtxoPool
    origin?: ChainUtxoOrigin
  }): Promise<ChainUtxoCoin[]> {
    return syncIndexerUtxosToPool({
      indexer: this,
      address: params.address,
      privateKey: params.privateKey,
      pool: params.pool,
      chain: this.chainId,
      origin: params.origin,
    })
  }
}

export interface CreateUtxoIndexerOptions {
  /** Injected ElectrumClient instance (takes priority for non-eCash chains). */
  readonly electrumClient?: ElectrumClient
  /** ElectrumClient options for non-eCash chains. */
  readonly electrumOptions?: Partial<ElectrumClientOptions>
  /** Injected ChronikClient instance (takes priority for eCash chains). */
  readonly chronikClient?: ChronikClient
  /** Direct Chronik URLs override for eCash chains. */
  readonly chronikUrls?: string[]
  /** Relay base URL to route eCash Chronik queries. */
  readonly relayBaseUrl?: string
}

/**
 * Creates a unified UtxoIndexer for the given chain configuration:
 * - ChronikUtxoIndexer for eCash chains (kind: 'ecash')
 * - ElectrumUtxoIndexer for BTC, BCH, Dogecoin, and other UTXO chains.
 */
export function createUtxoIndexer(
  chainConfig: ChainRegistryEntry,
  options?: CreateUtxoIndexerOptions,
): UtxoIndexer {
  if (chainConfig.kind === 'ecash') {
    if (options?.chronikClient) {
      return new ChronikUtxoIndexer(chainConfig.id, options.chronikClient)
    }
    const networkId =
      chainConfig.id === 'xec-testnet' ? 'xec-testnet' : 'xec-mainnet'
    const urls = getEcashChronikUrls({
      networkId,
      relayBaseUrl: options?.relayBaseUrl,
      chronikUrls: options?.chronikUrls,
    })
    let chronik: ChronikClient
    try {
      chronik = new (ChronikClient as any)(urls)
    } catch {
      chronik = new (ChronikClient as any)(urls[0] ?? 'https://chronik.e.cash')
    }
    return new ChronikUtxoIndexer(chainConfig.id, chronik)
  }

  if (options?.electrumClient) {
    return new ElectrumUtxoIndexer(chainConfig.id, options.electrumClient)
  }

  const endpoints =
    options?.electrumOptions?.endpoints ??
    chainConfig.electrumServers ??
    []

  if (endpoints.length === 0) {
    throw new Error(
      `No Electrum server endpoints configured for chain ${chainConfig.id}`,
    )
  }

  const electrumClient = new ElectrumClient({
    endpoints,
    ...options?.electrumOptions,
  })

  return new ElectrumUtxoIndexer(chainConfig.id, electrumClient)
}
