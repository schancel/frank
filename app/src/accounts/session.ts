import { reactive, readonly } from 'vue'
import {
  activeChain,
  type NativeWalletHandle,
  type SupportedCurve,
  type WalletHandle,
} from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import { Platform } from 'quasar'
import type { DomainRoot } from '@frank/domain-roots'
import { createMasterPayload, splitCodex32 } from '@frank/codex32'
import {
  openAccountCustody,
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type PublicAccount,
  type StageAccount,
  type ExpectedActive,
} from './custody'

export type RuntimeWallet = NativeWalletHandle &
  WalletHandle & { close(): Promise<void> }
export type SessionStatus =
  | 'loading'
  | 'fresh'
  | 'pending'
  | 'locked'
  | 'unavailable'
  | 'ready'
export interface AccountSessionState {
  status: SessionStatus
  revision: number
  account: PublicAccount | null
  pending: CustodySnapshot['pending']
  pendingReady: boolean
  pendingError: string | null
  error: string | null
}

export const CODEX32_SHARE_INDICES = [
  'q',
  'p',
  'z',
  'r',
  'y',
  '9',
  'x',
  '8',
  'g',
  'f',
  '2',
  't',
  'v',
  'd',
  'w',
  '0',
  '3',
  'j',
  'n',
  '5',
  '4',
  'k',
  'h',
  'c',
  'e',
  '6',
  'm',
  'u',
  'a',
  '7',
  'l',
] as const

