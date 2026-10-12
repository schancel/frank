/** Private app composition for the existing Solana payment authority. No key or
 * provider escapes this module; opening is an explicit financial operation. */
import { watch, type WatchStopHandle } from 'vue'
import { PublicKey } from '@solana/web3.js'
import {
  getChainRegistryEntry,
  loadMonadChainConfigFromEnv,
} from '@frank/wallet/chain'
import type { ExperimentalCustody } from '@frank/wallet/solana-crypto-backend/runtime.mjs'
import wasmUrl from '../../../packages/wallet/solana-crypto-backend/generated/backend_bg.wasm?url'
import {
  experimentalSolanaPaymentConstruction,
  experimentalSolanaPaymentCustody,
} from '@frank/wallet/solana-contact-payments/custody-adapter'
import { ExperimentalSolanaContactPayments } from '@frank/wallet/solana-contact-payments/engine'
import {
  CanonicalSolanaPaymentRpc,
  createSolanaHttpTransport,
  type SolanaClassicAssetDiscovery,
  type SolanaOwnedBalances,
} from '@frank/wallet/solana-contact-payments/rpc-adapter'
import { SolanaPaymentState } from '@frank/wallet/solana-contact-payments/state'
import { associatedAccount } from '@frank/wallet/solana-contact-payments/transaction-policy'
import type {
  SolanaPaymentAsset,
  SolanaPaymentPersistence,
  SolanaPaymentSnapshot,
  SolanaSigningReference,
} from '@frank/wallet/solana-contact-payments/types'
import type {
  SolanaStealthPaymentCapability,
  SolanaStealthPaymentReceiptCapability,
} from '@frank/wallet/stealth-payment'
import { IndexedDbSolanaPaymentPersistence } from '@frank/wallet/storage/solana-payment-state'
import { accountSession } from './session'
import { createSolanaPaymentCapability } from './solana-payment-capabilities'

type Session = Pick<
  typeof accountSession,
  'state' | 'peekWallet' | 'getCurvePublicKey' | 'createSolanaPaymentCustody'
>
export interface OpenSolanaPayments {
  readonly family: 'solana'
  readonly chainIdentifier: string
  readonly primaryAddress: string
  readonly receipts: SolanaStealthPaymentReceiptCapability
  readonly payments: SolanaStealthPaymentCapability
  resolveClassicAsset(input: { mint: string; program: string }): Promise<{
    asset: Extract<SolanaPaymentAsset, { kind: 'spl' }>
    finalizedSlot: number
  }>
  inspect(): Promise<SolanaPaymentSnapshot>
  discoverAssets(): Promise<
    readonly ({ owner: string } & SolanaClassicAssetDiscovery)[]
  >
  refresh(
    asset: SolanaPaymentAsset,
  ): Promise<readonly ({ owner: string } & SolanaOwnedBalances)[]>
  close(): Promise<void>
}
interface Opened {
  readonly chainIdentifier: string
  readonly accountId: string
  readonly revision: number
  readonly primary: NonNullable<ReturnType<Session['peekWallet']>>
  readonly relay: string
  readonly cancellation: AbortController
  readonly operations: Set<Promise<unknown>>
  opening: Promise<OpenSolanaPayments>
  value?: OpenSolanaPayments
  custody?: ExperimentalCustody
  closing?: Promise<void>
}
function relay(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  const url = new URL(normalized)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid configured relay')
  return normalized
}

