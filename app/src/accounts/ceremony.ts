import {
  beginCodex32Signup,
  beginCodex32Restore,
  decodeRecoveryDescriptor,
  encodeRecoveryDescriptor,
  destroyRecoveredAccount,
  randomCodex32Identifier,
  type PendingCodex32Signup,
  type PendingCodex32Restore,
  type Codex32ShareRecovery,
  type RecoveredCodex32Account,
} from '@frank/account-recovery'
import { requireValidProfileDisplayName } from '@frank/wallet/profile-display-name'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { toHex } from '@frank/codec'
import { setCustomRelayBaseUrl } from '@frank/wallet/chain'
import { probeDirectoryRelay } from '@frank/cashweb/relay'
import { accountSession } from './session'
import { assertLegacyUnchanged, legacyStatus } from './legacy'
import type { ExpectedActive } from './custody'

/** Non-reactive transient owner. Components hold only currently displayed/input strings. */
export function createAccountCeremony() {
  let signup: PendingCodex32Signup | undefined
  let restore: PendingCodex32Restore | undefined
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
  let choice: RecoveredCodex32Account[] | undefined
  const cancel = () => {
    ++epoch
    choice?.forEach(destroyRecoveredAccount)
    choice = undefined
    signup?.cancel()
    restore?.cancel()
    signup = undefined
    restore = undefined
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
    take: () => RecoveredCodex32Account | undefined,
    isRestore: boolean,
    displayName: string,
  ) {
    if (!attempt) throw new Error('Start an account ceremony first')
    const captured = attempt
    const token = epoch
    let recovered: RecoveredCodex32Account | undefined
    try {
      recovered = take()
      if (!recovered) throw new Error('Start an account ceremony first')
      let discoveredRelayUrl: string | undefined
      let identityDetails: { subject: string; address: string } | undefined
      if (isRestore) {
        try {
          const authRoot = recovered.roots['identity-authentication']
          if (authRoot) {
            const identity = MonadIdentity.fromDomainRoot(authRoot)
            const subject = toHex(identity.compressedPubKey)
            const address = identity.displayAddress
            identityDetails = { subject, address }
            discoveredRelayUrl = await probeDirectoryRelay({
              subject,
              address,
            })
            if (discoveredRelayUrl) {
              setCustomRelayBaseUrl(discoveredRelayUrl)
            }
          }
        } catch {
          // probe failure should never block account recovery
        }
      }
      await assertLegacyUnchanged(captured.legacyRevision)
      if (token !== epoch) throw new Error('Ceremony cancelled')
      // Custody keeps the account root only; every purpose root is derived from it
      // each time the account is opened.
      await accountSession.stage({
        ...captured,
        displayName,
        custodyEpoch: 1,
        metadata: recovered.metadata,
        accountRoot: recovered.accountRoot,
      })
      if (token !== epoch)
        await accountSession.cancelPending(captured.attemptId)
      return {
        isRestore,
        subject: identityDetails?.subject,
        address: identityDetails?.address,
        discoveredRelayUrl,
      }
    } catch (error) {
      // A mismatch/failure consumes this presentation ceremony; retry starts explicitly.
      cancel()
      throw error
    } finally {
      if (recovered) destroyRecoveredAccount(recovered)
    }
  }
  return {
    cancel,
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
      restore = beginCodex32Restore(descriptor)
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
      const displayName = requireValidProfileDisplayName(name)
      if (!attempt) throw new Error('Start an account ceremony first')
      if (signup) {
        return finish(
          () => {
            const recovered = signup?.confirmWithMetadata(shares)
            signup = undefined
            return recovered
          },
          false,
          displayName,
        )
      }
      let recovery: Codex32ShareRecovery
      try {
        if (!restore) throw new Error('Start an account ceremony first')
        recovery = restore.recoverAny(shares)
        restore = undefined
      } catch (error) {
        cancel()
        throw error
      }
      if (recovery.candidates.length > 1) {
        choice = recovery.candidates.map(candidate => candidate.account)
        return {
          isRestore: true,
          report: recovery.shares,
          candidates: recovery.candidates.map(candidate => ({
            address: MonadIdentity.fromDomainRoot(
              candidate.account.roots['identity-authentication'],
            ).displayAddress,
            descriptor: encodeRecoveryDescriptor(
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
      return { ...outcome, report: recovery.shares }
    },
    /** Stage the candidate the user picked after `confirm` returned several. */
    async choose(index: number, name: string) {
      const displayName = requireValidProfileDisplayName(name)
      const candidates = choice
      choice = undefined
      const chosen = candidates?.[index]
      candidates?.forEach(candidate => {
        if (candidate !== chosen) destroyRecoveredAccount(candidate)
      })
      if (!chosen) {
        cancel()
        throw new Error('Start an account ceremony first')
      }
      return finish(() => chosen, true, displayName)
    },
  }
}

export function recoveryErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code
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
