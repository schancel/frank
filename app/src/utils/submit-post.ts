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
}): Promise<void> {
  try {
    await params.submit()
  } catch (err) {
    params.errorNotify(err)
    return
  }
  params.infoNotify('Post created!')
  params.navigateBack()
}
