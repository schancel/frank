/**
 * Monad identity startup shared by boot and sign-up finish (#389).
 *
 * `boot/monad-direct-messages.ts` runs once, so a seed written during sign-up used to require
 * a full page reload before polling, registration, and outgoing reconciliation existed. Finish
 * calls `initializeMonadIdentity` in this document instead. The same seed is a no-op (one poll
 * loop). A different seed stops the previous loops before the new wallet is published, so a
 * replace cannot leave the old poller writing into the new session.
 *
 * Registration failures are logged, not thrown: a relay hiccup must not block entering the app.
 * The browser persistent-storage launch check runs here too, because a reload no longer remounts
 * `App.vue` after finish. It does not ask again when sign-up just asked (see `mayRequestOnLaunch`).
 */
import { activeChain } from '@frank/wallet/chain'
import type { WalletHandle } from '@frank/wallet/chain'
import {
  MonadIdentity,
  registerMonadIdentity,
} from '@frank/wallet/monad-identity'
import {
  type MonadChainConfig,
  loadMonadChainConfigFromEnv,
} from '@frank/wallet/chain/monad-chain'
import {
  startDirectMessagePolling,
  startOutgoingReconciliation,
} from '../adapters/pinia-chain-adapter'
import { useChatStore } from '../stores/chats'
import { useMailboxStatusStore } from '../stores/mailbox-status'
import { useProfileStore } from '../stores/my-profile'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import { useWalletStore } from '../stores/wallet'
import { useMonadWallet } from './clients'

export const DEFAULT_DM_POLL_INTERVAL_MS = 7000

export type InitializeResult = 'started' | 'noop' | 'skipped'

type Stoppable = { stop: () => void }

type LiveSession = {
  seed: string
  wallet: WalletHandle
  polling: Stoppable
  reconcile: Stoppable
}

export type MonadIdentityDeps = {
  createWallet: (seed: { mnemonic: string }) => Promise<WalletHandle>
  register: typeof registerMonadIdentity
  startPolling: typeof startDirectMessagePolling
  startReconcile: typeof startOutgoingReconciliation
  loadConfig: () => MonadChainConfig
  ensurePersistentStorage: () => Promise<void>
}

let pollIntervalMs = DEFAULT_DM_POLL_INTERVAL_MS
let finishReloads = false
let active: LiveSession | null = null
let tail: Promise<void> = Promise.resolve()

export function configureMonadIdentitySession(options: {
  pollIntervalMs?: number
  finishReloads?: boolean
}): void {
  if (options.pollIntervalMs !== undefined) {
    const interval = options.pollIntervalMs
    pollIntervalMs =
      Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_DM_POLL_INTERVAL_MS
  }
  if (options.finishReloads !== undefined) finishReloads = options.finishReloads
}

/** Explicit fallback while in-place finish is verified. Boot sets this from
 * `QCLI_SETUP_FINISH_RELOAD=true`. Default is in-place, no reload. */
export function setupFinishReloads(): boolean {
  return finishReloads
}

export function resetMonadIdentitySessionForTests(): void {
  if (active) {
    active.polling.stop()
    active.reconcile.stop()
    active = null
  }
  tail = Promise.resolve()
  pollIntervalMs = DEFAULT_DM_POLL_INTERVAL_MS
  finishReloads = false
}

function defaultDeps(): MonadIdentityDeps {
  return {
    createWallet: seed => activeChain.createWallet(seed),
    register: params => registerMonadIdentity(params),
    startPolling: startDirectMessagePolling,
    startReconcile: startOutgoingReconciliation,
    loadConfig: loadMonadChainConfigFromEnv,
    ensurePersistentStorage: () =>
      usePersistentStorageStore().ensureForAccount(),
  }
}

async function ensureIdentityRegistered(
  deps: MonadIdentityDeps,
  identity: MonadIdentity,
  profile: { name?: string; bio?: string; avatar?: string },
): Promise<void> {
  const config = deps.loadConfig()
  try {
    await deps.register({
      relayBaseUrl: config.relayBaseUrl,
      identity,
      profile,
    })
  } catch (err) {
    console.error(
      `monad identity: failed to register ${identity.displayAddress} -- ` +
        'others cannot discover or message this wallet until this succeeds',
      err,
    )
  }
}

async function initializeExclusive(
  deps: MonadIdentityDeps,
): Promise<InitializeResult> {
  const walletStore = useWalletStore()
  await walletStore.restored
  const profileStore = useProfileStore()
  await profileStore.restored
  const chatStore = useChatStore()
  await chatStore.restored

  const seed = walletStore.seedPhrase
  if (!seed) return 'skipped'
  if (active?.seed === seed) return 'noop'

  if (active) {
    active.polling.stop()
    active.reconcile.stop()
    active = null
    useMailboxStatusStore().setOk()
  }

  const wallet = await deps.createWallet({ mnemonic: seed })
  // Serialized, but the store can still change while the wallet derives.
  // Do not publish a wallet for a seed that is no longer current.
  if (useWalletStore().seedPhrase !== seed) return 'skipped'

  useMonadWallet(wallet)
  await ensureIdentityRegistered(
    deps,
    wallet.identity as MonadIdentity,
    profileStore.profile,
  )
  if (useWalletStore().seedPhrase !== seed) return 'skipped'

  const polling = deps.startPolling({
    wallet,
    intervalMs: pollIntervalMs,
  })
  const reconcile = deps.startReconcile({ wallet })
  active = { seed, wallet, polling, reconcile }
  try {
    await deps.ensurePersistentStorage()
  } catch (err) {
    console.error('monad identity: persistent-storage check failed', err)
  }
  return 'started'
}

export function initializeMonadIdentity(
  overrides: Partial<MonadIdentityDeps> = {},
): Promise<InitializeResult> {
  const deps = { ...defaultDeps(), ...overrides }
  const run = tail.then(() => initializeExclusive(deps))
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
