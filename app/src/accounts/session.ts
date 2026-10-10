import { reactive, readonly } from 'vue'
import {
  activeChain,
  getChainRegistryEntry,
  resolveNetworkId,
  type NativeWalletHandle,
  type SupportedCurve,
  type WalletHandle,
} from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { Platform } from 'quasar'
import type { DomainRoot } from '@frank/domain-roots'
import {
  decodeRecoveryDescriptor,
  exportCodex32Backup,
} from '@frank/account-recovery'
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
  | 'standby'
export interface AccountSessionState {
  status: SessionStatus
  revision: number
  account: PublicAccount | null
  pending: CustodySnapshot['pending']
  pendingReady: boolean
  /**
   * The identity address the pending attempt would activate, read from the staged material
   * itself. Public. Set whenever the attempt is ready, so it can be shown before Activate.
   */
  pendingIdentityAddress: string | null
  pendingError: string | null
  error: string | null
}

/**
 * The active account has no key material for this purpose. That only happens for an account
 * stored before the app kept account roots: it runs on the roots saved at the time and cannot
 * derive one added since. Restoring it from its signup shares gives it every purpose.
 */
export class AccountPurposeUnavailableError extends Error {
  readonly code = 'account-purpose-unavailable'

  constructor(readonly purpose: string) {
    super(`This account has no ${purpose} key material`)
    this.name = 'AccountPurposeUnavailableError'
  }
}

/**
 * This account was stored before the app kept account roots. Nothing held here can
 * reproduce the account, so no shares are issued: only the shares shown at signup restore it.
 */
export class AccountBackupUnavailableError extends Error {
  readonly code = 'account-backup-unavailable'

  constructor() {
    super('This account cannot issue new backup shares')
    this.name = 'AccountBackupUnavailableError'
  }
}

