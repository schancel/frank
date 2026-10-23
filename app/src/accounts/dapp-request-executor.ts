import {
  TypedDataEncoder,
  getBytes,
  hashMessage,
  keccak256,
  toUtf8Bytes,
} from 'ethers'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain/chains-registry'
import { canonicalDappPersonaOrigin } from '@frank/wallet/dapp-bridge/persona-keys'
import type { EvmChainWalletHandle } from '@frank/wallet/chain'
import type { accountSession } from './session'
import { openEvmWallet } from './evm-wallets'

export interface ApprovedDappRequest {
  readonly id: string
  readonly origin: string
  readonly method: string
  readonly params: unknown
  readonly chainIdHex?: string
  readonly chainIdentifier?: string
  readonly personaAddress?: string
  readonly solanaAccountAddress?: string
  readonly personaRef?:
    | { kind: 'shared'; slot: number }
    | { kind: 'site'; origin: string }
}

export interface DappRequestExecutorOptions {
  readonly openEvmWallet?: typeof openEvmWallet
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

/** Executes only a request already approved by the extension approval page. */
export async function executeApprovedDappRequest(
  request: ApprovedDappRequest,
  session: Pick<
    typeof accountSession,
    'createDappPersonaSigner' | 'createDappSolanaSigner'
  >,
  options: DappRequestExecutorOptions = {},
): Promise<unknown> {
  if (
    !request ||
    typeof request.id !== 'string' ||
    !request.id ||
    typeof request.origin !== 'string' ||
    !request.origin
  )
    throw new Error('Invalid approved dApp request')

  if (request.method === 'personal_sign' || request.method === 'eth_sign') {
    const [first, second] = paramsArray(request.params)
    const address = request.method === 'eth_sign' ? first : second
    const raw = request.method === 'eth_sign' ? second : first
    const signer = await session.createDappPersonaSigner()
    const ref = request.personaRef ?? {
      kind: 'site' as const,
      origin: canonicalDappPersonaOrigin(request.origin),
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
    const tx = rawTx as Record<string, unknown>
    const chainIdHex = (request.chainIdHex ?? '').toLowerCase()
    const chainId = BigInt(chainIdHex || '0x0')
    const chainEntry = Object.values(PROTOCOL_CHAINS).find(
      entry =>
        entry.family === 'evm' &&
        entry.nativeChainId !== undefined &&
        BigInt(entry.nativeChainId) === chainId,
    )
    if (!chainEntry)
      throw new Error(`Unsupported EVM chain: ${chainIdHex || 'unknown'}`)
    if (
      request.chainIdentifier !== undefined &&
      request.chainIdentifier !== chainEntry.id
    )
      throw new Error('Approved transaction chain changed')
    if (
      tx.chainId !== undefined &&
      quantity(tx.chainId, 'transaction chain ID') !== chainId
    )
      throw new Error('Transaction chain does not match the selected chain')
    const signer = await session.createDappPersonaSigner()
    const ref = request.personaRef ?? {
      kind: 'site' as const,
      origin: request.origin,
    }
    const [expected] = await signer.addresses([ref])
    requireApprovedPersonaAddress(request, expected)
    if (
      typeof tx.from !== 'string' ||
      tx.from.toLowerCase() !== expected.toLowerCase()
    )
      throw new Error('Transaction sender does not match this site persona')
    if (typeof tx.to !== 'string')
      throw new Error(
        'Contract creation from a Frank subaccount is unsupported',
      )
    if (
      tx.accessList !== undefined &&
      (!Array.isArray(tx.accessList) || tx.accessList.length !== 0)
    )
      throw new Error('Access-list transactions are unsupported')
    const requestedType =
      tx.type === undefined
        ? undefined
        : Number(quantity(tx.type, 'transaction type'))
    if (
      requestedType !== undefined &&
      requestedType !== 0 &&
      requestedType !== 2
    )
      throw new Error(`Unsupported EVM transaction type: ${requestedType}`)
    const requestedNonce =
      tx.nonce === undefined
        ? undefined
        : Number(quantity(tx.nonce, 'transaction nonce'))
    if (requestedNonce !== undefined && !Number.isSafeInteger(requestedNonce))
      throw new Error('Invalid transaction nonce')
    const wallet = (
      await (options.openEvmWallet ?? openEvmWallet)(chainEntry.id)
    ).wallet as EvmChainWalletHandle
    if (
      wallet.chainIdentifier !== chainEntry.id ||
      !wallet.sendLegacyFromSubAccount
    )
      throw new Error('This wallet cannot send from a legacy subaccount')
    const operationId = `dapp-${keccak256(
      toUtf8Bytes(
        JSON.stringify({
          chainIdentifier: chainEntry.id,
          account: expected.toLowerCase(),
          origin: canonicalDappPersonaOrigin(request.origin),
          requestId: request.id,
        }),
      ),
    ).slice(2)}`
    const result = await wallet.sendLegacyFromSubAccount({
      operationId,
      source: ref,
      expectedSourceAddress: expected,
      recipient: { raw: stringValue(tx.to, 'transaction recipient') },
      value: quantity(tx.value ?? '0x0', 'transaction value'),
      ...(tx.data === undefined
        ? {}
        : { data: stringValue(tx.data, 'transaction data') }),
      ...(requestedNonce === undefined ? {} : { nonce: requestedNonce }),
      ...(tx.gas === undefined && tx.gasLimit === undefined
        ? {}
        : {
            gasLimit: quantity(tx.gas ?? tx.gasLimit, 'transaction gas limit'),
          }),
      ...(requestedType === undefined ? {} : { type: requestedType as 0 | 2 }),
      ...(tx.gasPrice === undefined
        ? {}
        : {
            gasPriceWei: quantity(tx.gasPrice, 'transaction gas price'),
          }),
      ...(tx.maxFeePerGas === undefined
        ? {}
        : {
            maxFeePerGasWei: quantity(tx.maxFeePerGas, 'maximum fee per gas'),
          }),
      ...(tx.maxPriorityFeePerGas === undefined
        ? {}
        : {
            maxPriorityFeePerGasWei: quantity(
              tx.maxPriorityFeePerGas,
              'maximum priority fee per gas',
            ),
          }),
    })
    return result.txHash
  }

  if (request.method.startsWith('solana_')) {
    const signer = await session.createDappSolanaSigner()
    const p =
      request.params && typeof request.params === 'object'
        ? (request.params as any)
        : {}
    const approvedAccount = request.solanaAccountAddress
    if (approvedAccount && approvedAccount !== signer.publicKey)
      throw new Error(
        'The approved Solana account changed before signing; reject and reconnect.',
      )
    if (request.method === 'solana_connect') {
      const { PublicKey } = await import('@solana/web3.js')
      const publicKey = new PublicKey(signer.publicKey).toBytes()
      return { address: signer.publicKey, publicKey: Array.from(publicKey) }
    }
    if (!approvedAccount)
      throw new Error('No Solana account was captured for this approval')
    if (p.account && p.account !== approvedAccount)
      throw new Error(
        'Requested Solana account does not match the approved account',
      )
    if (request.method === 'solana_signMessage') {
      const signature = await signer.signMessage(
        asBytes(p.message, 'Solana message'),
      )
      return { signature: Array.from(signature) }
    }
    if (
      request.method === 'solana_signTransaction' ||
      request.method === 'solana_signAndSendTransaction'
    ) {
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
      const { getChainRegistryEntry } = await import(
        '@frank/wallet/chain/chains-registry'
      )
      const { DEFAULT_SOLANA_RPC_URLS } = await import(
        '@frank/wallet/chain/solana-balance'
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
