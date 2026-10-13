import {
  AccountRecoveryError,
  beginCodex32Signup,
  recoverAccountBackupShares,
  decodeRecoveryDescriptor,
  encodeRecoveryDescriptor,
  destroyRecoveredBackup,
  randomCodex32Identifier,
  deriveRecoveryPublicMetadata,
  type AccountDomainRoots,
  type PendingCodex32Signup,
  type PublicRecoveryDescriptor,
  type RecoveredAccountBackup,
} from '@frank/account-recovery'
import { createMasterPayload } from '@frank/codex32'
import {
  DOMAIN_PURPOSES,
  deriveDomainRoot,
  type DomainRoot,
} from '@frank/domain-roots'
import { getMeraAccountRoot, type MeraAccountAction } from './mera-passkey'
import {
  activeChain,
  onActiveChainChange,
  getDefaultRelayBaseUrl,
  getCustomRelayBaseUrl,
} from '@frank/wallet/chain'
import { requireValidProfileDisplayName } from '@frank/wallet/profile-display-name'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import {
  verifyMeraLoginProfile,
  type MeraLoginVerification,
} from './mera-login-proof'
import { toHex } from '@frank/codec'
import { probeDirectoryRelay } from '@frank/cashweb/relay'
import { accountSession } from './session'
import { assertLegacyUnchanged, legacyStatus } from './legacy'
import type { ExpectedActive } from './custody'
import { bip39Descriptor } from './custody/bip39'
import { markAccountBackedUp } from './backup-status'

function identityOf(account: RecoveredAccountBackup): MonadIdentity {
  return 'seed' in account
    ? MonadIdentity.fromBip39Seed(account.seed)
    : MonadIdentity.fromDomainRoot(account.roots['identity-authentication'])
}