async function pendingIdentityAddress(
  custody: AccountCustody,
  attemptId: string,
): Promise<string> {
  const roots = await custody.openPending(attemptId)
  try {
    const root = roots.find(
      value => value.purpose === 'identity-authentication',
    )
    if (!root) throw new CustodyError('locked')
    return MonadIdentity.fromDomainRoot(
      root as DomainRoot<'identity-authentication'>,
    ).displayAddress
  } finally {
    roots.forEach(root => root.bytes.fill(0))
  }
}

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
    pendingIdentityAddress: null,
    pendingError: null,
    error: null,
  })
  let custody: AccountCustody | undefined
  let wallet: RuntimeWallet | undefined
  const chainAddressCache = new Map<string, string>()
  const chainAddressInFlight = new Map<string, Promise<string>>()
  const curveKeyCache = new Map<SupportedCurve, Uint8Array>()
  const curveKeyInFlight = new Map<SupportedCurve, Promise<Uint8Array>>()
  let generation = 0
  let walletGeneration = 0
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
    // Refresh can discover a replacement without an explicit invalidation event.
    if (wallet) ++walletGeneration
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
  const captureDerivation = () => {
    const token = generation
    const walletToken = walletGeneration
    return () => {
      check(token)
      if (walletToken !== walletGeneration) throw new CustodyError('closed')
    }
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
    state.pendingIdentityAddress = null
    state.pendingError = null
    if (snapshot.pending) {
      try {
        const attemptId = snapshot.pending.account.receipt.operationId
        const result = await custody.reconcile(attemptId)
        if (result === 'ready') {
          // Ready means the user can be shown whose account this is before activating it.
          const address = await pendingIdentityAddress(custody, attemptId)
          check(token)
          state.pendingIdentityAddress = address
        }
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
        const netId = resolveNetworkId('monad', activeChain.isTestnet ?? false)
        chainAddressCache.set(netId, wallet.identity.displayAddress)
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
    if (state.status === 'standby') return Promise.resolve()
    if (initialized) return initialized
    initialized = exclusive(runRefresh).finally(() => {
      initialized = undefined
    })
    return initialized
  }
  function invalidate() {
    if (closed || state.status === 'standby') return
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
    setStandby() {
      if (closed) return
      state.status = 'standby'
      state.error = null
    },
    async yieldCustody(): Promise<void> {
      if (closed) return
      ++generation
      state.status = 'standby'
      state.error = null
      await exclusive(async () => {
        try {
          await release()
        } finally {
          custody?.close()
          custody = undefined
        }
      })
    },
    retry() {
      state.status = 'loading'
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
      const checkCurrent = captureDerivation()
      await session.initialize()
      checkCurrent()
      if (!custody || closed || state.status !== 'ready')
        throw new CustodyError('locked')
      const capability = await custody.openActive()
      let roots: readonly DomainRoot[] = []
      try {
        checkCurrent()
        if (capability.account.receipt.context.accountId !== walletAccount)
          throw new CustodyError('conflict')
        roots = capability.takeRoots()
        const found = roots.find(r => r.purpose === purpose)
        if (!found) throw new AccountPurposeUnavailableError(purpose)
        return new Uint8Array(found.bytes)
      } finally {
        roots.forEach(r => r.bytes.fill(0))
        capability.close()
      }
    },
    getCachedChainAddress(chain: string): string | undefined {
      const isTestnet = activeChain.isTestnet ?? false
      const netId = resolveNetworkId(chain, isTestnet)
      if (chain === 'monad' || netId.startsWith('monad-')) {
        return (
          chainAddressCache.get(netId) ??
          chainAddressCache.get('monad') ??
          wallet?.identity?.displayAddress
        )
      }
      return (
        chainAddressCache.get(netId) ??
        chainAddressCache.get(chain) ??
        (chain !== 'ecash' &&
        chain !== 'solana' &&
        chain !== 'bitcoin' &&
        chain !== 'bitcoincash' &&
        chain !== 'dogecoin' &&
        !netId.startsWith('xec-') &&
        !netId.startsWith('solana-') &&
        !netId.startsWith('btc-') &&
        !netId.startsWith('bch-') &&
        !netId.startsWith('doge-') &&
        wallet?.identity?.displayAddress
          ? wallet.identity.displayAddress
          : undefined)
      )
    },
    async getChainAddress(chain: string): Promise<string> {
      const checkCurrent = captureDerivation()
      checkCurrent()
      const fallbackTestnet = activeChain.isTestnet ?? false
      const netId = resolveNetworkId(chain, fallbackTestnet)
      const entry = getChainRegistryEntry(netId)
      const isTestnet = entry?.isTestnet ?? fallbackTestnet
      if (chain === 'monad' || netId.startsWith('monad-')) {
        const wallet = await session.getWallet()
        checkCurrent()
        let address: unknown
        if (typeof (wallet as any).getReceiveAddress === 'function') {
          address = await (wallet as any).getReceiveAddress()
        } else if (wallet.identity?.displayAddress) {
          address = wallet.identity.displayAddress
        }
        checkCurrent()
        const formatted =
          typeof address === 'string'
            ? address
            : activeChain.addressToString(
                address as Parameters<typeof activeChain.addressToString>[0],
              )
        chainAddressCache.set(netId, formatted)
        chainAddressCache.set('monad', formatted)
        return formatted
      }
      const cached = chainAddressCache.get(netId)
      if (cached) return cached
      const inFlight = chainAddressInFlight.get(netId)
      if (inFlight) return inFlight
      const promise = (async () => {
        const purpose =
          chain === 'ecash' ||
          chain === 'bitcoin' ||
          chain === 'bitcoincash' ||
          chain === 'dogecoin' ||
          netId.startsWith('xec-') ||
          netId.startsWith('btc-') ||
          netId.startsWith('bch-') ||
          netId.startsWith('doge-')
            ? 'ecash-bch-wallet'
            : chain === 'solana' || netId.startsWith('solana-')
            ? 'solana-wallet'
            : 'evm-wallet'
        const root = await this.getActiveDomainRoot(purpose)
        try {
          if (chain === 'ecash' || netId.startsWith('xec-')) {
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
            const prefix = isTestnet ? 'ectest' : 'ecash'
            const addr = encodeCashAddress(prefix, 'p2pkh', hash160)
            return addr
          } else if (chain === 'bitcoin' || netId.startsWith('btc-')) {
            const { HDNodeWallet } = await import('ethers')
            const { ripemd160 } = await import('@noble/hashes/ripemd160.js')
            const { sha256 } = await import('@noble/hashes/sha256.js')
            const {
              encodeAddress,
              pubkeyHashFromBytes,
              BTC_MAINNET,
              BTC_TESTNET,
            } = await import('@frank/nakamoto')
            const path = isTestnet ? "m/84'/1'/0'/0/0" : "m/84'/0'/0'/0/0"
            const hdNode = HDNodeWallet.fromSeed(root).derivePath(path)
            const pubKeyHex = hdNode.publicKey.startsWith('0x')
              ? hdNode.publicKey.slice(2)
              : hdNode.publicKey
            const pubKeyBytes = Uint8Array.from(
              pubKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) ?? [],
            )
            const hash160 = ripemd160(sha256(pubKeyBytes))
            const pkh = pubkeyHashFromBytes(hash160)
            if (pkh.ok) {
              const res = encodeAddress(
                { kind: 'p2wpkh', hash: pkh.value },
                isTestnet ? BTC_TESTNET : BTC_MAINNET,
                'bech32',
              )
              if (res.ok) {
                return res.value
              }
            }
            throw new Error('Failed to derive Bitcoin address')
          } else if (chain === 'bitcoincash' || netId.startsWith('bch-')) {
            const { HDNodeWallet } = await import('ethers')
            const { ripemd160 } = await import('@noble/hashes/ripemd160.js')
            const { sha256 } = await import('@noble/hashes/sha256.js')
            const {
              encodeAddress,
              pubkeyHashFromBytes,
              BCH_MAINNET,
              BCH_TESTNET,
            } = await import('@frank/nakamoto')
            const path = "m/44'/145'/0'/0/0"
            const hdNode = HDNodeWallet.fromSeed(root).derivePath(path)
            const pubKeyHex = hdNode.publicKey.startsWith('0x')
              ? hdNode.publicKey.slice(2)
              : hdNode.publicKey
            const pubKeyBytes = Uint8Array.from(
              pubKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) ?? [],
            )
            const hash160 = ripemd160(sha256(pubKeyBytes))
            const pkh = pubkeyHashFromBytes(hash160)
            if (pkh.ok) {
              const res = encodeAddress(
                { kind: 'p2pkh', hash: pkh.value },
                isTestnet ? BCH_TESTNET : BCH_MAINNET,
                'cashaddr',
              )
              if (res.ok) {
                return res.value
              }
            }
            throw new Error('Failed to derive Bitcoin Cash address')
          } else if (chain === 'dogecoin' || netId.startsWith('doge-')) {
            const { HDNodeWallet } = await import('ethers')
            const { ripemd160 } = await import('@noble/hashes/ripemd160.js')
            const { sha256 } = await import('@noble/hashes/sha256.js')
            const { encodeBase58Check } = await import('@frank/nakamoto')
            const path = "m/44'/3'/0'/0/0"
            const hdNode = HDNodeWallet.fromSeed(root).derivePath(path)
            const pubKeyHex = hdNode.publicKey.startsWith('0x')
              ? hdNode.publicKey.slice(2)
              : hdNode.publicKey
            const pubKeyBytes = Uint8Array.from(
              pubKeyHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) ?? [],
            )
            const hash160 = ripemd160(sha256(pubKeyBytes))
            const version = isTestnet ? 0x71 : 0x1e
            const payload = new Uint8Array(21)
            payload[0] = version
            payload.set(hash160, 1)
            const addr = encodeBase58Check(payload)
            return addr
          } else if (chain === 'solana' || netId.startsWith('solana-')) {
            const { Keypair } = await import('@solana/web3.js')
            const kp = await Keypair.fromSeed(root)
            const addr = kp.publicKey.toBase58()
            return addr
          } else {
            const { HDNodeWallet } = await import('ethers')
            const hdNode =
              HDNodeWallet.fromSeed(root).derivePath("m/44'/60'/0'/0/0")
            const addr = hdNode.address
            return addr
          }
        } finally {
          root.fill(0)
        }
      })()
        .then(address => {
          checkCurrent()
          chainAddressCache.set(netId, address)
          return address
        })
        .finally(() => {
          if (chainAddressInFlight.get(netId) === promise) {
            chainAddressInFlight.delete(netId)
          }
        })
      chainAddressInFlight.set(netId, promise)
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
      const checkCurrent = captureDerivation()
      checkCurrent()
      if (curve === 'secp256k1') {
        const cached = session.getCachedCurvePublicKey('secp256k1')
        if (cached) return cached
        const currentWallet = await session.getWallet()
        checkCurrent()
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
            return pubKeyBytes
          } finally {
            root.fill(0)
          }
        }
        throw new Error(`Unsupported curve: ${curve}`)
      })()
        .then(key => {
          checkCurrent()
          curveKeyCache.set(curve, key)
          return key
        })
        .finally(() => {
          if (curveKeyInFlight.get(curve) === promise) {
            curveKeyInFlight.delete(curve)
          }
        })
      curveKeyInFlight.set(curve, promise)
      return promise
    },
    /**
     * Issue a new, independent set of backup shares for the active account. They are
     * split from the stored account root, the same secret the signup shares carry, so
     * they restore this account: same identity, same roots, same addresses.
     */
    async backupCodex32(threshold: number, count: number): Promise<string[]> {
      const checkCurrent = captureDerivation()
      await session.initialize()
      checkCurrent()
      if (!custody || closed || state.status !== 'ready')
        throw new CustodyError('locked')
      const exported = await custody.exportAccountRoot()
      try {
        checkCurrent()
        if (exported.account.receipt.context.accountId !== walletAccount)
          throw new CustodyError('conflict')
        if (!exported.accountRoot) throw new AccountBackupUnavailableError()
        return [
          ...exportCodex32Backup({
            accountRoot: exported.accountRoot,
            // The root must reproduce this account's own recorded fingerprint.
            expected: decodeRecoveryDescriptor(exported.account.descriptor),
            threshold: threshold as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
            shareCount: count,
            randomBytes: length =>
              crypto.getRandomValues(new Uint8Array(length)),
          }),
        ]
      } finally {
        exported.accountRoot?.fill(0)
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
        state.pendingIdentityAddress = null
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

/** Standard-account activation needs its own identity-preserving custody contract. */
export class Bip39ImportUnavailableError extends Error {
  readonly code = 'bip39-import-unavailable'

  constructor() {
    super('BIP39 account import is currently unavailable')
    this.name = 'Bip39ImportUnavailableError'
  }
}

/** Identification is available separately; this unsupported capability never changes custody. */
export async function importBip39Wallet(
  _phrase: string,
  _chosenPath?: string,
): Promise<never> {
  throw new Bip39ImportUnavailableError()
}
