import { BurnRefreshError } from './burn-refresh-error'

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
  /** Localized notices; the created text defaults to English for callers that pass none. */
  messages?: { created: string; refreshFailed: string }
}): Promise<void> {
  try {
    await params.submit()
  } catch (err) {
    if (err instanceof BurnRefreshError) {
      // The burn landed; only reading the post back failed. One notice (not also "created"), and
      // leave the form like a success: keeping the draft would invite a second burn.
      params.infoNotify(params.messages?.refreshFailed ?? err.message)
      params.navigateBack()
      return
    }
    params.errorNotify(err)
    return
  }
  params.infoNotify(params.messages?.created ?? 'Post created!')
  params.navigateBack()
}
