/**
 * After Setup has made the seed and profile durable in its required order, start the Monad
 * identity in this page and open the forum. The caller owns reporting and retry state so an
 * initialization or navigation failure can retry without rewriting either store.
 */
export async function finishSetupAndEnter(options: {
  initialize: () => Promise<unknown>
  navigate: (path: string) => Promise<unknown> | unknown
}): Promise<void> {
  await options.initialize()
  await options.navigate('/forum')
}
