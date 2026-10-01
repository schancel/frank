import { BurnRefreshError } from './burn-refresh-error'
import { TopicPostOutcomeUnknownError } from '@frank/wallet/chain/active-chain'

export type PostSubmissionOutcome =
  | 'submitted'
  | 'retryable-failure'
  | 'unknown-outcome'

/**
 * The actual submit/error/navigate decision behind `CreatePost.vue`'s `post()` method, pulled out
 * so it's directly unit-testable -- ticket #159. The bug was a `finally { this.back() }` that ran
 * unconditionally, navigating away (and so unmounting the component, discarding its draft) even
 * when `submit()` had just failed. The fix is simply: only navigate away, and only notify success,
 * on the path where `submit()` actually succeeded.
 */
export async function submitPost(params: {
  submit: () => Promise<unknown>
  errorNotify: (err: unknown) => void
  infoNotify: (message: string) => void
  navigateBack: () => void
  /** Observes the classified economic outcome before notification/navigation side effects. */
  onOutcome?: (outcome: PostSubmissionOutcome) => void
  /** Localized notices; the created text defaults to English for callers that pass none. */
  messages?: { created: string; refreshFailed: string }
}): Promise<PostSubmissionOutcome> {
  try {
    await params.submit()
  } catch (err) {
    if (err instanceof TopicPostOutcomeUnknownError) {
      // The paid request may have landed. Keep the draft visible, report the original failure,
      // and let the caller retain its process-lifetime duplicate-submission reservation.
      params.onOutcome?.('unknown-outcome')
      params.errorNotify(err.cause)
      return 'unknown-outcome'
    }
    if (err instanceof BurnRefreshError) {
      // The burn landed; only reading the post back failed. One notice (not also "created"), and
      // leave the form like a success: keeping the draft would invite a second burn.
      params.onOutcome?.('submitted')
      params.infoNotify(params.messages?.refreshFailed ?? err.message)
      params.navigateBack()
      return 'submitted'
    }
    params.onOutcome?.('retryable-failure')
    params.errorNotify(err)
    return 'retryable-failure'
  }
  params.onOutcome?.('submitted')
  params.infoNotify(params.messages?.created ?? 'Post created!')
  params.navigateBack()
  return 'submitted'
}
