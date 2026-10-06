/**
 * Account and messaging session.
 *
 * Custody owns the one typed runtime wallet. As soon as an account is ready, this module publishes
 * the account's own signed directory entry to the configured relay (or adopts the entry the relay
 * already holds, when the account was restored on this device) and turns direct messaging on. No
 * user action, no operator file, no peer list: any address with a published entry can be messaged
 * and any sender whose entry verifies is shown.
 *
 * If publishing fails, messaging stays off with a plain reason and is retried with backoff. It
 * never falls back to display-profile keys or the legacy envelope, and it stops as soon as the
 * account changes.
 */
import { watch } from 'vue'
import type { NativeWalletHandle, WalletHandle } from '@frank/wallet/chain'
import {
  installCanonicalDirectory,
  loadMonadChainConfigFromEnv,
  prepareMonadNextRevisionExport,
  prepareMonadRevisionZeroExport,
} from '@frank/wallet/chain/monad-chain'
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import type { DirectoryFetch } from '@frank/cashweb/relay/directory-client'
import {
  OpenDirectoryError,
  openDirectory,
  parseCheckpoint,
  serializeCheckpoint,
  type OpenDirectory,
  type OpenDirectoryDeps,
} from '@frank/cashweb/relay/open-directory'
import { toHex } from '@frank/codec'
import { accountSession, accountStatus } from '../accounts/session'
import { setDirectoryLookup } from './directory-peer'
import {
  messagingState,
  messagingStateOwner,
  type MessagingReason,
  type MessagingState,
} from './messaging-state'
import { discardUnenrolledDirectoryStore } from './directory-store-reset'
import {
  startDirectMessagePolling,
  startOutgoingReconciliation,
} from '../adapters/pinia-chain-adapter'
import { useProfileStore } from '../stores/my-profile'
import {
  fetchMonadProfile,
  registerMonadIdentityCbor,
  type MonadIdentity,
} from '@frank/wallet/monad-identity'

type Stoppable = { stop: () => void }
interface Live {
  wallet: NativeWalletHandle
  directory: OpenDirectory
  revision: number
  accountId: string | undefined
  uninstall: () => void
  polling: Stoppable
  reconcile: Stoppable
}
export interface MessagingDeps {
  session: {
    state: { status: string; revision: number; account: unknown }
    getWallet(): Promise<NativeWalletHandle>
  }
  /** The relay this app build publishes to, submits to and reads its mailbox from. */
  relayBaseUrl: string
  networkTag: 'MONT' | 'MON1'
  chainId: bigint
  directory: Pick<
    OpenDirectoryDeps,
    | 'nowNs'
    | 'fetch'
    | 'openStore'
    | 'discardUnenrolled'
    | 'checkpoints'
    | 'pins'
  >
  install: typeof installCanonicalDirectory
  startPolling: (options: { wallet: WalletHandle }) => Stoppable
  startReconcile: (options: { wallet: WalletHandle }) => Stoppable
  /** Delay before the n-th retry (1-based) of a failed publish. */
  retryDelayMs(attempt: number): number
  /** Registers the identity profile with the relay so authenticated inbox reads succeed. */
  registerProfile?: (options: {
    relayBaseUrl: string
    wallet: NativeWalletHandle
  }) => Promise<void>
}

const CHECKPOINT_PREFIX = 'frank-directory-checkpoint:'
const PIN_PREFIX = 'frank-directory-pin:'
const accountIdOf = (account: unknown): string | undefined =>
  (account as { receipt?: { context?: { accountId?: string } } } | null)
    ?.receipt?.context?.accountId
const networkOf = (tag: 'MONT' | 'MON1') =>
  tag === 'MONT' ? 'monad-testnet' : 'monad-mainnet'

