import {
  Signature,
  Transaction,
  TypedDataEncoder,
  getBytes,
  hashMessage,
  keccak256,
  toUtf8Bytes,
} from 'ethers'
import { getRawExtensionApi } from '../../src-bex/runtime-adapter'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain'
import type { accountSession } from './session'

export interface ApprovedDappRequest {
  readonly id: string
  readonly origin: string
  readonly method: string
  readonly params: unknown
  readonly chainIdHex?: string
  readonly personaAddress?: string
  readonly personaRef?:
    | { kind: 'shared'; slot: number }
    | { kind: 'site'; origin: string }
}

export interface DappEvmAttempt {
  readonly chainIdentifier: string
  readonly account: string
  readonly nonce: number
  readonly intentHash: string
  readonly signedTransaction: string
  readonly transactionHash: string
}

export interface DappEvmAttemptStore {
  read(): Promise<readonly DappEvmAttempt[]>
  write(attempts: readonly DappEvmAttempt[]): Promise<void>
}

export interface DappRequestExecutorOptions {
  readonly attemptStore?: DappEvmAttemptStore
}

const DAPP_EVM_ATTEMPTS_STORAGE_KEY = 'frankDappEvmAttemptsV1'

function extensionAttemptStore(): DappEvmAttemptStore {
  const storage = getRawExtensionApi()?.storage?.local
  if (!storage?.get || !storage.set)
    throw new Error(
      'Frank cannot safely submit without durable transaction recovery storage',
    )
  return {
    async read() {
      const result = await storage.get(DAPP_EVM_ATTEMPTS_STORAGE_KEY)
      const rows = result?.[DAPP_EVM_ATTEMPTS_STORAGE_KEY]
      if (rows === undefined) return []
      if (!Array.isArray(rows))
        throw new Error('Stored dApp transaction recovery state is invalid')
      for (const row of rows) {
        if (
          !row ||
          typeof row !== 'object' ||
          typeof row.chainIdentifier !== 'string' ||
          typeof row.account !== 'string' ||
          !Number.isSafeInteger(row.nonce) ||
          typeof row.intentHash !== 'string' ||
          !/^0x[0-9a-f]{64}$/i.test(row.intentHash) ||
          typeof row.signedTransaction !== 'string' ||
          !/^0x[0-9a-f]+$/i.test(row.signedTransaction) ||
          typeof row.transactionHash !== 'string' ||
          !/^0x[0-9a-f]{64}$/i.test(row.transactionHash)
        )
          throw new Error('Stored dApp transaction recovery state is invalid')
      }
      return rows as DappEvmAttempt[]
    },
    async write(attempts) {
      await storage.set({ [DAPP_EVM_ATTEMPTS_STORAGE_KEY]: attempts })
    },
  }
}

const EVM_RPC: Record<string, string> = {
  '0x1': 'https://eth.llamarpc.com',
  '0x279f': 'https://testnet-rpc.monad.xyz',
  '0x8f': 'https://rpc.monad.xyz',
  '0xa': 'https://mainnet.optimism.io',
  '0x89': 'https://polygon-rpc.com',
  '0x2105': 'https://mainnet.base.org',
  '0xa4b1': 'https://arb1.arbitrum.io/rpc',
  '0x38': 'https://bsc-dataseed.binance.org',
  '0xa86a': 'https://api.avax.network/ext/bc/C/rpc',
  '0xaa36a7': 'https://ethereum-sepolia-rpc.publicnode.com',
}

function paramsArray(params: unknown): any[] {
  if (Array.isArray(params)) return params
  if (params && typeof params === 'object') return [params]
  return []
}

function quantity(value: unknown, label: string): bigint {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'bigint'
  )
    throw new Error(`Invalid ${label}`)
  return BigInt(value)
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  return value
}

function rpcQuantity(value: unknown, method: string): string {
  const result = stringValue(value, `RPC ${method} result`)
  if (!/^0x[0-9a-f]+$/i.test(result))
    throw new Error(`RPC ${method} returned an invalid quantity`)
  return result
}

function asBytes(value: unknown, label: string): Uint8Array {
  if (typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value))
    return getBytes(value)
  if (
    Array.isArray(value) &&
    value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    return Uint8Array.from(value)
  throw new Error(`Invalid ${label}`)
}

function requireApprovedPersonaAddress(
  request: ApprovedDappRequest,
  derived: string,
): void {
  if (
    typeof request.personaAddress !== 'string' ||
    request.personaAddress.toLowerCase() !== derived.toLowerCase()
  )
    throw new Error('This request is not bound to the approved site persona')
}

function normalizedIntentValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  )
    return BigInt(value).toString(10)
  throw new Error('Invalid EVM transaction intent field')
}

function dappTransactionIntentHash(
  chainIdentifier: string,
  transaction: Record<string, unknown>,
): string {
  const data =
    typeof transaction.data === 'string' ? transaction.data.toLowerCase() : '0x'
  const accessList = Array.isArray(transaction.accessList)
    ? transaction.accessList
    : null
  const intent = {
    chainIdentifier,
    from:
      typeof transaction.from === 'string'
        ? transaction.from.toLowerCase()
        : '',
    to:
      typeof transaction.to === 'string' ? transaction.to.toLowerCase() : null,
    value: normalizedIntentValue(transaction.value ?? '0x0'),
    data,
    requestedNonce: normalizedIntentValue(transaction.nonce),
    requestedType: normalizedIntentValue(transaction.type),
    gas: normalizedIntentValue(transaction.gas ?? transaction.gasLimit),
    gasPrice: normalizedIntentValue(transaction.gasPrice),
    maxFeePerGas: normalizedIntentValue(transaction.maxFeePerGas),
    maxPriorityFeePerGas: normalizedIntentValue(
      transaction.maxPriorityFeePerGas,
    ),
    accessList,
  }
  return keccak256(toUtf8Bytes(JSON.stringify(intent)))
}

async function retryExactEvmAttempt(
  url: string,
  attempt: DappEvmAttempt,
): Promise<string> {
  try {
    const hash = await rpc(url, 'eth_sendRawTransaction', [
      attempt.signedTransaction,
    ])
    if (
      typeof hash === 'string' &&
      hash.toLowerCase() === attempt.transactionHash.toLowerCase()
    )
      return attempt.transactionHash
    throw new Error(
      'EVM RPC returned a hash that does not match the stored transaction',
    )
  } catch (sendError) {
    const observed = await rpc(url, 'eth_getTransactionByHash', [
      attempt.transactionHash,
    ])
    if (observed && typeof observed === 'object') return attempt.transactionHash
    throw sendError
  }
}

async function rpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok)
    throw new Error(`RPC ${method} failed with HTTP ${response.status}`)
  const body = await response.json()
  if (body?.error)
    throw new Error(String(body.error.message || `RPC ${method} failed`))
  return body?.result
}