/** The only runtime owner. Its reactive projection contains public data only. */
export function createAccountSession(deps: {
  open: () => Promise<AccountCustody>
  createWallet: (roots: MonadRootBundle | any) => Promise<RuntimeWallet>
  listen?: (invalidate: () => void, foreground: () => void) => () => void
  notify?: () => void
  reset?: () => Promise<void>
}) {
  const state = reactive<AccountSessionState>({
    status: 'loading',
    revision: 0,
    account: null,
    pending: null,
    pendingReady: false,
    pendingError: null,
    error: null,
  })
  let custody: AccountCustody | undefined
  let wallet: RuntimeWallet | undefined
  const chainAddressCache = new Map<'monad' | 'ecash' | 'solana', string>()
  const chainAddressInFlight = new Map<'ecash' | 'solana', Promise<string>>()
  const curveKeyCache = new Map<SupportedCurve, Uint8Array>()
  const curveKeyInFlight = new Map<SupportedCurve, Promise<Uint8Array>>()
  let generation = 0
  let tail = Promise.resolve()
  let initialized: Promise<void> | undefined
  let unlisten: (() => void) | undefined
  let closed = false
  const publish = (snapshot: CustodySnapshot) => {
    // Custody returns a new object for every snapshot. Consumers hold `state.account` across
    // `getWallet()` (which revalidates) and compare it by identity to detect an account change, so
    // an unchanged account at an unchanged revision must keep its published object.
    const unchanged =
      state.account !== null &&
      snapshot.active !== null &&
      state.revision === snapshot.revision &&
      state.account.receipt.context.accountId ===
        snapshot.active.receipt.context.accountId
    state.revision = snapshot.revision
    if (!unchanged) state.account = snapshot.active
    state.pending = snapshot.pending
  }
  const fail = (error: unknown) => {
    const code = error instanceof CustodyError ? error.code : 'unavailable'
    state.error = code
    state.status = code === 'unavailable' ? 'unavailable' : 'locked'
  }
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const release = async () => {
    chainAddressCache.clear()
    chainAddressInFlight.clear()
    curveKeyCache.clear()
    curveKeyInFlight.clear()
    const previous = wallet
    wallet = undefined
    if (previous) await previous.close()
  }
  const check = (token: number) => {
    if (closed || token !== generation) throw new CustodyError('closed')
  }
  async function refresh(token: number) {
    check(token)
    custody ??= await deps.open()
    check(token)
    let snapshot = await custody.snapshot()
    check(token)
    if (
      wallet &&
      (walletAccount !== snapshot.active?.receipt.context.accountId ||
        walletRevision !== snapshot.revision)
    ) {
      state.status = 'loading'
      await release()
      check(token)
    }
    publish(snapshot)
    state.pendingReady = false
    state.pendingError = null
    if (snapshot.pending) {
      try {
        const result = await custody.reconcile(
          snapshot.pending.account.receipt.operationId,
        )
        state.pendingReady = result === 'ready'
      } catch (error) {
        state.pendingError =
          error instanceof CustodyError ? error.code : 'unavailable'
      }
      check(token)
      snapshot = await custody.snapshot()
      check(token)
      publish(snapshot)
    }
    if (!snapshot.active) {
      await release()
      check(token)
      state.status = snapshot.pending ? 'pending' : 'fresh'
      state.error = null
      return
    }
    if (
      wallet &&
      walletAccount === snapshot.active.receipt.context.accountId &&
      walletRevision === snapshot.revision
    ) {
      if (state.pendingError) {
        // Failed pending cleanup is not evidence that the separate active record is locked.
        const active = await custody.openActive()
        active.close()
        check(token)
        if (active.account.receipt.context.accountId !== walletAccount)
          throw new CustodyError('conflict')
      }
      state.status = 'ready'
      state.error = null
      return
    }
    await release()
    check(token)
    const capability = await custody.openActive()
    let roots: readonly DomainRoot[] = []
    let candidate: RuntimeWallet | undefined
    try {
      check(token)
      roots = capability.takeRoots()
      const find = <P extends DomainRoot['purpose']>(
        purpose: P,
      ): DomainRoot<P> => {
        const root = roots.find(value => value.purpose === purpose)
        if (!root) throw new CustodyError('locked')
        return root as DomainRoot<P>
      }
      candidate = await deps.createWallet({
        evm: find('evm-wallet'),
        authentication: find('identity-authentication'),
        messaging: find('messaging-encryption'),
      })
      check(token)
      const latest = await custody.snapshot()
      check(token)
      if (
        latest.revision !== snapshot.revision ||
        latest.active?.receipt.context.accountId !==
          capability.account.receipt.context.accountId
      )
        throw new CustodyError('conflict')
      wallet = candidate
      candidate = undefined
      walletAccount = capability.account.receipt.context.accountId
      walletRevision = latest.revision
      if (wallet?.identity?.displayAddress) {
        chainAddressCache.set('monad', wallet.identity.displayAddress)
      }
      publish(latest)
      state.status = 'ready'
      state.error = null
    } finally {
      roots.forEach(root => root.bytes.fill(0))
      capability.close()
      if (candidate) await candidate.close()
    }
  }
  let walletAccount: string | undefined
  let walletRevision = -1
  async function runRefresh() {
    const token = generation
    try {
      await refresh(token)
    } catch (error) {
      if (!closed && token === generation) {
        try {
          await release()
        } finally {
          fail(error)
        }
      }
    }
  }
  function revalidate() {
    if (initialized) return initialized
    initialized = exclusive(runRefresh).finally(() => {
      initialized = undefined
    })
    return initialized
  }
  function invalidate() {
    if (closed) return
    ++generation
    // close() revokes the native handle synchronously, before its teardown awaits.
    const releasing = release()
    // Observe teardown failure immediately even when an earlier operation still owns the queue.
    void releasing.catch(() => undefined)
    void exclusive(async () => {
      try {
        await releasing
        await runRefresh()
      } catch (error) {
        if (!closed) fail(error)
      }
    })
    // Schedule teardown before reactive consumers can enqueue another acquisition.
    state.status = 'loading'
  }
  const session = {
    state: readonly(state),
    setBip39Params(_params?: { mnemonic: string; path: string }) {
      // Deprecated: Wallets are now always instantiated with typed domain roots from custody.
    },
    initialize() {
      if (closed) return Promise.resolve()
      unlisten ??= deps.listen?.(invalidate, () => {
        void revalidate().catch(() => undefined)
      })
      return revalidate()
    },
    retry() {
      return exclusive(runRefresh)
    },
    async getWallet(): Promise<RuntimeWallet> {
      await session.initialize()
      if (state.status !== 'ready' || !wallet) throw new CustodyError('locked')
      return wallet
    },
    async getActiveDomainRoot<P extends DomainRoot['purpose']>(
      purpose: P,
    ): Promise<Uint8Array> {
      await session.initialize()
      if (!custody || closed || state.status !== 'ready')
        throw new CustodyError('locked')
      const capability = await custody.openActive()
      let roots: readonly DomainRoot[] = []
      try {
        roots = capability.takeRoots()
        const found = roots.find(r => r.purpose === purpose)
        if (!found) throw new CustodyError('locked')
        return new Uint8Array(found.bytes)
      } finally {
        roots.forEach(r => r.bytes.fill(0))
        capability.close()
      }
    },
    async getActiveWalletRoot(): Promise<Uint8Array> {
      return this.getActiveDomainRoot('evm-wallet')
    },
    getCachedChainAddress(chain: string): string | undefined {
      if (chain === 'monad') {
        return (
          chainAddressCache.get('monad') ?? wallet?.identity?.displayAddress
        )
      }
      return (
        chainAddressCache.get(chain) ??
        (chain !== 'ecash' &&
        chain !== 'solana' &&
        wallet?.identity?.displayAddress
          ? wallet.identity.displayAddress
          : undefined)
      )
    },
    async getChainAddress(chain: string): Promise<string> {
      if (chain === 'monad') {
        const wallet = await session.getWallet()
        let address: unknown
        if (typeof (wallet as any).getReceiveAddress === 'function') {
          address = await (wallet as any).getReceiveAddress()
        } else if (wallet.identity?.displayAddress) {
          address = wallet.identity.displayAddress
        }
        const formatted =
          typeof address === 'string'
            ? address
            : activeChain.addressToString(
                address as Parameters<typeof activeChain.addressToString>[0],
              )
        chainAddressCache.set('monad', formatted)
        return formatted
      }
      const cached = chainAddressCache.get(chain)
      if (cached) return cached
      const inFlight = chainAddressInFlight.get(chain)
      if (inFlight) return inFlight
      const promise = (async () => {
        const purpose =
          chain === 'ecash'
            ? 'ecash-bch-wallet'
            : chain === 'solana'
            ? 'solana-wallet'
            : 'evm-wallet'
        const root = await this.getActiveDomainRoot(purpose)
        try {
          if (chain === 'ecash') {
            const { HDNodeWallet } = await import('ethers')
            const { encodeCashAddress } = await import('ecashaddrjs')
            const { ripemd160 } = await import('@noble/hashes/ripemd160.js')
            const { sha256 } = await import('@noble/hashes/sha256.js')
            const hdNode =
              HDNodeWallet.fromSeed(root).derivePath("m/44'/1899'/0'/0/0")
            const pubKeyHex = hdNode.publicKey.startsWith('0x')
              ? hdNode.publicKey.slice(2)
              : hdNode.publicKey
            const pubKeyBytes = Uint8Array.from(
              pubKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) ?? [],
            )
            const hash160 = ripemd160(sha256(pubKeyBytes))
            const prefix = activeChain.isTestnet ? 'ectest' : 'ecash'
            const addr = encodeCashAddress(prefix, 'p2pkh', hash160)
            chainAddressCache.set('ecash', addr)
            return addr
          } else if (chain === 'solana') {
            const { Keypair } = await import('@solana/web3.js')
            const kp = await Keypair.fromSeed(root)
            const addr = kp.publicKey.toBase58()
            chainAddressCache.set('solana', addr)
            return addr
          } else {
            const { HDNodeWallet } = await import('ethers')
            const hdNode =
              HDNodeWallet.fromSeed(root).derivePath("m/44'/60'/0'/0/0")
            const addr = hdNode.address
            chainAddressCache.set(chain, addr)
            return addr
          }
        } finally {
          root.fill(0)
          chainAddressInFlight.delete(chain)
        }
      })()
      chainAddressInFlight.set(chain, promise)
      promise.catch(() => {
        if (chainAddressInFlight.get(chain) === promise) {
          chainAddressInFlight.delete(chain)
        }
      })
      return promise
    },
    getCachedCurvePublicKey(curve: SupportedCurve): Uint8Array | undefined {
      if (curve === 'secp256k1') {
        const cached = curveKeyCache.get('secp256k1')
        if (cached) return cached
        if (wallet?.identity?.compressedPubKey) {
          const key = new Uint8Array(wallet.identity.compressedPubKey)
          curveKeyCache.set('secp256k1', key)
          return key
        }
        return undefined
      }
      return curveKeyCache.get(curve)
    },
    async getCurvePublicKey(curve: SupportedCurve): Promise<Uint8Array> {
      if (curve === 'secp256k1') {
        const cached = session.getCachedCurvePublicKey('secp256k1')
        if (cached) return cached
        const currentWallet = await session.getWallet()
        if (!currentWallet.identity?.compressedPubKey) {
          throw new Error(
            'No identity compressedPubKey available for secp256k1',
          )
        }
        const key = new Uint8Array(currentWallet.identity.compressedPubKey)
        curveKeyCache.set('secp256k1', key)
        return key
      }
      const cached = curveKeyCache.get(curve)
      if (cached) return cached
      const inFlight = curveKeyInFlight.get(curve)
      if (inFlight) return inFlight
      const promise = (async () => {
        if (curve === 'ed25519') {
          const root = await this.getActiveDomainRoot('solana-wallet')
          try {
            const { Keypair } = await import('@solana/web3.js')
            const kp = await Keypair.fromSeed(root)
            const pubKeyBytes = new Uint8Array(kp.publicKey.toBytes())
            curveKeyCache.set('ed25519', pubKeyBytes)
            return pubKeyBytes
          } finally {
            root.fill(0)
            curveKeyInFlight.delete(curve)
          }
        }
        throw new Error(`Unsupported curve: ${curve}`)
      })()
      curveKeyInFlight.set(curve, promise)
      promise.catch(() => {
        if (curveKeyInFlight.get(curve) === promise) {
          curveKeyInFlight.delete(curve)
        }
      })
      return promise
    },
    async backupCodex32(threshold = 2, count = 3): Promise<string[]> {
      const root = await this.getActiveWalletRoot()
      let master: { ok: boolean; value?: Uint8Array } | undefined
      try {
        master = createMasterPayload(root)
        if (!master.ok || !master.value)
          throw new Error('Failed to create master payload')
        const safeThreshold = Math.max(
          2,
          Math.min(9, Math.floor(threshold)),
        ) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
        const safeCount = Math.max(
          safeThreshold,
          Math.min(CODEX32_SHARE_INDICES.length, Math.floor(count)),
        )
        const split = splitCodex32({
          threshold: safeThreshold,
          identifier: 'frnk',
          indices: CODEX32_SHARE_INDICES.slice(0, safeCount),
          secret: master.value,
          randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
        })
        if (!split.ok) throw new Error(split.error.code)
        return [...split.value]
      } finally {
        root.fill(0)
        master?.value?.fill(0)
      }
    },
    async snapshot() {
      await this.initialize()
      if (!custody || closed) throw new CustodyError('unavailable')
      return custody.snapshot()
    },
    async stage(input: StageAccount) {
      return exclusive(async () => {
        if (!custody || closed) throw new CustodyError('unavailable')
        const token = generation
        // The caller retains roots until this promise settles; custody owns persistence.
        try {
          const snapshot = await custody.stage(input)
          check(token)
          publish(snapshot)
        } finally {
          deps.notify?.()
          await runRefresh()
        }
      })
    },
    async activatePending(attemptId: string, expectedActive: ExpectedActive) {
      const wanted = { ...expectedActive }
      return exclusive(async () => {
        if (!custody || closed) throw new CustodyError('unavailable')
        const snapshot = await custody.snapshot()
        const pending = snapshot.pending
        if (
          !pending ||
          pending.status !== 'staging' ||
          pending.account.receipt.operationId !== attemptId ||
          pending.expectedActive.revision !== wanted.revision ||
          pending.expectedActive.accountId !== wanted.accountId
        )
          throw new CustodyError('conflict')
        // Explicit user action is required even when staged material survived a restart.
        const token = ++generation
        state.status = 'loading'
        try {
          await release()
          check(token)
          const activated = await custody.activate(attemptId, wanted)
          check(token)
          publish(activated)
        } finally {
          deps.notify?.()
          await runRefresh()
        }
      })
    },
    async cancelPending(attemptId: string) {
      return exclusive(async () => {
        if (!custody || closed) throw new CustodyError('unavailable')
        try {
          await custody.cancel(attemptId)
        } finally {
          await runRefresh()
        }
      })
    },
    async close() {
      closed = true
      unlisten?.()
      unlisten = undefined
      ++generation
      state.status = 'locked'
      await exclusive(async () => {
        try {
          await release()
        } finally {
          custody?.close()
          custody = undefined
        }
      })
    },
    async reset() {
      return exclusive(async () => {
        closed = false
        ++generation
        state.status = 'loading'
        state.error = null
        state.account = null
        state.pending = null
        state.pendingReady = false
        state.pendingError = null
        await release()
        custody?.close()
        custody = undefined
        if (deps.reset) {
          await deps.reset()
        } else {
          await resetAccountStorage()
        }
        deps.notify?.()
        await runRefresh()
      })
    },
  }
  return session
}