/** Non-reactive transient owner. Components hold only currently displayed/input strings. */
export function createAccountCeremony() {
  let signup: PendingCodex32Signup | undefined
  let restoring = false
  let expectedDescriptor: PublicRecoveryDescriptor | undefined
  let attempt:
    | {
        attemptId: string
        accountId: string
        expectedActive: ExpectedActive
        legacyRevision: number
      }
    | undefined
  let epoch = 0
  /** Accounts awaiting the user's explicit pick; wiped on choose or cancel. */
  let choice: RecoveredAccountBackup[] | undefined
  const cancel = () => {
    ++epoch
    choice?.forEach(destroyRecoveredBackup)
    choice = undefined
    signup?.cancel()
    restoring = false
    expectedDescriptor = undefined
    signup = undefined
    attempt = undefined
  }
  async function capture() {
    const token = ++epoch
    const expected = {
      revision: accountSession.state.revision,
      accountId:
        accountSession.state.account?.receipt.context.accountId ?? null,
    }
    const legacyRevision = legacyStatus.revision
    const snapshot = await accountSession.snapshot()
    if (token !== epoch) throw new Error('Ceremony cancelled')
    if (
      snapshot.revision !== expected.revision ||
      (snapshot.active?.receipt.context.accountId ?? null) !==
        expected.accountId
    )
      throw new Error('Existing account changed; review it again')
    if (snapshot.pending) throw new Error('Resolve the pending account first')
    attempt = {
      attemptId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      expectedActive: expected,
      legacyRevision,
    }
  }
  async function finish(
    take: () => RecoveredAccountBackup | undefined,
    isRestore: boolean,
    displayName: string,
    isCurrent: () => boolean = () => true,
    verifyLogin = false,
  ) {
    if (!attempt) throw new Error('Start an account ceremony first')
    const captured = attempt
    const token = epoch
    let recovered: RecoveredAccountBackup | undefined
    try {
      recovered = take()
      if (!recovered) throw new Error('Start an account ceremony first')
      let loginVerification: MeraLoginVerification = 'unverified'
      let discoveredRelayUrl: string | undefined
      let identityDetails: { subject: string; address: string } | undefined
      if (isRestore) {
        try {
          const identity = identityOf(recovered)
          const subject = toHex(identity.compressedPubKey)
          const address = identity.displayAddress
          identityDetails = { subject, address }
          discoveredRelayUrl = await probeDirectoryRelay({ subject, address })
        } catch {
          // probe failure should never block account recovery
        }
      }
      if (verifyLogin) {
        if (discoveredRelayUrl) loginVerification = 'existing'
        else {
          // Read only: adopting a profile before activation could overwrite another account.
          loginVerification = await verifyMeraLoginProfile(
            getCustomRelayBaseUrl() ?? getDefaultRelayBaseUrl(),
            identityOf(recovered).address.raw,
          )
        }
      }
      await assertLegacyUnchanged(captured.legacyRevision)
      if (token !== epoch || !isCurrent()) throw new Error('Ceremony cancelled')
      // Preserve the exact secret and its original derivation through the common stage boundary.
      const context = { ...captured, displayName, custodyEpoch: 1 }
      await accountSession.stage(
        'seed' in recovered
          ? { ...context, bip39Seed: recovered.seed }
          : {
              ...context,
              metadata: recovered.metadata,
              accountRoot: recovered.accountRoot,
            },
      )
      if (token !== epoch || !isCurrent())
        await accountSession.cancelPending(captured.attemptId)
      if (isRestore) {
        markAccountBackedUp(captured.accountId)
      }
      return {
        isRestore,
        attemptId: captured.attemptId,
        loginVerification,
        subject: identityDetails?.subject,
        address: identityDetails?.address,
        discoveredRelayUrl,
      }
    } catch (error) {
      // A mismatch/failure consumes this presentation ceremony; retry starts explicitly.
      cancel()
      throw error
    } finally {
      if (recovered) destroyRecoveredBackup(recovered)
    }
  }
  return {
    cancel,
    /** Passkeys stage the same root32 account as backup recovery; composition owns activation. */
    async beginPasskey(
      action: MeraAccountAction,
      readRoot: (
        action: MeraAccountAction,
      ) => Promise<Uint8Array> = getMeraAccountRoot,
    ) {
      cancel()
      const chainIdentifier = activeChain.chainIdentifier
      let chainChanged = false
      const unlisten = onActiveChainChange(() => {
        chainChanged = true
      })
      let root: Uint8Array | undefined
      let master: Uint8Array | undefined
      const derived: DomainRoot[] = []
      try {
        await capture()
        const token = epoch
        root = await readRoot(action)
        if (
          token !== epoch ||
          chainChanged ||
          chainIdentifier !== activeChain.chainIdentifier
        )
          throw new Error('Ceremony cancelled')
        const payload = createMasterPayload(root)
        if (!payload.ok) throw new Error('Invalid account root')
        master = payload.value
        const metadata = deriveRecoveryPublicMetadata(master)
        for (const purpose of DOMAIN_PURPOSES)
          derived.push(deriveDomainRoot(root, purpose))
        const recovered = {
          accountRoot: root,
          metadata,
          roots: Object.freeze(
            Object.fromEntries(derived.map(value => [value.purpose, value])),
          ) as AccountDomainRoots,
        }
        const outcome = await finish(
          () => recovered,
          action === 'login',
          '',
          () =>
            !chainChanged && chainIdentifier === activeChain.chainIdentifier,
          action === 'login',
        )
        if (token !== epoch || chainChanged)
          throw new Error('Ceremony cancelled')
        return outcome
      } catch (error) {
        cancel()
        throw error
      } finally {
        unlisten()
        root?.fill(0)
        master?.fill(0)
        derived.forEach(value => value.bytes.fill(0))
      }
    },
    /**
     * Create and stage a new account directly without requiring an upfront backup ceremony.
     * The account can be backed up at any time later from Settings > Backup account.
     */
    async createDirect(displayName = '') {
      cancel()
      const chainIdentifier = activeChain.chainIdentifier
      let chainChanged = false
      const unlisten = onActiveChainChange(() => {
        chainChanged = true
      })
      const randomBuffers: Uint8Array[] = []
      const randomBytes = (length: number) => {
        const bytes = crypto.getRandomValues(new Uint8Array(length))
        randomBuffers.push(bytes)
        return bytes
      }
      let root: Uint8Array | undefined
      let master: Uint8Array | undefined
      const derived: DomainRoot[] = []
      try {
        await capture()
        const token = epoch
        root = randomBytes(32)
        const payload = createMasterPayload(root)
        if (!payload.ok) throw new Error('Invalid account root')
        master = payload.value
        const metadata = deriveRecoveryPublicMetadata(master)
        for (const purpose of DOMAIN_PURPOSES)
          derived.push(deriveDomainRoot(root, purpose))
        const recovered = {
          accountRoot: root,
          metadata,
          roots: Object.freeze(
            Object.fromEntries(derived.map(value => [value.purpose, value])),
          ) as AccountDomainRoots,
        }
        const outcome = await finish(
          () => recovered,
          false,
          displayName,
          () =>
            !chainChanged && chainIdentifier === activeChain.chainIdentifier,
        )
        if (token !== epoch || chainChanged)
          throw new Error('Ceremony cancelled')
        return outcome
      } finally {
        unlisten()
        randomBuffers.forEach(bytes => bytes.fill(0))
        root?.fill(0)
        master?.fill(0)
        derived.forEach(value => value.bytes.fill(0))
      }
    },
    async beginNew(threshold: 2 | 3, count: 3 | 5) {
      cancel()
      await capture()
      if (
        !((threshold === 2 && count === 3) || (threshold === 3 && count === 5))
      )
        throw new Error('Select a backup policy')
      const randomBuffers: Uint8Array[] = []
      const randomBytes = (length: number) => {
        const bytes = crypto.getRandomValues(new Uint8Array(length))
        randomBuffers.push(bytes)
        return bytes
      }
      try {
        signup = beginCodex32Signup({
          threshold,
          // Each share set names itself, so sets from different backups are not combined.
          identifier: randomCodex32Identifier(randomBytes),
          indices: ['q', 'p', 'z', 'r', 'y'].slice(0, count),
          randomBytes,
        })
      } finally {
        randomBuffers.forEach(bytes => bytes.fill(0))
      }
      return encodeRecoveryDescriptor(signup.publicDescriptor)
    },
    share(index: number) {
      return signup?.shares[index] ?? ''
    },
    async beginRestore(text?: string) {
      cancel()
      // Pin the independent descriptor before accepting any shares if provided.
      const descriptor = text ? decodeRecoveryDescriptor(text) : undefined
      await capture()
      expectedDescriptor = descriptor
      restoring = true
      return descriptor ? encodeRecoveryDescriptor(descriptor) : ''
    },
    /**
     * Verify the entered shares and stage the account they reconstruct.
     *
     * Restore accepts the threshold number of shares or more and reports what each share
     * turned out to be. If the shares contain complete backups of more than one account,
     * nothing is staged: the candidates come back with their identity addresses and the
     * user picks one explicitly through `choose`. This never picks for them.
     */
    async confirm(shares: readonly string[], name: string) {
      // A name is profile presentation, never a prerequisite for recovering the account root.
      const displayName = signup ? requireValidProfileDisplayName(name) : ''
      if (!attempt) throw new Error('Start an account ceremony first')
      if (signup) {
        const recovered = signup.confirmWithMetadata(shares)
        const outcome = await finish(() => recovered, false, displayName)
        signup = undefined
        return outcome
      }
      if (!restoring) throw new Error('Start an account ceremony first')
      let recovery: ReturnType<typeof recoverAccountBackupShares>
      try {
        recovery = recoverAccountBackupShares(shares, expectedDescriptor)
      } catch (error) {
        if (
          expectedDescriptor &&
          (error as AccountRecoveryError)?.code === 'descriptor-mismatch'
        ) {
          cancel()
        }
        throw error
      }
      if (recovery.candidates.length > 1) {
        restoring = false
        expectedDescriptor = undefined
        choice = recovery.candidates.map(candidate => candidate.account)
        return {
          isRestore: true,
          report: recovery.shares,
          insufficientSets: recovery.insufficientSets,
          candidates: recovery.candidates.map(candidate => ({
            address: identityOf(candidate.account).displayAddress,
            descriptor:
              'seed' in candidate.account
                ? bip39Descriptor(candidate.account.seed).descriptor
                : encodeRecoveryDescriptor(
                    candidate.account.metadata.descriptor,
                  ),
            supporting: candidate.supporting,
          })),
        }
      }
      const outcome = await finish(
        () => recovery.candidates[0]?.account,
        true,
        displayName,
      )
      restoring = false
      expectedDescriptor = undefined
      return {
        ...outcome,
        report: recovery.shares,
        insufficientSets: recovery.insufficientSets,
      }
    },
    /** Stage the candidate the user picked after `confirm` returned several. */
    async choose(index: number, _name?: string) {
      const candidates = choice
      choice = undefined
      const chosen = candidates?.[index]
      candidates?.forEach(candidate => {
        if (candidate !== chosen) destroyRecoveredBackup(candidate)
      })
      if (!chosen) {
        cancel()
        throw new Error('Start an account ceremony first')
      }
      return finish(() => chosen, true, '')
    },
  }
}