function productionDeps(): MessagingDeps {
  const config = loadMonadChainConfigFromEnv()
  if (config.networkTag !== 'MONT' && config.networkTag !== 'MON1')
    throw new Error('Direct messages need a Monad network')
  return {
    session: accountSession,
    relayBaseUrl: config.relayBaseUrl,
    networkTag: config.networkTag,
    chainId: BigInt(config.chainId),
    directory: {
      nowNs: () => BigInt(Date.now()) * 1_000_000n,
      fetch: ((url, init) =>
        fetch(url, {
          ...init,
          headers: {
            'ngrok-skip-browser-warning': '1',
            ...((init as RequestInit | undefined)?.headers ?? {}),
          },
        } as RequestInit)) as DirectoryFetch,
      openStore: options => openBrowserDirectoryStore(options),
      discardUnenrolled: discardUnenrolledDirectoryStore,
      checkpoints: {
        load(key) {
          const saved = window.localStorage.getItem(CHECKPOINT_PREFIX + key)
          return saved === null ? null : parseCheckpoint(saved)
        },
        save(key, checkpoint) {
          window.localStorage.setItem(
            CHECKPOINT_PREFIX + key,
            serializeCheckpoint(checkpoint),
          )
        },
      },
      pins: {
        load: key => window.localStorage.getItem(PIN_PREFIX + key),
        save: (key, value) =>
          window.localStorage.setItem(PIN_PREFIX + key, value),
      },
    },
    install: installCanonicalDirectory,
    startPolling: startDirectMessagePolling,
    startReconcile: startOutgoingReconciliation,
    // 5 s, 10 s, 20 s ... capped at 5 minutes.
    retryDelayMs: attempt => Math.min(5_000 * 2 ** (attempt - 1), 300_000),
    registerProfile: async ({ relayBaseUrl, wallet }) => {
      const identity = (wallet as unknown as { identity?: MonadIdentity })
        .identity
      if (!identity) return
      try {
        let profile = undefined
        try {
          profile = useProfileStore().profile
        } catch {
          // Pinia store not available (e.g. non-Vue test environment)
        }
        try {
          const existing = await fetchMonadProfile({
            relayBaseUrl,
            address: identity.address,
          })
          if (
            existing &&
            (existing.name ?? '') === (profile?.name ?? '') &&
            (existing.username ?? '') === (profile?.username ?? '') &&
            (existing.location ?? '') === (profile?.location ?? '') &&
            (existing.bio ?? '') === (profile?.bio ?? '') &&
            (existing.avatar ?? '') === (profile?.avatar ?? '') &&
            JSON.stringify(existing.links ?? []) ===
              JSON.stringify(profile?.links ?? [])
          ) {
            return
          }
        } catch {
          // If check fails, fall through to attempt registration
        }
        await registerMonadIdentityCbor({
          relayBaseUrl,
          identity,
          profile,
        })
      } catch (err) {
        console.warn('[startMessaging] registerMonadIdentityCbor failed:', err)
      }
    },
  }
}

const state = messagingStateOwner
export { messagingState }
export type { MessagingReason, MessagingState }

let deps: MessagingDeps | undefined
let live: Live | undefined
/** Identity of the attempt in flight; anything older must publish no result. */
let attempt: object | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let failures = 0
let watching = false
const dependencies = () => (deps ??= productionDeps())

/** Test seam: replace every external effect. Also stops anything live. */
export async function configureMessagingForTest(
  replacement: MessagingDeps | undefined,
): Promise<void> {
  await stopMessaging()
  deps = replacement
  state.status = 'pending'
  state.reason = null
}

/** The live wallet for direct messages, only while this account's entry is published. */
export function messagingWallet(): WalletHandle | undefined {
  return live ? (live.wallet as unknown as WalletHandle) : undefined
}

export async function stopMessaging(): Promise<void> {
  attempt = undefined
  if (retryTimer !== undefined) clearTimeout(retryTimer)
  retryTimer = undefined
  failures = 0
  const previous = live
  live = undefined
  setDirectoryLookup(accountStatus.status === 'ready' ? 'pending' : null)
  if (state.status !== 'pending') state.status = 'pending'
  if (!previous) return
  previous.polling.stop()
  previous.reconcile.stop()
  previous.uninstall()
  await previous.directory.close()
}

function reasonOf(error: unknown): MessagingReason {
  if (!(error instanceof OpenDirectoryError)) return 'account-unavailable'
  switch (error.code) {
    case 'unreachable':
      return 'relay-unreachable'
    case 'rejected':
      return 'relay-rejected'
    case 'relay-info':
      return 'relay-misconfigured'
    case 'storage':
      return 'storage'
    case 'clock':
      return 'device-clock'
    default:
      return 'entry-refused'
  }
}

/**
 * Publish (or adopt) this account's entry and turn messaging on. Runs by itself whenever an
 * account becomes ready, and again with backoff after a failure.
 */
