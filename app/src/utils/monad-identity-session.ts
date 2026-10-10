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
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import { messageItems } from './message-items'
import { conversationIdSaltOf } from '@frank/wallet/chain/monad-chain'
import { setConversationIdSalt } from '../stores/chats'
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
import {
  cancelDirectoryLookupWaiters,
  setDirectoryLookup,
} from './directory-peer'
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
import { isAvatarTooLarge, compressAvatarDataUrl } from './avatar-resize'
import { clearOwnUsername, ownUsername, syncOwnUsername } from './own-username'
import { errorNotify } from './notifications'

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
  networkTag: 'MONT' | 'MON1' | 'MONR'
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
  /**
   * Picks up what the account's wallets signed earlier and did not finish (a swap interrupted
   * by a reload) once the account is open and can send its notes to itself. Costs no network
   * request when nothing is unfinished.
   */
  resumeLegacy?: () => void
  /** Delay before the n-th retry (1-based) of a failed publish. */
  retryDelayMs(attempt: number): number
  /** Registers the identity profile with the relay so authenticated inbox reads succeed. */
  registerProfile?: (options: {
    relayBaseUrl: string
    wallet: NativeWalletHandle
  }) => Promise<void>
  /** Claims the saved username again once this account's entry is published. */
  claimUsername?: (options: {
    relayBaseUrl: string
    network: string
    wallet: NativeWalletHandle
  }) => Promise<void>
}

const CHECKPOINT_PREFIX = 'frank-directory-checkpoint:'
const PIN_PREFIX = 'frank-directory-pin:'
const accountIdOf = (account: unknown): string | undefined =>
  (account as { receipt?: { context?: { accountId?: string } } } | null)
    ?.receipt?.context?.accountId
const networkOf = (tag: 'MONT' | 'MON1' | 'MONR') =>
  tag === 'MONT'
    ? 'monad-testnet'
    : tag === 'MONR'
    ? 'monad-regtest'
    : 'monad-mainnet'

function productionDeps(): MessagingDeps {
  const config = loadMonadChainConfigFromEnv()
  if (
    config.networkTag !== 'MONT' &&
    config.networkTag !== 'MON1' &&
    config.networkTag !== 'MONR'
  )
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
      discardStore: async name => {
        await discardUnenrolledDirectoryStore(name)
      },
      checkpoints: {
        load(key) {
          try {
            const saved = window.localStorage.getItem(CHECKPOINT_PREFIX + key)
            return saved === null ? null : parseCheckpoint(saved)
          } catch {
            return null
          }
        },
        save(key, checkpoint) {
          try {
            if (!checkpoint) {
              window.localStorage.removeItem(CHECKPOINT_PREFIX + key)
              return
            }
            window.localStorage.setItem(
              CHECKPOINT_PREFIX + key,
              serializeCheckpoint(checkpoint),
            )
          } catch (e) {
            console.warn(
              '[monad-identity-session] Failed to save checkpoint:',
              e,
            )
          }
        },
      },
      pins: {
        load: key => {
          try {
            return window.localStorage.getItem(PIN_PREFIX + key)
          } catch {
            return null
          }
        },
        save: (key, value) => {
          try {
            if (!value) {
              window.localStorage.removeItem(PIN_PREFIX + key)
              return
            }
            window.localStorage.setItem(PIN_PREFIX + key, value)
          } catch (e) {
            console.warn('[monad-identity-session] Failed to save pin:', e)
          }
        },
      },
    },
    // The wallet's directory and the message-item plugins it sends and receives with.
    install: (wallet, directory) => {
      const removeMessageItems = installMessageItemRegistry(
        wallet,
        messageItems,
      )
      try {
        const removeDirectory = installCanonicalDirectory(wallet, directory)
        return () => {
          removeDirectory()
          removeMessageItems()
        }
      } catch (error) {
        removeMessageItems()
        throw error
      }
    },
    startPolling: startDirectMessagePolling,
    startReconcile: startOutgoingReconciliation,
    resumeLegacy: () =>
      void import('../composables/useSolanaSwap')
        .then(swaps => swaps.resumeSolanaSwaps())
        .catch(error =>
          console.warn(
            '[startMessaging] could not resume Solana swaps:',
            error,
          ),
        ),
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
            (existing.accountType ?? 0) === (profile?.accountType ?? 0) &&
            existing.botRole === profile?.botRole &&
            JSON.stringify(existing.links ?? []) ===
              JSON.stringify(profile?.links ?? [])
          ) {
            return
          }
        } catch {
          // If check fails, fall through to attempt registration
        }
        let identityProfile = profile
        if (
          identityProfile?.avatar &&
          isAvatarTooLarge(identityProfile.avatar)
        ) {
          try {
            const compressed = await compressAvatarDataUrl(
              identityProfile.avatar,
            )
            if (compressed && !isAvatarTooLarge(compressed)) {
              identityProfile = { ...identityProfile, avatar: compressed }
            } else {
              identityProfile = { ...identityProfile, avatar: undefined }
            }
          } catch {
            identityProfile = { ...identityProfile, avatar: undefined }
          }
        }
        await registerMonadIdentityCbor({
          relayBaseUrl,
          identity,
          profile: identityProfile,
          network: loadMonadChainConfigFromEnv().rpcChain,
        })
      } catch (err) {
        console.warn('[startMessaging] registerMonadIdentityCbor failed:', err)
      }
    },
    // Bring the account's own username in line with the relay: a saved name is claimed again
    // (a no-op when held; what restores it on a relay with a fresh database), and the user is
    // told when the relay will not give it, instead of the app going on showing it.
    claimUsername: async ({ relayBaseUrl, network, wallet }) => {
      const identity = (wallet as unknown as { identity?: MonadIdentity })
        .identity
      if (!identity) return
      let saved: string | undefined
      try {
        saved = useProfileStore().profile.username
      } catch {
        // Pinia store not available (e.g. non-Vue test environment)
      }
      await syncOwnUsername({
        relayBaseUrl,
        network,
        signer: identity,
        address: identity.address.raw,
        saved,
      })
      if (ownUsername.problem) {
        console.warn(
          `[startMessaging] saved username @${saved} is not held: ${ownUsername.problem}`,
        )
        errorNotify(new Error('saved username is not held'), {
          fallbackKey: 'profile.usernameNotHeld',
        })
      }
    },
  }
}

