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
  await options.navigate('/forum')
}