export async function resetAccountStorage(
  namespace = 'local-account-v1',
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const names = new Set<string>([
    `frank-account-custody-${namespace}`,
    `frank-preview-vault-${namespace}`,
  ])
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (
          db.name &&
          (db.name.startsWith('frank-') ||
            db.name.includes('monad-wallet-state') ||
            db.name.includes('level-js'))
        ) {
          names.add(db.name)
        }
      }
    }
  } catch {
    // indexedDB.databases may fail in some environments
  }
  for (const name of names) {
    await new Promise<void>(resolve => {
      try {
        const req = indexedDB.deleteDatabase(name)
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => {
          setTimeout(resolve, 300)
        }
      } catch {
        resolve()
      }
    })
  }
}

let accountChannel: BroadcastChannel | undefined
export const accountSession = createAccountSession({
  listen(invalidate, foreground) {
    const channel =
      typeof window.BroadcastChannel === 'function'
        ? new window.BroadcastChannel('frank-account-changed-v1')
        : undefined
    accountChannel = channel
    if (channel) channel.onmessage = invalidate
    const visible = () => {
      if (!document.hidden) foreground()
    }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', visible)
    return () => {
      channel?.close()
      if (accountChannel === channel) accountChannel = undefined
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', visible)
    }
  },
  notify() {
    accountChannel?.postMessage('changed')
  },
  open: () => {
    // Preview capability evidence is browser-only; native webviews do not inherit it.
    if (Platform.is.electron || Platform.is.capacitor || Platform.is.cordova)
      return Promise.reject(new CustodyError('unavailable'))
    return openAccountCustody({ namespace: 'local-account-v1' })
  },
  createWallet: roots => activeChain.createWallet(roots),
})
export const accountStatus = accountSession.state

