import type { Ed25519Node } from '@frank/wallet/ed25519-hd-keyring'
import type { ExperimentalCustody } from '@frank/wallet/solana-crypto-backend/runtime.mjs'
import {
  validateEvmWalletConfiguration,
  verifyEvmWalletRpcIdentity,
} from './evm-wallet-verification'
import { reactive, readonly } from 'vue'
import { HDNodeWallet, getAddress } from 'ethers'
import { bip32MasterFromDomainRoot } from '@frank/wallet/bip32-domain-root'
import { MONAD_IDENTITY_DERIVATION_PATH } from '@frank/wallet/evm-identity'
import type { TempoPathUsdSigner } from '@frank/wallet/chain/tempo-pathusd-operation'
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
  createChainAdapter,
  isCanonicalChainId,
  resolveChainAdapter,
} from '@frank/wallet/chain'
import type { MonadRootBundle } from '@frank/wallet/chain/active-chain'
import type { HistoricalBip39Seed } from '@frank/wallet/evm-wallet-material'
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
import { MonadIdentity } from '@frank/wallet/evm-identity'
import { Platform } from 'quasar'
import type { DomainRoot } from '@frank/domain-roots'
import {
  decodeRecoveryDescriptor,
  exportCodex32Backup,
  exportHistoricalCodex32Backup,
} from '@frank/account-recovery'
import { isAccountBackedUp, markAccountBackedUp } from './backup-status'
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
/** Optional app authentication capability; chain-neutral identity does not promise it. */
function readIdentityPublicKey(
  identity: NativeWalletHandle['identity'],
): Uint8Array | undefined {
  if (!('compressedPubKey' in identity)) return undefined
  const key = identity.compressedPubKey
  if (
    !(key instanceof Uint8Array) ||
    key.length !== 33 ||
    (key[0] !== 2 && key[0] !== 3)
  )
    return undefined
  return Uint8Array.from(key)
}

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
  backedUp: boolean
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
  /** Private closed-WASM construction seam; the production default is the packaged runtime. */
  openSolanaPaymentCustody?: typeof import('@frank/wallet/solana-crypto-backend/runtime.mjs').openExperimentalRecipientCustody
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
    backedUp: false,
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
    const accountId = snapshot.active?.receipt.context.accountId
    state.backedUp = isAccountBackedUp(accountId)
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
  const solanaPaymentCustody = new Set<ExperimentalCustody>()
  const revokeUtxoCustody = new Set<() => void>()
  const release = async () => {
    for (const child of solanaPaymentCustody) child.close()
    solanaPaymentCustody.clear()
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
    /** Ingests the existing Solana seed into closed WASM custody on explicit request only. */
    async createSolanaPaymentCustody(input: {
      readonly chainIdentifier: string
      readonly wasm: URL | string
      readonly signal?: AbortSignal
    }): Promise<ExperimentalCustody> {
      const { chainIdentifier, wasm, signal } = input
      const entry = getChainRegistryEntry(chainIdentifier)
      if (!entry || entry.family !== 'solana' || !entry.wallet)
        throw new Error('Unsupported canonical Solana custody network')
      const currentWallet = wallet
      if (state.status !== 'ready' || !currentWallet)
        throw new CustodyError('locked')
      const checkCurrent = captureDerivation()
      const requireCurrent = () => {
        checkCurrent()
        if (
          signal?.aborted ||
          state.status !== 'ready' ||
          wallet !== currentWallet
        )
          throw new CustodyError('closed')
      }
      requireCurrent()
      const published = new Uint8Array(
        await session.getCurvePublicKey('ed25519'),
      )
      requireCurrent()
      if (published.length !== 32) throw new CustodyError('conflict')
      const open =
        deps.openSolanaPaymentCustody ??
        (await import('@frank/wallet/solana-crypto-backend/runtime.mjs'))
          .openExperimentalRecipientCustody
      requireCurrent()
      const material = await session.getActiveFamilyMaterial('solana-wallet')
      let masterNode: Ed25519Node | undefined
      let leafNode: Ed25519Node | undefined
      let handoff: Uint8Array | undefined
      let candidate: ExperimentalCustody | undefined
      let retained = false
      let childClosed = false
      let child: ExperimentalCustody | undefined
      const wipeMaterial = () => {
        if ('seed' in material) material.seed.fill(0)
        else material.bytes.fill(0)
        masterNode?.key.fill(0)
        masterNode?.chainCode.fill(0)
        leafNode?.key.fill(0)
        leafNode?.chainCode.fill(0)
        handoff?.fill(0)
      }
      const revoke = () => {
        if (childClosed) return
        childClosed = true
        signal?.removeEventListener('abort', revoke)
        if (child) solanaPaymentCustody.delete(child)
        candidate?.close()
      }
      signal?.addEventListener('abort', revoke, { once: true })
      try {
        requireCurrent()
        if ('seed' in material) {
          const { SolanaHdKeyring } = await import(
            '@frank/wallet/ed25519-hd-keyring'
          )
          const keyring = SolanaHdKeyring.fromSeed(material.seed)
          masterNode = keyring.masterNode
          leafNode = keyring.deriveNode(keyring.subAccountPath(0)).node
        }
        requireCurrent()
        const seedBytes =
          leafNode?.key ?? ('seed' in material ? undefined : material.bytes)
        if (!seedBytes || seedBytes.length !== 32)
          throw new CustodyError('conflict')
        handoff = new Uint8Array(seedBytes)
        requireCurrent()
        // Public handle label only: this changes neither derivation nor application account ID.
        const opening = open({
          accountId: new Uint8Array(published),
          chainIdentifier,
          seed: handoff,
          wasm,
          signal,
        })
        // The opener consumes the handoff synchronously; no seed waits on WASM initialization.
        wipeMaterial()
        candidate = await opening
        requireCurrent()
        const actual = candidate.primaryPublicKey()
        if (
          actual.length !== published.length ||
          !actual.every((byte, index) => byte === published[index])
        )
          throw new CustodyError('conflict')
        const live = () => {
          requireCurrent()
          if (childClosed) throw new CustodyError('closed')
        }
        const owned = candidate
        child = Object.freeze<ExperimentalCustody>({
          primaryPublicKey() {
            live()
            return owned.primaryPublicKey()
          },
          deriveDestination(intent) {
            live()
            return owned.deriveDestination(intent)
          },
          validateReceivedDescriptor(received) {
            live()
            return owned.validateReceivedDescriptor(received)
          },
          signReceivedTransfer(received, descriptor, spend, authorization) {
            live()
            return owned.signReceivedTransfer(
              received,
              descriptor,
              spend,
              authorization,
            )
          },
          signPrimaryTransfer(descriptor, spend, authorization) {
            live()
            return owned.signPrimaryTransfer(descriptor, spend, authorization)
          },
          close: revoke,
        })
        solanaPaymentCustody.add(child)
        requireCurrent()
        retained = true
        return child
      } finally {
        wipeMaterial()
        if (!retained) {
          if (childClosed) candidate?.close()
          else revoke()
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
          const runtimePublicKey = readIdentityPublicKey(currentWallet.identity)
          if (
            !runtimePublicKey ||
            !identityPublicKey.every((byte, i) => byte === runtimePublicKey[i])
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
            assertActive: requireLive,
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
          <P, R>(create: (params: P) => R | Promise<R>) =>
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
    /** Session-bound ordinary identity signatures; no custody material crosses this capability. */
    async createIdentityDigestSigner() {
      const checkCurrent = captureDerivation()
      const owner = await session.getWallet()
      checkCurrent()
      const accountId = state.account?.receipt.context.accountId
      const revision = state.revision
      const chainIdentifier = activeChain.chainIdentifier
      const publicKey = readIdentityPublicKey(owner.identity)
      if (!accountId || !publicKey) throw new CustodyError('locked')
      const assertCurrent = () => {
        checkCurrent()
        if (
          state.status !== 'ready' ||
          wallet !== owner ||
          state.revision !== revision ||
          state.account?.receipt.context.accountId !== accountId ||
          activeChain.chainIdentifier !== chainIdentifier ||
          owner.chainIdentifier !== chainIdentifier
        )
          throw new CustodyError('closed')
      }
      assertCurrent()
      return {
        accountId,
        revision,
        chainIdentifier,
        publicKey: new Uint8Array(publicKey),
        assertCurrent,
        async signDigest(digest: Uint8Array): Promise<Uint8Array> {
          assertCurrent()
          if (!(digest instanceof Uint8Array) || digest.length !== 32)
            throw new Error('Invalid identity digest')
          const copied = new Uint8Array(digest)
          const material = await session.getActiveFamilyMaterial(
            'identity-authentication',
          )
          try {
            assertCurrent()
            const identity =
              'seed' in material
                ? MonadIdentity.fromBip39Seed(material.seed)
                : MonadIdentity.fromDomainRoot(material)
            if (toHex(identity.compressedPubKey) !== toHex(publicKey))
              throw new CustodyError('conflict')
            const key = identity.toNakamotoPrivateKey()
            try {
              const signed = signEcdsa(key, copied)
              if (!signed.ok) throw new Error('Identity signing failed')
              assertCurrent()
              return new Uint8Array(signed.value)
            } finally {
              key.bytes.fill(0)
            }
          } finally {
            copied.fill(0)
            if ('seed' in material) material.seed.fill(0)
            else material.bytes.fill(0)
          }
        },
      }
    },
    /** A revocable Tempo signing capability; no private material survives a signing call. */
    async createTempoMainAccountSigner(
      chainIdentifier: 'tempo-testnet' | 'tempo-mainnet',
    ): Promise<TempoPathUsdSigner> {
      const entry = getChainRegistryEntry(chainIdentifier)
      if (entry?.kind !== 'tempo')
        throw new Error(`Tempo wallet unavailable for ${chainIdentifier}`)
      const checkCurrent = captureDerivation()
      const owner = await session.getWallet()
      checkCurrent()
      const requireCurrent = () => {
        checkCurrent()
        if (state.status !== 'ready' || wallet !== owner)
          throw new CustodyError('closed')
      }
      const derive = async () => {
        requireCurrent()
        const material = await session.getActiveFamilyMaterial('evm-wallet')
        try {
          requireCurrent()
          const master =
            'seed' in material
              ? HDNodeWallet.fromSeed(material.seed)
              : bip32MasterFromDomainRoot(material, 'evm-wallet')
          const node = master.derivePath(MONAD_IDENTITY_DERIVATION_PATH)
          requireCurrent()
          return node
        } finally {
          if ('seed' in material) material.seed.fill(0)
          else material.bytes.fill(0)
        }
      }
      const address = getAddress((await derive()).address).toLowerCase()
      requireCurrent()
      return {
        source: { kind: 'main', address },
        async signDigest(digest: string) {
          if (!/^0x[0-9a-f]{64}$/i.test(digest))
            throw new Error('Invalid Tempo signing digest')
          const node = await derive()
          if (getAddress(node.address).toLowerCase() !== address)
            throw new CustodyError('conflict')
          requireCurrent()
          const signature = node.signingKey.sign(digest)
          requireCurrent()
          return {
            r: signature.r,
            s: signature.s,
            yParity: signature.yParity as 0 | 1,
          }
        },
      }
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
      const entry = getChainRegistryEntry(netId)
      if (entry?.kind === 'monad' || entry?.family !== 'evm') {
        // Only a completed receive-address read can seed this cache. The profile
        // identity is a different account, and another network's entry is not usable.
        return chainAddressCache.get(netId)
      }
      return (
        chainAddressCache.get(netId) ??
        chainAddressCache.get(chain) ??
        (wallet?.identity?.displayAddress
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
          entry?.family === 'bitcoin' ? 'ecash-bch-wallet' : 'evm-wallet'
        const material = await session.getActiveFamilyMaterial(purpose)
        const root = 'seed' in material ? material.seed : material.bytes
        try {
          const adapter = resolveChainAdapter(netId)
          if (adapter) {
            const accountIndex = entry?.family === 'evm' ? 1 : 0
            const chainWallet = await adapter.createWallet({
              root: { seed: root },
              accountIndex,
            })
            return chainWallet.address
          }
          const { HDNodeWallet } = await import('ethers')
          // The wallet's receive address; m/44'/60'/0'/0/0 is stamp-pool account 0.
          const hdNode =
            HDNodeWallet.fromSeed(root).derivePath("m/44'/60'/1'/0/0")
          return hdNode.address
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
    /** Existing ready owner only; never initializes custody or performs network work. */
    peekWallet(): RuntimeWallet | undefined {
      return state.status === 'ready' ? wallet : undefined
    },
    getCachedCurvePublicKey(curve: SupportedCurve): Uint8Array | undefined {
      if (curve === 'secp256k1') {
        const cached = curveKeyCache.get('secp256k1')
        if (cached) return Uint8Array.from(cached)
        const key = wallet && readIdentityPublicKey(wallet.identity)
        if (!key) return undefined
        curveKeyCache.set('secp256k1', key)
        return Uint8Array.from(key)
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
        const key = readIdentityPublicKey(currentWallet.identity)
        if (!key) {
          throw new Error(
            'No identity compressedPubKey available for secp256k1',
          )
        }
        curveKeyCache.set('secp256k1', key)
        return Uint8Array.from(key)
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
        const shares = [
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
        markAccountBackedUp(walletAccount)
        state.backedUp = true
        return shares
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

import {
  clearAllWalletDatabases,
  listAllocatedWalletDatabases,
} from '@frank/wallet/storage/wallet-storage-adapter'

export async function resetAccountStorage(
  namespace = 'local-account-v1',
): Promise<void> {
  const allocatedWalletDbs = await listAllocatedWalletDatabases().catch(
    () => [],
  )
  await clearAllWalletDatabases().catch(() => undefined)
  if (typeof indexedDB === 'undefined') return
  const names = new Set<string>([
    `frank-account-custody-${namespace}`,
    `frank-preview-vault-${namespace}`,
    ...allocatedWalletDbs,
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

export async function resetMessageAndChatStorage(
  _namespace = 'local-account-v1',
): Promise<void> {
  const allocatedWalletDbs = await listAllocatedWalletDatabases().catch(
    () => [],
  )
  await clearAllWalletDatabases().catch(() => undefined)
  if (typeof indexedDB === 'undefined') return
  const names = new Set<string>(allocatedWalletDbs)
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (
          db.name &&
          (db.name.includes('level-js') ||
            db.name.includes('MessageStore') ||
            db.name.includes('vuex-store') ||
            db.name.includes('monad-wallet-state') ||
            db.name.startsWith('frank-wallet-'))
        ) {
          names.add(db.name)
        }
      }
    } else {
      names.add('vuex-store')
      names.add('MessageStore')
      names.add('monad-wallet-state')
    }
  } catch {
    names.add('vuex-store')
    names.add('MessageStore')
    names.add('monad-wallet-state')
  }
  for (const name of names) {
    if (
      name.startsWith('frank-account-custody-') ||
      name.startsWith('frank-preview-vault-')
    ) {
      continue
    }
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