/** Dependencies are host construction seams, not another state or custody owner. */
export function createSolanaPaymentContexts(deps: {
  readonly session: Session
  readonly relayBaseUrl: () => string
  readonly wasmUrl: URL | string
  readonly fetcher: typeof fetch
  readonly persistence?: (namespace: string) => SolanaPaymentPersistence
}) {
  const opened = new Map<string, Opened>()
  const retirements = new Map<string, Set<Promise<void>>>()
  let stopWatching: WatchStopHandle | undefined
  function current(entry: Opened): boolean {
    const { status, account, revision } = deps.session.state
    return (
      !entry.cancellation.signal.aborted &&
      status === 'ready' &&
      account?.receipt.context.accountId === entry.accountId &&
      revision === entry.revision &&
      deps.session.peekWallet() === entry.primary &&
      relay(deps.relayBaseUrl()) === entry.relay &&
      opened.get(entry.chainIdentifier) === entry
    )
  }
  function requireCurrent(entry: Opened): void {
    if (!current(entry))
      throw new Error('Solana payment account context changed')
  }
  function closeEntry(entry: Opened): Promise<void> {
    if (entry.closing) return entry.closing
    // Revoke captured handles before any asynchronous teardown or publication.
    entry.cancellation.abort()
    if (opened.get(entry.chainIdentifier) === entry)
      opened.delete(entry.chainIdentifier)
    let closeFailure: unknown
    try {
      entry.custody?.close()
    } catch (error) {
      closeFailure = error
    }
    const closing = Promise.resolve().then(async () => {
      await entry.opening.catch(() => undefined)
      await Promise.allSettled([...entry.operations])
      if (closeFailure !== undefined) throw closeFailure
    })
    entry.closing = closing
    let pending = retirements.get(entry.chainIdentifier)
    if (!pending) retirements.set(entry.chainIdentifier, (pending = new Set()))
    pending.add(closing)
    void closing.then(
      () => {
        pending.delete(closing)
        if (!pending.size && retirements.get(entry.chainIdentifier) === pending)
          retirements.delete(entry.chainIdentifier)
      },
      () => undefined,
    )
    return closing
  }
  function retireInvalid(): void {
    for (const entry of opened.values()) {
      let valid = false
      try {
        valid = current(entry)
      } catch {
        /* Invalid host configuration also revokes. */
      }
      if (!valid) void closeEntry(entry).catch(() => undefined)
    }
  }
  function watchSession(): void {
    stopWatching ??= watch(
      () => [
        deps.session.state.status,
        deps.session.state.revision,
        deps.session.state.account?.receipt.context.accountId,
        deps.session.peekWallet(),
      ],
      retireInvalid,
      { flush: 'sync' },
    )
  }
  function run<T>(entry: Opened, action: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(async () => {
      requireCurrent(entry)
      const value = await action()
      requireCurrent(entry)
      return value
    })
    entry.operations.add(result)
    void result.then(
      () => entry.operations.delete(result),
      () => entry.operations.delete(result),
    )
    return result
  }
  function open(chainIdentifier: string): Promise<OpenSolanaPayments> {
    const config = getChainRegistryEntry(chainIdentifier)
    if (
      !config ||
      config.family !== 'solana' ||
      !config.wallet ||
      !config.allowedProxyCapabilities.includes('json-rpc') ||
      !config.identityProbes.some(probe => probe.kind === 'genesis-hash')
    )
      throw new Error(`Solana payments unavailable for ${chainIdentifier}`)
    const { status, account, revision } = deps.session.state
    const primary = deps.session.peekWallet()
    if (status !== 'ready' || !account || !primary)
      throw new Error('No account is open')
    const capturedRelay = relay(deps.relayBaseUrl())
    retireInvalid()
    const existing = opened.get(chainIdentifier)
    if (existing)
      return existing.opening.then(value => {
        requireCurrent(existing)
        return value
      })
    watchSession()
    const barrier = Promise.all([...(retirements.get(chainIdentifier) ?? [])])
    const entry: Opened = {
      chainIdentifier,
      accountId: account.receipt.context.accountId,
      revision,
      primary,
      relay: capturedRelay,
      cancellation: new AbortController(),
      operations: new Set(),
      opening: Promise.resolve().then(async () => {
        let handle: ExperimentalCustody | undefined
        try {
          await barrier
          requireCurrent(entry)
          const transport = createSolanaHttpTransport(
            `${capturedRelay}/chain-rpc/${encodeURIComponent(
              chainIdentifier,
            )}/rpc`,
            (url, init) =>
              deps.fetcher(url, { ...init, signal: entry.cancellation.signal }),
          )
          const rpc = new CanonicalSolanaPaymentRpc(chainIdentifier, {
            integerEncoding: transport.integerEncoding,
            async request(method, params) {
              requireCurrent(entry)
              const result = await transport.request(method, params)
              requireCurrent(entry)
              return result
            },
          })
          await rpc.getGenesisHash()
          requireCurrent(entry)
          const published = await deps.session.getCurvePublicKey('ed25519')
          requireCurrent(entry)
          const primaryAddress = new PublicKey(published).toBase58()
          handle = await deps.session.createSolanaPaymentCustody({
            chainIdentifier,
            wasm: deps.wasmUrl,
            signal: entry.cancellation.signal,
          })
          requireCurrent(entry)
          if (
            new PublicKey(handle.primaryPublicKey()).toBase58() !==
            primaryAddress
          )
            throw new Error('Solana published identity mismatch')
          entry.custody = handle
          // Public namespace metadata, distinct from the WASM's public account label.
          const namespace = JSON.stringify([
            'frank-solana-payments',
            entry.accountId,
            Buffer.from(published).toString('hex'),
            chainIdentifier,
          ])
          const persistence =
            deps.persistence?.(namespace) ??
            new IndexedDbSolanaPaymentPersistence(namespace)
          const guarded: SolanaPaymentPersistence = {
            async read() {
              requireCurrent(entry)
              const value = await persistence.read()
              requireCurrent(entry)
              return value
            },
            async update(mutate) {
              requireCurrent(entry)
              const result = await persistence.update(previous => {
                requireCurrent(entry)
                return mutate(previous)
              })
              requireCurrent(entry)
              return result
            },
          }
          const state = new SolanaPaymentState(
            namespace,
            chainIdentifier,
            guarded,
          )
          const custody = experimentalSolanaPaymentCustody(handle)
          const engine = new ExperimentalSolanaContactPayments(
            state,
            custody,
            rpc,
            experimentalSolanaPaymentConstruction(deps.wasmUrl),
          )
          await state.inspect() // Validate any required restoration without writing defaults.
          requireCurrent(entry)
          const owners = async () => {
            const snapshot = await state.inspect()
            const values = new Map<string, SolanaSigningReference>([
              [primaryAddress, { kind: 'primary' }],
            ])
            for (const position of Object.values(snapshot.positions)) {
              const reference = position.signingReference
              if (reference.kind === 'primary') {
                if (position.owner !== primaryAddress)
                  throw new Error('Foreign primary Solana position')
              } else {
                await custody.validateReceived(reference)
                requireCurrent(entry)
              }
              if (!values.has(position.owner))
                values.set(position.owner, reference)
            }
            return { snapshot, values }
          }
          const receipts = Object.freeze<SolanaStealthPaymentReceiptCapability>(
            {
              family: 'solana',
              recordIncomingClaim: (claim, proof) => {
                const captured = structuredClone(claim)
                const binding = { ...proof }
                return run(entry, () =>
                  engine.recordIncomingClaim(captured, binding),
                )
              },
              rebroadcastIncoming: signature =>
                run(entry, () => engine.rebroadcastIncoming(signature)),
              reconcileIncoming: signature =>
                run(entry, () => engine.reconcileIncoming(signature)),
              incomingProgress: signatures => {
                const captured = [...signatures]
                return run(entry, () => engine.incomingProgress(captured))
              },
            },
          )
          const refreshAsset = async (
            asset: SolanaPaymentAsset,
            skipReservedOwners = false,
          ) => {
            const { snapshot, values } = await owners()
            const results: ({ owner: string } & SolanaOwnedBalances)[] = []
            for (const [owner, signingReference] of values) {
              if (
                skipReservedOwners &&
                Object.values(snapshot.positions).some(
                  position => position.owner === owner && position.reservedBy,
                )
              )
                continue
              const result = await rpc.readOwnedBalances({
                owner,
                selectedAsset: asset,
              })
              requireCurrent(entry)
              await state.observe({
                address: owner,
                owner,
                asset: { kind: 'native' },
                balance: result.nativeBalance,
                observedSlot: result.finalizedSlot,
                signingReference,
              })
              if (asset.kind === 'spl') {
                const tokenAddress = associatedAccount(owner, asset.mint)
                if (result.assetBalance || snapshot.positions[tokenAddress])
                  await state.observe({
                    address: tokenAddress,
                    owner,
                    asset,
                    balance: result.assetBalance?.balance ?? '0',
                    observedSlot: result.finalizedSlot,
                    signingReference:
                      snapshot.positions[tokenAddress]?.signingReference ??
                      signingReference,
                  })
              }
              results.push({ owner, ...result })
            }
            return results
          }
          const payments = createSolanaPaymentCapability({
            state,
            engine,
            run: action => run(entry, action),
            refresh: asset => refreshAsset(asset, true),
          })
          const value = Object.freeze<OpenSolanaPayments>({
            family: 'solana',
            chainIdentifier,
            primaryAddress,
            receipts,
            payments,
            resolveClassicAsset(input) {
              const captured = { ...input }
              return run(entry, async () => {
                const metadata = await rpc.readClassicMint(captured)
                return {
                  asset: {
                    kind: 'spl',
                    mint: metadata.mint,
                    program: metadata.program,
                    decimals: metadata.decimals,
                  },
                  finalizedSlot: metadata.finalizedSlot,
                }
              })
            },
            inspect: () => run(entry, () => state.inspect()),
            discoverAssets: () =>
              run(entry, async () => {
                const { values } = await owners()
                const results: ({
                  owner: string
                } & SolanaClassicAssetDiscovery)[] = []
                for (const owner of values.keys())
                  results.push({
                    owner,
                    ...(await rpc.discoverClassicAssets(owner)),
                  })
                return results
              }),
            refresh: assetInput => {
              const asset = structuredClone(assetInput)
              return run(entry, () => refreshAsset(asset))
            },
            close: () => closeEntry(entry),
          })
          entry.value = value
          requireCurrent(entry)
          return value
        } catch (error) {
          entry.cancellation.abort()
          handle?.close()
          throw error
        }
      }),
    }
    opened.set(chainIdentifier, entry)
    void entry.opening.catch(() => {
      if (opened.get(chainIdentifier) === entry) opened.delete(chainIdentifier)
    })
    return entry.opening
  }
  return {
    open,
    /** Existing references only. This neither opens custody nor accesses IndexedDB/RPC. */
    peek(): readonly OpenSolanaPayments[] {
      return [...opened.values()].flatMap(entry => {
        try {
          return entry.value && current(entry) ? [entry.value] : []
        } catch {
          return []
        }
      })
    },
    async close(): Promise<void> {
      stopWatching?.()
      stopWatching = undefined
      await Promise.all(
        [...opened.values()]
          .map(closeEntry)
          .concat([...retirements.values()].flatMap(values => [...values])),
      )
    },
  }
}
const contexts = createSolanaPaymentContexts({
  session: accountSession,
  relayBaseUrl: () => loadMonadChainConfigFromEnv().relayBaseUrl,
  wasmUrl,
  fetcher: (...args) => fetch(...args),
})
export const openSolanaPayments = contexts.open
export const peekOpenedSolanaPayments = contexts.peek
export const closeOpenedSolanaPayments = contexts.close