export function recoveryErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code
  if (error instanceof AccountRecoveryError && error.insufficientSets?.length) {
    const explanation =
      code === 'inconsistent-share'
        ? 'These shares come from different backup sets and cannot be combined. '
        : ''
    return (
      explanation +
      error.insufficientSets
        .map(
          set =>
            `Backup ${set.identifier}: ${set.available} distinct shares available; ${set.required} required.`,
        )
        .join(' ')
    )
  }
  const messages: Record<string, string> = {
    'descriptor-mismatch':
      'These shares belong to a different account. Start again with your independently saved descriptor.',
    'confirmation-mismatch':
      'These shares do not reconstruct the account you just backed up. Start again.',
    'not-account-backup':
      'These shares do not reconstruct a Frank account, so nothing was restored. At least one share is wrong, or they are not an account backup. Enter one more share from the same backup and the app can identify which share is wrong.',
    'duplicate-share': 'Each backup share must have a different index.',
    'wrong-share-count': 'Enter exactly the required number of backup shares.',
    'inconsistent-share':
      'These shares come from different backup sets and cannot be combined. Start again with shares from one set.',
    'wrong-ceremony-family':
      'These shares do not match the selected backup family. Start again.',
    'bad-format':
      'The backup text has an invalid format. Check your saved copy.',
    'unsupported-length': 'This backup length is not supported.',
    'insufficient-shares':
      'Enter exactly the required number of backup shares.',
    'excess-shares': 'Enter exactly the required number of backup shares.',
    'bad-checksum': 'A backup checksum is invalid. Check your saved copy.',
    'invalid-descriptor': 'The public account descriptor is invalid.',
    'wrong-registry': 'This backup uses an unsupported derivation registry.',
    'wrong-recovery-format': 'This backup uses an unsupported recovery format.',
    'conflict':
      'The account state changed. Review the current account before starting again.',
  }
  if (code === 'too-many-shares') {
    const most = (error as { maxShares?: number })?.maxShares
    return `That is more shares than the app checks at once, so nothing was restored. Enter at most ${most} shares for this backup.`
  }
  return (
    messages[code ?? ''] ??
    'The account operation could not be completed. Check the name, descriptor and exact consistent share set, then start again. Existing account data has been preserved.'
  )
}
