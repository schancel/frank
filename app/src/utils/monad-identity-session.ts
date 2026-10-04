/**
 * Account and messaging session (#778).
 *
 * Custody owns the one typed runtime wallet. Direct messaging is a separate, visibly pending state:
 * it starts only after `checkDirectoryReadiness` verified the operator-installed public
 * configuration at every participant and the browser admitted fresh directory evidence. It never
 * uses display-profile keys or the legacy envelope, and it stops as soon as the account changes.
 */
import { watch } from 'vue'
import type { WalletHandle } from '@frank/wallet/chain'
import {
  installCanonicalDirectory,
  loadMonadChainConfigFromEnv,
} from '@frank/wallet/chain/monad-chain'
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import type { DirectoryFetch } from '@frank/cashweb/relay/directory-client'
import { fromHex } from '@frank/codec'
import { accountSession, accountStatus } from '../accounts/session'
import { setDirectoryPeer } from './directory-peer'
import { discardUnenrolledDirectoryStore } from './directory-store-reset'
import {
  startDirectMessagePolling,
  startOutgoingReconciliation,
} from '../adapters/pinia-chain-adapter'
import {
  PROVISIONING_BODY_LIMIT,
  fetchInstallationSnapshot,
} from './directory-provisioning'
import {
  idleParticipants,
  messagingState,
  mutableMessagingState,
  type MessagingState,
} from './messaging-state'
import {
  checkDirectoryReadiness,
  parseCheckpoint,
  preparePublicExport,
  serializeCheckpoint,
  type DirectoryActivation,
  type PublicExportFile,
  type ReadinessDeps,
  type ReadinessReason,
} from './directory-readiness'

type Stoppable = { stop: () => void }
interface Live {
  activation: DirectoryActivation
  accountId: string | undefined
  uninstall: () => void
  polling: Stoppable
  reconcile: Stoppable
}
export interface MessagingDeps {
  readiness: ReadinessDeps
  install: typeof installCanonicalDirectory
  startPolling: (options: { wallet: WalletHandle }) => Stoppable
  startReconcile: (options: { wallet: WalletHandle }) => Stoppable
}

const CHECKPOINT_PREFIX = 'frank-directory-checkpoint:'
const EXPORT_PREFIX = 'frank-directory-export:'
const accountIdOf = (account: unknown): string | undefined =>
  (account as { receipt?: { context?: { accountId?: string } } } | null)
    ?.receipt?.context?.accountId

function productionDeps(): MessagingDeps {
  return {
    readiness: {
      session: accountSession,
      relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
      nowNs: () => BigInt(Date.now()) * 1_000_000n,
      async loadDeployed(name, signal) {
        // Installed by the operator beside the app; a missing file is served as the SPA page.
        const response = await fetch(
          new URL(`directory/${name}`, document.baseURI).toString(),
          { cache: 'no-store', credentials: 'omit', redirect: 'error', signal },
        )
        if (
          response.status !== 200 ||
          response.headers.get('content-type')?.split(';')[0].trim() !==
            'application/json'
        )
          return null
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.length > PROVISIONING_BODY_LIMIT)
          throw new Error('Operator file exceeds the public bundle limit')
        return bytes
      },
      fetchSnapshot: (participant, manifest, signal) =>
        fetchInstallationSnapshot(participant, manifest, signal),
      openStore: options => openBrowserDirectoryStore(options),
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
      directoryFetch: ((url, init) =>
        fetch(url, init as RequestInit)) as DirectoryFetch,
      discardUnenrolled: discardUnenrolledDirectoryStore,
      exports: {
        load: key => window.localStorage.getItem(EXPORT_PREFIX + key),
        save: (key, value) =>
          window.localStorage.setItem(EXPORT_PREFIX + key, value),
      },
    },
    install: installCanonicalDirectory,
    startPolling: startDirectMessagePolling,
    startReconcile: startOutgoingReconciliation,
  }
}

const idle = idleParticipants
const state = mutableMessagingState
export { messagingState }
export type { MessagingState }

let deps: MessagingDeps | undefined
let live: Live | undefined
let running: AbortController | undefined
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
  state.participants = idle()
}

/** The live wallet for direct messages, only while messaging is verified ready. */
export function messagingWallet(): WalletHandle | undefined {
  return live ? (live.activation.wallet as unknown as WalletHandle) : undefined
}

export async function stopMessaging(): Promise<void> {
  running?.abort()
  running = undefined
  const previous = live
  live = undefined
  state.peerAddress = null
  setDirectoryPeer(null)
  if (state.status === 'ready') state.status = 'pending'
  if (!previous) return
  previous.polling.stop()
  previous.reconcile.stop()
  previous.uninstall()
  await previous.activation.close()
}

/**
 * Run the readiness barrier. `explicit` is the user's own Settings action and is the only path
 * that may publish this account's revision-zero evidence; automatic runs only reopen.
 */
export async function refreshMessaging(explicit: boolean): Promise<void> {
  const d = dependencies()
  await stopMessaging()
  const controller = new AbortController()
  running = controller
  state.status = 'checking'
  let result
  try {
    result = await checkDirectoryReadiness(d.readiness, {
      allowEnrollment: explicit,
      signal: controller.signal,
    })
  } catch {
    result = {
      status: 'pending' as const,
      reason: 'admission-failed' as const,
      participants: idle(),
    }
  }
  if (running !== controller) {
    // Superseded by a newer check or an account change: publish nothing from this one.
    if (result.status === 'ready') await result.activation.close()
    return
  }
  running = undefined
  state.participants = result.participants
  if (result.status !== 'ready') {
    state.status = 'pending'
    state.reason = result.reason
    return
  }
  const { activation } = result
  let uninstall: () => void
  try {
    uninstall = d.install(activation.wallet, activation.directory)
  } catch {
    await activation.close()
    state.status = 'pending'
    state.reason = 'account-unavailable'
    return
  }
  const wallet = activation.wallet as unknown as WalletHandle
  live = {
    activation,
    accountId: accountIdOf(activation.account),
    uninstall,
    polling: d.startPolling({ wallet }),
    reconcile: d.startReconcile({ wallet }),
  }
  state.peerAddress = activation.peerAddress
  setDirectoryPeer({
    address: activation.peerAddress,
    pubKey: fromHex(activation.peerSubject),
  })
  state.status = 'ready'
  state.reason = null
}

/** Explicit user action: this account's public export for the operator. Sends nothing. */
export async function exportPublicIdentity(): Promise<
  { ok: true; file: PublicExportFile } | { ok: false; reason: ReadinessReason }
> {
  return preparePublicExport(
    dependencies().readiness,
    new AbortController().signal,
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
          revision !== live.activation.revision ||
          accountId !== live.accountId)
      )
        void stopMessaging()
      else if (!live && status === 'ready' && state.status !== 'checking')
        void refreshMessaging(false)
    },
  )
}

/** Opens custody, then tries to resume already-admitted messaging. Never enrolls on its own. */
export async function initializeMonadIdentity(): Promise<
  'started' | 'skipped'
> {
  await accountSession.initialize()
  watchAccount()
  if (accountStatus.status !== 'ready') return 'skipped'
  // Not awaited: a slow or absent relay must not block entering the app.
  void refreshMessaging(false)
  return 'started'
}
