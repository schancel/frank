import {
  beginCodex32Signup,
  beginCodex32Restore,
  decodeRecoveryDescriptor,
  encodeRecoveryDescriptor,
  destroyAccountDomainRoots,
  type PendingCodex32Signup,
  type PendingCodex32Restore,
  type RecoveredCodex32Account,
} from '@frank/account-recovery'
import { DOMAIN_PURPOSES } from '@frank/domain-roots'
import { requireValidProfileDisplayName } from '@frank/wallet/profile-display-name'
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
  const cancel = () => {
    ++epoch
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
      try {
        signup = beginCodex32Signup({
          threshold,
          identifier: 'frnk',
          indices: ['q', 'p', 'z', 'r', 'y'].slice(0, count),
          randomBytes: length => {
            const bytes = crypto.getRandomValues(new Uint8Array(length))
            randomBuffers.push(bytes)
            return bytes
          },
        })
      } finally {
        randomBuffers.forEach(bytes => bytes.fill(0))
      }
      return encodeRecoveryDescriptor(signup.publicDescriptor)
    },
    share(index: number) {
      return signup?.shares[index] ?? ''
    },
    async beginRestore(text: string) {
      cancel()
      // Pin the independent descriptor before accepting any shares.
      const descriptor = decodeRecoveryDescriptor(text)
      await capture()
      restore = beginCodex32Restore(descriptor)
      return encodeRecoveryDescriptor(descriptor)
    },
    async confirm(shares: readonly string[], name: string) {
      const displayName = requireValidProfileDisplayName(name)
      if (!attempt) throw new Error('Start an account ceremony first')
      const captured = attempt
      const token = epoch
      let recovered: RecoveredCodex32Account | undefined
      try {
        recovered = signup
          ? signup.confirmWithMetadata(shares)
          : restore?.recover(shares)
        if (!recovered) throw new Error('Start an account ceremony first')
        signup = undefined
        restore = undefined
        await assertLegacyUnchanged(captured.legacyRevision)
        if (token !== epoch) throw new Error('Ceremony cancelled')
        const roots = recovered.roots
        await accountSession.stage({
          ...captured,
          displayName,
          custodyEpoch: 1,
          metadata: recovered.metadata,
          roots: DOMAIN_PURPOSES.map(purpose => roots[purpose]),
        })
        if (token !== epoch)
          await accountSession.cancelPending(captured.attemptId)
      } catch (error) {
        // A mismatch/failure consumes this presentation ceremony; retry starts explicitly.
        cancel()
        throw error
      } finally {
        if (recovered) destroyAccountDomainRoots(recovered.roots)
      }
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
    'duplicate-share': 'Each backup share must have a different index.',
    'wrong-share-count': 'Enter exactly the required number of backup shares.',
    'inconsistent-share':
      'These backup shares are inconsistent. Start again with a matching set.',
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
  return (
    messages[code ?? ''] ??
    'The account operation could not be completed. Check the name, descriptor and exact consistent share set, then start again. Existing account data has been preserved.'
  )
}
