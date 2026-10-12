import {
  validateEvmWalletConfiguration,
  verifyEvmWalletRpcIdentity,
} from './evm-wallet-verification'
import { reactive, readonly } from 'vue'
import { toHex } from '@frank/codec'
import {
  activeChain,
  createEvmChain,
  type EvmChainConfig,
  type EvmChainWalletHandle,
  EvmNativeJournalError,
  getChainRegistryEntry,
  resolveNetworkId,
  getCustomRelayBaseUrl,
  getDefaultRelayBaseUrl,
  type NativeWalletHandle,
  type RelayUtxoChain,
  type SupportedCurve,
  type WalletHandle,
} from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import type { HistoricalBip39Seed } from '@frank/wallet/monad-wallet-material'
import { BIP39_DERIVATION, BIP39_RECOVERY_FORMAT } from '@frank/account-vault'
import {
  privateKeyFromBytes,
  publicFromPrivate,
  signEcdsa,
  type PrivateKey,
} from '@frank/nakamoto'
import { stealthParentSecret } from '@frank/cashweb/relay/stealth-parent'
import {
  requireCompressedStealthPoint,
  type UtxoStealthCustody,
} from '@frank/wallet/utxo-stealth'
import {
  createEcashStealthSeedBackend,
  createEcashStealthBip39SeedBackend,
} from '@frank/wallet/ecash-seed-boundary'
import {
  ecashStealthPoint,
  type EcashStealthCustody,
} from '@frank/wallet/ecash-stealth'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { Platform } from 'quasar'
import type { DomainRoot } from '@frank/domain-roots'
import {
  decodeRecoveryDescriptor,
  exportCodex32Backup,
  exportHistoricalCodex32Backup,
} from '@frank/account-recovery'
import {
  openAccountCustody,
  CustodyError,
  type AccountCustody,
  type CustodySnapshot,
  type PublicAccount,
  type StageAccount,
  type StageBip39Account,
  type ExpectedActive,
} from './custody'

/** Public receive-address failures contain no provider or key material. */
export class AccountAddressUnavailableError extends Error {
  constructor(readonly code: 'unknown-network' | 'network-mismatch') {
    super(code)
    this.name = 'AccountAddressUnavailableError'
  }
}

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
 * The original backup secret is unavailable, so this account cannot issue new shares.
 */
export class AccountBackupUnavailableError extends Error {
  readonly code = 'account-backup-unavailable'

  constructor() {
    super('The original backup secret is unavailable')
    this.name = 'AccountBackupUnavailableError'
  }
}