export async function startMessaging(): Promise<void> {
  let d: MessagingDeps
  try {
    d = dependencies()
  } catch {
    // This build has no Monad network: there is no directory to publish to.
    state.status = 'pending'
    state.reason = 'account-unavailable'
    return
  }
  const retries = failures
  await stopMessaging()
  failures = retries
  const mine = {}
  attempt = mine
  state.status = 'publishing'
  setDirectoryLookup('pending')
  const revision = d.session.state.revision,
    account = d.session.state.account
  const sameAccount = () =>
    attempt === mine &&
    d.session.state.status === 'ready' &&
    d.session.state.revision === revision &&
    d.session.state.account === account
  let directory: OpenDirectory | undefined
  let failure: MessagingReason | undefined
  let wallet: NativeWalletHandle | undefined
  try {
    if (d.session.state.status !== 'ready') throw new Error('no account')
    wallet = await d.session.getWallet()
    if (d.registerProfile) {
      await d.registerProfile({ relayBaseUrl: d.relayBaseUrl, wallet })
    }
    const owner = wallet
    const descriptor = {
      networkTag: d.networkTag,
      network: networkOf(d.networkTag),
      chainId: d.chainId,
    }
    directory = openDirectory({
      network: descriptor.network,
      relayBaseUrl: d.relayBaseUrl,
      ...d.directory,
      self: {
        subject: toHex(
          (
            owner as unknown as {
              identity: { compressedPubKey: Uint8Array }
            }
          ).identity.compressedPubKey,
        ),
        signRevisionZero: input =>
          prepareMonadRevisionZeroExport(owner, { ...descriptor, ...input })
            .attestation,
        signNextRevision: input =>
          prepareMonadNextRevisionExport(owner, { ...descriptor, ...input })
            .attestation,
      },
    })
    await directory.publish()
  } catch (error) {
    console.error('[startMessaging] directory.publish failed:', error)
    failure = reasonOf(error)
  }
  if (!failure && directory && wallet && sameAccount()) {
    try {
      const uninstall = d.install(wallet, directory)
      const handle = wallet as unknown as WalletHandle
      const found = directory
      live = {
        wallet,
        directory,
        revision,
        accountId: accountIdOf(account),
        uninstall,
        polling: d.startPolling({ wallet: handle }),
        reconcile: d.startReconcile({ wallet: handle }),
      }
      setDirectoryLookup(address => found.lookup(address))
      failures = 0
      state.status = 'ready'
      state.reason = null
      return
    } catch (err) {
      console.error('[startMessaging] install failed:', err)
      failure = 'account-unavailable'
    }
  }
  await directory?.close().catch(() => undefined)
  // Superseded by a newer attempt or an account change: publish nothing from this one.
  if (attempt !== mine) return
  attempt = undefined
  state.status = 'pending'
  state.reason = failure ?? 'account-unavailable'
  if (d.session.state.status !== 'ready') return
  // An account change during the attempt is not a failure: start over at once for the new one.
  if (failure) failures += 1
  retryTimer = setTimeout(
    () => {
      retryTimer = undefined
      if (!live && d.session.state.status === 'ready') void startMessaging()
    },
    failure ? d.retryDelayMs(failures) : 0,
  )
}

function watchAccount(): void {
  if (watching) return
  watching = true
  watch(
    () =>
      [
        accountStatus.status,
        accountStatus.revision,
        accountIdOf(accountStatus.account),
      ] as const,
    ([status, revision, accountId]) => {
      if (
        live &&
        (status !== 'ready' ||
          revision !== live.revision ||
          accountId !== live.accountId)
      )
        void stopMessaging().then(() => {
          if (accountStatus.status === 'ready') void startMessaging()
        })
      else if (!live && status === 'ready' && state.status !== 'publishing')
        void startMessaging()
      else if (status !== 'ready') void stopMessaging()
    },
  )
}

/** Opens custody, then publishes the account's entry and starts messaging in the background. */
export async function initializeMonadIdentity(): Promise<
  'started' | 'skipped'
> {
  await accountSession.initialize()
  watchAccount()
  if (accountStatus.status !== 'ready') return 'skipped'
  // Not awaited: a slow or absent relay must not block entering the app.
  void startMessaging()
  return 'started'
}