const state = messagingStateOwner
export { messagingState }
export type { MessagingReason, MessagingState }

let deps: MessagingDeps | undefined
/** The account whose conversation-ID salt is installed in the chat store. */
let saltAccount: unknown
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

/**
 * Installs the active account's conversation-ID salt in the chat store, if it is not there yet.
 * Anything that opens a chat outside the messaging start (a route followed at launch) awaits
 * this first. Resolves without one when no account is ready.
 */
export async function ensureConversationIdSalt(): Promise<void> {
  let d: MessagingDeps
  try {
    d = dependencies()
  } catch {
    return // This build has no Monad network, so no account that could open a chat.
  }
  if (d.session.state.status !== 'ready') return
  const salt = conversationIdSaltOf(await d.session.getWallet())
  if (salt) setConversationIdSalt(salt)
}

export async function stopMessaging(): Promise<void> {
  // The salt goes with the account, not with the connection to the relay.
  if (accountStatus.status !== 'ready') setConversationIdSalt(null)
  attempt = undefined
  if (retryTimer !== undefined) clearTimeout(retryTimer)
  retryTimer = undefined
  failures = 0
  const previous = live
  live = undefined
  // Never show one account's username while another is being started.
  clearOwnUsername()
  setDirectoryLookup(accountStatus.status === 'ready' ? 'pending' : null)
  cancelDirectoryLookupWaiters()
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
    // One account's salt never serves another: on a switch straight from one ready account to
    // the next, the old salt goes before the new wallet opens.
    if (saltAccount !== account) setConversationIdSalt(null)
    wallet = await d.session.getWallet()
    saltAccount = account
    // The chat store allocates conversation IDs from this account's private salt. It is
    // installed as soon as the wallet is at hand, before the relay is asked anything, and
    // stays through every messaging restart: it belongs to the account, not to the connection.
    setConversationIdSalt(conversationIdSaltOf(wallet))
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
    if (failure === 'entry-refused') {
      try {
        const identity = (
          wallet as unknown as { identity?: { address?: string } }
        )?.identity
        if (identity?.address) {
          const network = networkOf(d.networkTag)
          void d.directory.pins.save(`${network}:${identity.address}`, '')
          void d.directory.pins.save(
            `pending:${network}:${identity.address}`,
            '',
          )
        }
      } catch {
        // ignore
      }
    }
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
      d.resumeLegacy?.()
      void d.claimUsername?.({
        relayBaseUrl: d.relayBaseUrl,
        network: networkOf(d.networkTag),
        wallet,
      })
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
  cancelDirectoryLookupWaiters()
  if (d.session.state.status !== 'ready') return
  // An account change during the attempt is not a failure: start over at once for the new one.
  if (failure) failures += 1
  retryTimer = setTimeout(
    () => {
      retryTimer = undefined
      if (!live && d.session.state.status === 'ready') void startMessaging()
    },
    failure ? d.retryDelayMs(failures) : 50,
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