/** Executes only a request already approved by the extension approval page. */
export async function executeApprovedDappRequest(
  request: ApprovedDappRequest,
  session: Pick<
    typeof accountSession,
    'createDappPersonaSigner' | 'createDappSolanaSigner'
  >,
  options: DappRequestExecutorOptions = {},
): Promise<unknown> {
  if (!request || typeof request.origin !== 'string' || !request.origin)
    throw new Error('Invalid approved dApp request')

  if (request.method === 'personal_sign' || request.method === 'eth_sign') {
    const [first, second] = paramsArray(request.params)
    const address = request.method === 'eth_sign' ? first : second
    const raw = request.method === 'eth_sign' ? second : first
    const signer = await session.createDappPersonaSigner()
    const ref = request.personaRef ?? {
      kind: 'site' as const,
      origin: request.origin,
    }
    const [expected] = await signer.addresses([ref])
    requireApprovedPersonaAddress(request, expected)
    if (
      typeof address !== 'string' ||
      address.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error('Requested account does not match this site persona')
    const bytes = asBytes(raw, 'message')
    const digest =
      request.method === 'personal_sign' ? hashMessage(bytes) : keccak256(bytes)
    return signer.signDigest(ref, digest)
  }

  if (/^eth_signTypedData(?:_v[34])?$/.test(request.method)) {
    const [address, rawData] = paramsArray(request.params)
    const signer = await session.createDappPersonaSigner()
    const ref = request.personaRef ?? {
      kind: 'site' as const,
      origin: request.origin,
    }
    const [expected] = await signer.addresses([ref])
    requireApprovedPersonaAddress(request, expected)
    if (
      typeof address !== 'string' ||
      address.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error('Requested account does not match this site persona')
    const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
    const types = { ...data.types }
    delete types.EIP712Domain
    const digest = TypedDataEncoder.hash(data.domain, types, data.message)
    return signer.signDigest(ref, digest)
  }

  if (request.method === 'eth_sendTransaction') {
    const [rawTx] = paramsArray(request.params)
    if (!rawTx || typeof rawTx !== 'object')
      throw new Error('Invalid transaction')
    const txData = rawTx as Record<string, unknown>
    const chainIdHex = (request.chainIdHex ?? '').toLowerCase()
    const url = EVM_RPC[chainIdHex]
    if (!url)
      throw new Error(`Unsupported EVM chain: ${chainIdHex || 'unknown'}`)
    const signer = await session.createDappPersonaSigner()
    const ref = request.personaRef ?? {
      kind: 'site' as const,
      origin: request.origin,
    }
    const [expected] = await signer.addresses([ref])
    requireApprovedPersonaAddress(request, expected)
    if (
      typeof txData.from !== 'string' ||
      txData.from.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error('Transaction sender does not match this site persona')
    const chainEntry = Object.values(PROTOCOL_CHAINS).find(
      entry =>
        entry.family === 'evm' &&
        entry.nativeChainId !== undefined &&
        BigInt(entry.nativeChainId) === BigInt(chainIdHex),
    )
    if (!chainEntry) throw new Error(`Unregistered EVM chain: ${chainIdHex}`)
    const attemptStore = options.attemptStore ?? extensionAttemptStore()
    let attempts = [...(await attemptStore.read())]
    const intentHash = dappTransactionIntentHash(chainEntry.id, txData)
    const priorIntent = attempts.find(
      item =>
        item.chainIdentifier === chainEntry.id &&
        item.account.toLowerCase() === expected.toLowerCase() &&
        item.intentHash === intentHash,
    )
    if (priorIntent) {
      const receipt = await rpc(url, 'eth_getTransactionReceipt', [
        priorIntent.transactionHash,
      ])
      if (receipt === null || receipt === undefined) {
        return await retryExactEvmAttempt(url, priorIntent)
      }
      attempts = attempts.filter(item => item !== priorIntent)
      await attemptStore.write(attempts)
    }
    const chainId = BigInt(chainIdHex)
    if (
      txData.chainId !== undefined &&
      quantity(txData.chainId, 'transaction chain ID') !== chainId
    )
      throw new Error('Transaction chain does not match the selected chain')
    const requestedType =
      txData.type === undefined ? undefined : Number(txData.type)
    if (
      requestedType !== undefined &&
      requestedType !== 0 &&
      requestedType !== 2
    )
      throw new Error(`Unsupported EVM transaction type: ${requestedType}`)
    const nonce =
      txData.nonce === undefined
        ? Number.parseInt(
            rpcQuantity(
              await rpc(url, 'eth_getTransactionCount', [expected, 'pending']),
              'eth_getTransactionCount',
            ),
            16,
          )
        : Number(txData.nonce)
    const priorNonce = attempts.find(
      item =>
        item.chainIdentifier === chainEntry.id &&
        item.account.toLowerCase() === expected.toLowerCase() &&
        item.nonce === nonce,
    )
    if (priorNonce) {
      const receipt = await rpc(url, 'eth_getTransactionReceipt', [
        priorNonce.transactionHash,
      ])
      if (receipt === null || receipt === undefined)
        throw new Error(
          'An earlier transaction with this nonce is unresolved; retry its original request',
        )
      attempts = attempts.filter(item => item !== priorNonce)
      await attemptStore.write(attempts)
    }
    const gasLimit =
      txData.gas ??
      txData.gasLimit ??
      (await rpc(url, 'eth_estimateGas', [{ ...txData, from: expected }]))
    const tx: {
      chainId: bigint
      nonce: number
      to: string | null
      value: bigint
      data: string
      gasLimit: bigint
      type?: number
      accessList?: readonly unknown[]
      gasPrice?: bigint
      maxFeePerGas?: bigint
      maxPriorityFeePerGas?: bigint
    } = {
      chainId,
      nonce,
      to:
        txData.to === undefined || txData.to === null
          ? null
          : stringValue(txData.to, 'transaction recipient'),
      value: quantity(txData.value ?? '0x0', 'transaction value'),
      data:
        txData.data === undefined
          ? '0x'
          : stringValue(txData.data, 'transaction data'),
      gasLimit: quantity(gasLimit, 'transaction gas limit'),
      ...(requestedType !== undefined ? { type: requestedType } : {}),
      ...(Array.isArray(txData.accessList)
        ? { accessList: txData.accessList }
        : {}),
    }
    if (
      requestedType === 2 ||
      txData.maxFeePerGas !== undefined ||
      txData.maxPriorityFeePerGas !== undefined
    ) {
      tx.type = 2
      const gasPrice = quantity(
        txData.gasPrice ??
          rpcQuantity(await rpc(url, 'eth_gasPrice', []), 'eth_gasPrice'),
        'transaction gas price',
      )
      tx.maxFeePerGas = quantity(
        txData.maxFeePerGas ?? gasPrice,
        'maximum fee per gas',
      )
      tx.maxPriorityFeePerGas = quantity(
        txData.maxPriorityFeePerGas ?? gasPrice,
        'maximum priority fee per gas',
      )
    } else {
      tx.type = 0
      tx.gasPrice = quantity(
        txData.gasPrice ??
          rpcQuantity(await rpc(url, 'eth_gasPrice', []), 'eth_gasPrice'),
        'transaction gas price',
      )
    }
    const unsigned = Transaction.from(
      tx as Parameters<typeof Transaction.from>[0],
    )
    unsigned.signature = Signature.from(
      await signer.signDigest(ref, unsigned.unsignedHash),
    )
    const transactionHash = unsigned.hash
    if (!transactionHash)
      throw new Error('Could not compute the signed transaction hash')
    const attempt: DappEvmAttempt = {
      chainIdentifier: chainEntry.id,
      account: expected,
      nonce,
      intentHash,
      signedTransaction: unsigned.serialized,
      transactionHash,
    }
    await attemptStore.write([...attempts, attempt])
    const hash = await rpc(url, 'eth_sendRawTransaction', [unsigned.serialized])
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash))
      throw new Error('EVM RPC returned an invalid transaction hash')
    if (hash.toLowerCase() !== transactionHash.toLowerCase())
      throw new Error(
        'EVM RPC returned a transaction hash that does not match the signed transaction',
      )
    return hash
  }

  if (request.method.startsWith('solana_')) {
    const signer = await session.createDappSolanaSigner()
    const p =
      request.params && typeof request.params === 'object'
        ? (request.params as any)
        : {}
    if (request.method === 'solana_connect') {
      const { PublicKey } = await import('@solana/web3.js')
      const publicKey = new PublicKey(signer.publicKey).toBytes()
      return { address: signer.publicKey, publicKey: Array.from(publicKey) }
    }
    if (request.method === 'solana_signMessage') {
      if (p.account && p.account !== signer.publicKey)
        throw new Error('Requested Solana account does not match Frank')
      const signature = await signer.signMessage(
        asBytes(p.message, 'Solana message'),
      )
      return { signature: Array.from(signature) }
    }
    if (
      request.method === 'solana_signTransaction' ||
      request.method === 'solana_signAndSendTransaction'
    ) {
      if (p.account && p.account !== signer.publicKey)
        throw new Error('Requested Solana account does not match Frank')
      const signed = await signer.signTransaction(
        asBytes(p.transaction, 'Solana transaction'),
      )
      if (request.method === 'solana_signTransaction')
        return { transaction: Array.from(signed) }
      const { Connection } = await import('@solana/web3.js')
      const chain =
        p.chain === 'solana:mainnet'
          ? 'solana-mainnet'
          : p.chain === 'solana:devnet'
          ? 'solana-devnet'
          : undefined
      if (!chain) throw new Error('Unsupported Solana chain')
      const { getChainRegistryEntry, DEFAULT_SOLANA_RPC_URLS } = await import(
        '@frank/wallet/chain'
      )
      const config = getChainRegistryEntry(chain)
      const endpoint =
        config?.rpcUrls?.[0] ?? config?.rpcUrl ?? DEFAULT_SOLANA_RPC_URLS[chain]
      if (!endpoint) throw new Error(`No RPC endpoint configured for ${chain}`)
      const genesisProbe = config?.identityProbes?.find(
        probe =>
          probe.kind === 'genesis-hash' && probe.capability === 'json-rpc',
      ) as
        | { readonly kind: 'genesis-hash'; readonly expected: string }
        | undefined
      if (!genesisProbe)
        throw new Error(`No canonical genesis identity configured for ${chain}`)
      const conn = new Connection(endpoint, 'confirmed')
      const actualGenesis = await conn.getGenesisHash()
      if (actualGenesis !== genesisProbe.expected)
        throw new Error(`Solana RPC identity mismatch for ${chain}`)
      const signature = await conn.sendRawTransaction(signed, {
        skipPreflight: false,
      })
      if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature))
        throw new Error('Solana RPC returned an invalid transaction signature')
      return signature
    }
    throw new Error(`Unsupported Solana method: ${request.method}`)
  }

  throw new Error(`Unsupported dApp method: ${request.method}`)
}