/**
 * Directly constructs the wallet session from the BIP39 seed and the chosen candidate path,
 * stages it via accountSession.stage(...), and activates it without quarantine or new Codex32 identity.
 */
export async function importBip39Wallet(
  phrase: string,
  chosenPath?: string,
): Promise<{
  path: string
  address: string
  label: string
  wallet?: RuntimeWallet
}> {
  const cleanPhrase = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
  const { validateMnemonic } = await import('bip39')
  if (!validateMnemonic(cleanPhrase)) {
    throw new Error('Invalid BIP-39 mnemonic')
  }

  const { CANONICAL_FRANK_PATH, deriveCandidateAccounts } = await import(
    '@frank/wallet/bip39-import'
  )

  const path = chosenPath ?? CANONICAL_FRANK_PATH
  const candidates = deriveCandidateAccounts(cleanPhrase)
  const candidate = candidates.find(c => c.path === path) ??
    candidates[0] ?? {
      path,
      label: 'Imported BIP39',
      address: '',
      privateKey: '',
    }

  // Stage via accountSession.stage(...)
  const { DOMAIN_PURPOSES, deriveDomainRoot } = await import(
    '@frank/domain-roots'
  )
  const { createMasterPayload } = await import('@frank/codex32')
  const { deriveRecoveryPublicMetadata } = await import(
    '@frank/account-recovery'
  )
  const { sha256 } = await import('@noble/hashes/sha256.js')
  const { getBytes } = await import('ethers')

  const seedBytes = getBytes(
    sha256(new TextEncoder().encode(cleanPhrase + ':' + path)),
  )
  const masterPayload = createMasterPayload(seedBytes)
  if (!masterPayload.ok) {
    throw new Error('Failed to create account master payload')
  }
  const metadata = deriveRecoveryPublicMetadata(masterPayload.value)
  const roots = DOMAIN_PURPOSES.map(purpose =>
    deriveDomainRoot(seedBytes, purpose),
  )

  const snapshot = await accountSession.snapshot()
  const attemptId = crypto.randomUUID()
  const accountId = crypto.randomUUID()
  const expectedActive = {
    revision: snapshot.revision,
    accountId: snapshot.active?.receipt.context.accountId ?? null,
  }

  await accountSession.stage({
    attemptId,
    accountId,
    expectedActive,
    displayName: candidate.label || 'Imported BIP39',
    custodyEpoch: 1,
    metadata,
    roots,
  })

  // Activate it
  await accountSession.activatePending(attemptId, expectedActive)

  let wallet: RuntimeWallet | undefined
  try {
    wallet = await accountSession.getWallet()
  } catch {
    // Session status not ready or mock
  }

  return {
    path,
    address: candidate.address || wallet?.identity?.address?.raw || '',
    label: candidate.label || 'Imported BIP39',
    wallet,
  }
}
