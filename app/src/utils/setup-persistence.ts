export interface ReloadLocation {
  hash: string
  reload(): void
}

/**
 * After Setup has made the seed and profile durable in its required order, start the Monad
 * identity in this page and open the forum. The configured fallback reloads only after both
 * stores are durable. The caller owns reporting and retry state for every failure.
 */
export async function finishSetupAndEnter(options: {
  finishReloads: boolean
  location: ReloadLocation
  initialize: () => Promise<unknown>
  navigate: (path: string) => Promise<unknown> | unknown
}): Promise<void> {
  if (options.finishReloads) {
    options.location.hash = '#/'
    options.location.reload()
    return
  }
  await options.initialize()
  const outcome = await options.navigate('/forum')
  // Vue Router resolves an aborted or cancelled navigation instead of rejecting it: a
  // NavigationFailure is the resolved value (an Error carrying a numeric failure type), and a
  // successful push resolves void/undefined. Treating a resolved failure as success would mark
  // the account completed while /setup is still the current route, with no way to retry entry.
  if (outcome) {
    throw new Error('setup finish navigation did not complete')
  }
}