async function pendingIdentityAddress(
  custody: AccountCustody,
  attemptId: string,
): Promise<string> {
  const snapshot = await custody.snapshot()
  if (
    snapshot.pending?.account.receipt.context.recoveryFormat ===
    BIP39_RECOVERY_FORMAT
  ) {
    const seed = await custody.openPendingBip39Seed(attemptId)
    try {
      return MonadIdentity.fromBip39Seed(seed).displayAddress
    } finally {
      seed.fill(0)
    }
  }
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
  createWallet: (
    roots: MonadRootBundle | HistoricalBip39Seed,
  ) => Promise<RuntimeWallet>
  /** Private family construction; material stays inside the custody composition boundary. */
  createEvmWallet?: (
    config: EvmChainConfig,
    material: MonadRootBundle | HistoricalBip39Seed,
  ) => Promise<EvmChainWalletHandle>
  /** Required application restoration finishes before consumers can acquire the wallet. */
  restoreApplicationState?: (options: {
    wallet: RuntimeWallet
    account: PublicAccount
    isCancelled: () => boolean
  }) => Promise<void>
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
    const code =
      error instanceof EvmNativeJournalError && error.code === 'binding'
        ? 'wallet-chain-mismatch'
        : error instanceof CustodyError
        ? error.code
        : 'unavailable'
    state.error = code
    state.status = [
      'unavailable',
      'profile-unreachable',
      'wallet-chain-mismatch',
    ].includes(code)
      ? 'unavailable'
      : 'locked'
  }
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const secondaryEvmWallets = new Set<EvmChainWalletHandle>()
  const revokeUtxoCustody = new Set<() => void>()
  const release = async () => {
    for (const revoke of revokeUtxoCustody) revoke()
    revokeUtxoCustody.clear()
    const secondaryClosing = [...secondaryEvmWallets].map(secondary =>
      secondary.close(),
    )
    secondaryEvmWallets.clear()
    // Refresh can discover a replacement without an explicit invalidation event.
    if (wallet) ++walletGeneration
    chainAddressCache.clear()
    chainAddressInFlight.clear()
    curveKeyCache.clear()
    curveKeyInFlight.clear()
    const previous = wallet
    wallet = undefined
    if (previous) await previous.close()
    await Promise.all(secondaryClosing)
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
    let bip39Seed: Uint8Array | undefined
    let candidate: RuntimeWallet | undefined
    try {
      check(token)
      if (
        capability.account.receipt.context.recoveryFormat ===
        BIP39_RECOVERY_FORMAT
      )
        bip39Seed = capability.takeBip39Seed()
      else roots = capability.takeRoots()
      const find = <P extends DomainRoot['purpose']>(
        purpose: P,
      ): DomainRoot<P> => {
        const root = roots.find(value => value.purpose === purpose)
        if (!root) throw new CustodyError('locked')
        return root as DomainRoot<P>
      }
      candidate = await deps.createWallet(
        bip39Seed
          ? { derivation: BIP39_DERIVATION, seed: bip39Seed }
          : {
              evm: find('evm-wallet'),
              authentication: find('identity-authentication'),
              messaging: find('messaging-encryption'),
            },
      )
      check(token)
      await deps.restoreApplicationState?.({
        wallet: candidate,
        account: capability.account,
        isCancelled: () => closed || token !== generation,
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
      publish(latest)
      state.status = 'ready'
      state.error = null
    } finally {
      roots.forEach(root => root.bytes.fill(0))
      bip39Seed?.fill(0)
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
    /** Opens a configured EVM owner privately, using the same published Frank identity. */
    async createEvmWallet(input: {
      readonly config: EvmChainConfig
      readonly signal?: AbortSignal
      readonly operatorCheckpoint?: {
        readonly blockNumber: number
        readonly blockHash: string
      }
    }): Promise<NativeWalletHandle & { close(): Promise<void> }> {
      const signal = input.signal
      const config = { ...input.config }
      const checkpoint = input.operatorCheckpoint && {
        ...input.operatorCheckpoint,
      }
      const entry = validateEvmWalletConfiguration(config, checkpoint)
      const checkCurrent = captureDerivation()
      const currentWallet = await session.getWallet()
      const publishedIdentity = await session.getCurvePublicKey('secp256k1')
      checkCurrent()
      if (!custody) throw new CustodyError('locked')
      const capability = await custody.openActive()
      let roots: readonly DomainRoot[] = []
      let seed: Uint8Array | undefined
      let candidate: EvmChainWalletHandle | undefined
      let retained = false
      const requireCurrent = () => {
        checkCurrent()
        if (
          signal?.aborted ||
          state.status !== 'ready' ||
          wallet !== currentWallet
        )
          throw new CustodyError('closed')
      }
      const revoke = () => {
        if (candidate) void candidate.close().catch(() => undefined)
      }
      signal?.addEventListener('abort', revoke, { once: true })
      try {
        requireCurrent()
        if (capability.account.receipt.context.accountId !== walletAccount)
          throw new CustodyError('conflict')
        let material: MonadRootBundle | HistoricalBip39Seed
        if (
          capability.account.receipt.context.recoveryFormat ===
          BIP39_RECOVERY_FORMAT
        ) {
          seed = capability.takeBip39Seed()
          material = { derivation: BIP39_DERIVATION, seed }
        } else {
          roots = capability.takeRoots()
          const find = <P extends DomainRoot['purpose']>(
            purpose: P,
          ): DomainRoot<P> => {
            const found = roots.find(
              (root): root is DomainRoot<P> => root.purpose === purpose,
            )
            if (!found) throw new AccountPurposeUnavailableError(purpose)
            return found
          }
          material = {
            evm: find('evm-wallet'),
            authentication: find('identity-authentication'),
            messaging: find('messaging-encryption'),
          }
        }
        candidate = await (deps.createEvmWallet
          ? deps.createEvmWallet(config, material)
          : (createEvmChain(config).createWallet(
              material,
            ) as Promise<EvmChainWalletHandle>))
        const owned = candidate
        const close = owned.close.bind(owned)
        owned.close = async () => {
          secondaryEvmWallets.delete(owned)
          signal?.removeEventListener('abort', revoke)
          await close()
        }
        secondaryEvmWallets.add(candidate)
        requireCurrent()
        if (
          candidate.family !== 'evm' ||
          candidate.chainIdentifier !== entry.id ||
          candidate.identity.compressedPubKey.length !==
            publishedIdentity.length ||
          !candidate.identity.compressedPubKey.every(
            (byte, i) => byte === publishedIdentity[i],
          )
        )
          throw new CustodyError('conflict')
        await verifyEvmWalletRpcIdentity(
          config,
          candidate.provider,
          checkpoint,
          requireCurrent,
        )
        retained = true
        return candidate
      } finally {
        roots.forEach(root => root.bytes.fill(0))
        seed?.fill(0)
        capability.close()
        if (!retained) signal?.removeEventListener('abort', revoke)
        if (candidate && !retained) {
          secondaryEvmWallets.delete(candidate)
          await candidate.close()
        }
      }
    },
    /** Construct a family wallet inside custody; neither root nor identity secret escapes. */
    async createUtxoWallet(relay: RelayUtxoChain): Promise<NativeWalletHandle> {
      const checkCurrent = captureDerivation()
      const currentWallet = await session.getWallet()
      checkCurrent()
      const chainIdentifier = relay.chain.chainIdentifier
      const entry = getChainRegistryEntry(chainIdentifier)
      if (entry?.family !== 'bitcoin' || !entry.wallet)
        throw new Error('Unsupported UTXO chain')
      if (!custody) throw new CustodyError('locked')
      const capability = await custody.openActive()
      let roots: readonly DomainRoot[] = []
      let seed: Uint8Array | undefined
      let identitySecret: Uint8Array | undefined
      let live = true
      const revoke = () => {
        live = false
        identitySecret?.fill(0)
        identitySecret = undefined
      }
      const requireLive = () => {
        checkCurrent()
        relay.assertActive?.()
        if (!live || state.status !== 'ready' || wallet !== currentWallet)
          throw new CustodyError('closed')
      }
      try {
        requireLive()
        if (capability.account.receipt.context.accountId !== walletAccount)
          throw new CustodyError('conflict')
        let material: Uint8Array | HistoricalBip39Seed
        let identity: MonadIdentity | undefined
        if (
          capability.account.receipt.context.recoveryFormat ===
          BIP39_RECOVERY_FORMAT
        ) {
          seed = capability.takeBip39Seed()
          material = { derivation: BIP39_DERIVATION, seed }
          identity = MonadIdentity.fromBip39Seed(seed)
        } else {
          roots = capability.takeRoots()
          const familyRoot = roots.find(r => r.purpose === 'ecash-bch-wallet')
          if (!familyRoot)
            throw new AccountPurposeUnavailableError('ecash-bch-wallet')
          material = familyRoot.bytes
          const authRoot = roots.find(
            (r): r is DomainRoot<'identity-authentication'> =>
              r.purpose === 'identity-authentication',
          )
          if (!authRoot)
            throw new AccountPurposeUnavailableError('identity-authentication')
          identity = MonadIdentity.fromDomainRoot(authRoot)
        }
        let stealthCustody: UtxoStealthCustody | undefined
        let ecashCustody: EcashStealthCustody | undefined
        if (identity) {
          const identityPublicKey = new Uint8Array(identity.compressedPubKey)
          if (
            !identityPublicKey.every(
              (byte, i) => byte === currentWallet.identity.compressedPubKey[i],
            ) ||
            identityPublicKey.length !==
              currentWallet.identity.compressedPubKey.length
          )
            throw new CustodyError('conflict')
          identitySecret = identity.toNakamotoPrivateKey().bytes
          identity = undefined
          // Retain only the session-owned identity scalar. No derived spend secret survives a call.
          revokeUtxoCustody.add(revoke)
          const identityHex = toHex(identityPublicKey)
          ecashCustody = {
            identityPublicKey: identityHex,
            assertActive: requireLive,
            async withDerivedStealthSecret(derivation, importIntoBackend) {
              requireLive()
              if (
                derivation.chainIdentifier !== chainIdentifier ||
                derivation.identityPublicKey !== identityHex
              )
                throw new CustodyError('conflict')
              const ephemeral = ecashStealthPoint(derivation.ephemeralPubKey)
              if (!identitySecret) throw new CustodyError('closed')
              const temporaryIdentity = new Uint8Array(identitySecret)
              let derived: ReturnType<typeof stealthParentSecret> | undefined
              try {
                derived = stealthParentSecret(temporaryIdentity, ephemeral)
                requireLive()
                importIntoBackend(derived.secret)
                requireLive()
              } finally {
                temporaryIdentity.fill(0)
                derived?.secret.fill(0)
                derived?.digest.fill(0)
              }
            },
          }
          stealthCustody = {
            identityPublicKey: new Uint8Array(identityPublicKey),
            async deriveStealthSigner(derivation) {
              requireLive()
              if (
                derivation.chainIdentifier !== chainIdentifier ||
                derivation.identityPublicKey.length !==
                  identityPublicKey.length ||
                !identityPublicKey.every(
                  (byte, i) => byte === derivation.identityPublicKey[i],
                )
              )
                throw new CustodyError('conflict')
              const ephemeralPubKey = requireCompressedStealthPoint(
                derivation.ephemeralPubKey,
              )
              const withKey = <T>(use: (key: PrivateKey) => T): T => {
                requireLive()
                if (!identitySecret) throw new CustodyError('closed')
                const temporaryIdentity = new Uint8Array(identitySecret)
                let secret: Uint8Array | undefined
                try {
                  secret = stealthParentSecret(
                    temporaryIdentity,
                    ephemeralPubKey,
                  ).secret
                  const key = privateKeyFromBytes(secret, true)
                  if (!key.ok) throw new Error('Invalid stealth signing key')
                  try {
                    return use(key.value)
                  } finally {
                    key.value.bytes.fill(0)
                  }
                } finally {
                  temporaryIdentity.fill(0)
                  secret?.fill(0)
                }
              }
              const publicKey = withKey(key => {
                const point = publicFromPrivate(key)
                if (!point.ok) throw new Error('Invalid stealth public key')
                return point.value.compressed
              })
              return {
                publicKey,
                sign(digest) {
                  return withKey(key => {
                    const signature = signEcdsa(key, digest)
                    if (!signature.ok) throw new Error('Stealth signing failed')
                    return signature.value
                  })
                },
              }
            },
          }
        }
        const guardConstruction =
          <P, R>(create: (params: P) => Promise<R>) =>
          async (params: P): Promise<R> => {
            requireLive()
            const result = await create(params)
            requireLive()
            return result
          }
        const result = await relay.createWallet(
          material,
          entry.wallet.indexer === 'chronik' && ecashCustody
            ? {
                ecashWalletFactory: guardConstruction(
                  createEcashStealthSeedBackend(ecashCustody),
                ),
                ecashBip39WalletFactory: guardConstruction(
                  createEcashStealthBip39SeedBackend(ecashCustody),
                ),
              }
            : stealthCustody
            ? { stealthCustody }
            : undefined,
        )
        requireLive()
        return result
      } catch (error) {
        revoke()
        revokeUtxoCustody.delete(revoke)
        throw error
      } finally {
        roots.forEach(root => root.bytes.fill(0))
        seed?.fill(0)
        capability.close()
      }
    },
    async getActiveFamilyMaterial<P extends DomainRoot['purpose']>(
      purpose: P,
    ): Promise<DomainRoot<P> | HistoricalBip39Seed> {
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
        if (
          capability.account.receipt.context.recoveryFormat ===
          BIP39_RECOVERY_FORMAT
        )
          return {
            derivation: BIP39_DERIVATION,
            seed: capability.takeBip39Seed(),
          }
        roots = capability.takeRoots()
        const found = roots.find(r => r.purpose === purpose)
        if (!found) throw new AccountPurposeUnavailableError(purpose)
        return { ...found, purpose, bytes: new Uint8Array(found.bytes) }
      } finally {
        roots.forEach(r => r.bytes.fill(0))
        capability.close()
      }
    },
    async getActiveDomainRoot<P extends DomainRoot['purpose']>(
      purpose: P,
    ): Promise<Uint8Array> {
      const material = await session.getActiveFamilyMaterial(purpose)
      if ('seed' in material) {
        material.seed.fill(0)
        throw new AccountPurposeUnavailableError(purpose)
      }
      return material.bytes
    },
    async getSolanaSigner() {
      const checkCurrent = captureDerivation()
      const material = await session.getActiveFamilyMaterial('solana-wallet')
      try {
        if ('seed' in material) {
          const { SolanaHdKeyring } = await import(
            '@frank/wallet/ed25519-hd-keyring'
          )
          const account = await SolanaHdKeyring.fromSeed(
            material.seed,
          ).deriveSubAccount(0)
          const { Keypair } = await import('@solana/web3.js')
          try {
            const signer = await Keypair.fromSeed(account.privateKeyBytes)
            checkCurrent()
            return signer
          } finally {
            account.privateKeyBytes.fill(0)
          }
        }
        const { Keypair } = await import('@solana/web3.js')
        const signer = await Keypair.fromSeed(material.bytes)
        checkCurrent()
        return signer
      } finally {
        if ('seed' in material) material.seed.fill(0)
        else material.bytes.fill(0)
      }
    },
    getCachedChainAddress(chain: string): string | undefined {
      const isTestnet = activeChain.isTestnet ?? false
      const netId =
        chain === 'monad'
          ? activeChain.chainIdentifier
          : resolveNetworkId(chain, isTestnet)
      if (getChainRegistryEntry(netId)?.kind === 'monad') {
        // Only a completed receive-address read can seed this cache. The profile
        // identity is a different account, and another network's entry is not usable.
        return chainAddressCache.get(netId)
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
      const netId =
        chain === 'monad'
          ? activeChain.chainIdentifier
          : resolveNetworkId(chain, fallbackTestnet)
      const entry = getChainRegistryEntry(netId)
      if (!entry) throw new AccountAddressUnavailableError('unknown-network')
      const isTestnet = entry.isTestnet
      if (entry.kind === 'monad') {
        // A ready runtime already owns this local address. Reopening runtime stores and
        // restoring a relay profile is not part of formatting a receive address.
        if (state.status !== 'ready') await session.initialize()
        checkCurrent()
        if (
          state.status !== 'ready' ||
          !wallet ||
          state.account?.receipt.context.accountId !== walletAccount ||
          state.revision !== walletRevision
        )
          throw new CustodyError('locked')
        if (wallet.chainIdentifier !== netId)
          throw new AccountAddressUnavailableError('network-mismatch')
        const owner = wallet
        const address = await owner.getReceiveAddress()
        checkCurrent()
        if (
          state.status !== 'ready' ||
          wallet !== owner ||
          state.account?.receipt.context.accountId !== walletAccount ||
          state.revision !== walletRevision
        )
          throw new CustodyError('closed')
        if (chain === 'monad' && activeChain.chainIdentifier !== netId)
          throw new AccountAddressUnavailableError('network-mismatch')
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
        if (entry?.family === 'solana')
          return (await session.getSolanaSigner()).publicKey.toBase58()
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
        const material = await session.getActiveFamilyMaterial(purpose)
        const root = 'seed' in material ? material.seed : material.bytes
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
          } else {
            const { HDNodeWallet } = await import('ethers')
            // The wallet's receive address; m/44'/60'/0'/0/0 is stamp-pool account 0.
            const hdNode =
              HDNodeWallet.fromSeed(root).derivePath("m/44'/60'/1'/0/0")
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
          const kp = await session.getSolanaSigner()
          return new Uint8Array(kp.publicKey.toBytes())
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
     * split from the retained original account secret and preserve its derivation:
     * the same identity, keys, and addresses.
     */
    async backupCodex32(threshold: number, count: number): Promise<string[]> {
      const checkCurrent = captureDerivation()
      await session.initialize()
      checkCurrent()
      if (!custody || closed || state.status !== 'ready')
        throw new CustodyError('locked')
      if (
        state.account?.receipt.context.recoveryFormat === BIP39_RECOVERY_FORMAT
      ) {
        const capability = await custody.openActive()
        let seed: Uint8Array | undefined
        try {
          checkCurrent()
          if (capability.account.receipt.context.accountId !== walletAccount)
            throw new CustodyError('conflict')
          seed = capability.takeBip39Seed()
          return [
            ...exportHistoricalCodex32Backup({
              seed,
              threshold: threshold as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
              shareCount: count,
              randomBytes: length =>
                crypto.getRandomValues(new Uint8Array(length)),
            }),
          ]
        } finally {
          seed?.fill(0)
          capability.close()
        }
      }
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
            threshold: threshold as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
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
    async stage(input: StageAccount | StageBip39Account) {
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
    // Electron uses the same isolated-renderer IndexedDB/WebCrypto custody,
    // verified with packaged process-crash and reopen tests. Mobile webviews
    // have not passed these capability checks.
    if (Platform.is.capacitor || Platform.is.cordova)
      return Promise.reject(new CustodyError('unavailable'))
    return openAccountCustody({ namespace: 'local-account-v1' })
  },
  createWallet: roots => activeChain.createWallet(roots),
  async restoreApplicationState({ wallet, account, isCancelled }) {
    if (account.displayName) return
    const { restoreOwnProfileWithRelay } = await import('../utils/own-profile')
    const outcome = await restoreOwnProfileWithRelay({
      identity: wallet.identity as MonadIdentity,
      relayBaseUrl: getCustomRelayBaseUrl() ?? getDefaultRelayBaseUrl(),
      isCancelled,
    })
    if (outcome === 'unreachable') throw new CustodyError('profile-unreachable')
  },
})
export const accountStatus = accountSession.state

/** Stage historical Frank recovery; activation remains a separate explicit user action. */
export async function stageBip39Recovery(
  session: ReturnType<typeof createAccountSession>,
  phrase: string,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  if (typeof phrase !== 'string' || phrase.length > 512)
    throw new CustodyError('invalid-input')
  const expectedActive = {
    revision: session.state.revision,
    accountId: session.state.account?.receipt.context.accountId ?? null,
  }
  const { legacyStatus, assertLegacyUnchanged } = await import('./legacy')
  const legacyRevision = legacyStatus.revision
  const { validateMnemonic, mnemonicToSeedSync } = await import('bip39')
  const normalized = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!validateMnemonic(normalized)) throw new CustodyError('invalid-input')
  const seed = mnemonicToSeedSync(normalized)
  const attemptId = crypto.randomUUID()
  try {
    const snapshot = await session.snapshot()
    if (
      snapshot.pending ||
      snapshot.revision !== expectedActive.revision ||
      (snapshot.active?.receipt.context.accountId ?? null) !==
        expectedActive.accountId
    )
      throw new CustodyError('conflict')
    await assertLegacyUnchanged(legacyRevision)
    if (isCancelled()) throw new CustodyError('conflict')
    await session.stage({
      attemptId,
      accountId: crypto.randomUUID(),
      expectedActive,
      displayName: '',
      custodyEpoch: 1,
      bip39Seed: seed,
    })
    if (isCancelled()) {
      await session.cancelPending(attemptId)
      throw new CustodyError('conflict')
    }
  } finally {
    seed.fill(0)
  }
}

export async function importBip39Wallet(
  phrase: string,
  chosenPath = "m/44'/60'/1'/0/0",
  isCancelled?: () => boolean,
): Promise<void> {
  if (chosenPath !== "m/44'/60'/1'/0/0") throw new CustodyError('invalid-input')
  await stageBip39Recovery(accountSession, phrase, isCancelled)
}
