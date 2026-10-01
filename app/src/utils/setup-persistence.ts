export interface PersistenceBarrier {
  flushPersistence(): Promise<void>
}

export interface ReloadLocation {
  hash: string
  reload(): void
}

async function flushSetupPersistence(
  wallet: PersistenceBarrier,
  profile: PersistenceBarrier,
  notifyError: (error: Error) => void,
): Promise<void> {
  try {
    await Promise.all([wallet.flushPersistence(), profile.flushPersistence()])
  } catch (error) {
    const persistenceError =
      error instanceof Error ? error : new Error(String(error))
    notifyError(persistenceError)
    throw persistenceError
  }
}

/**
 * After the seed and name are durable, start the Monad identity in this page and open the
 * forum. A rejected write never initializes and never navigates. `finishReloads` is the explicit
 * fallback (`QCLI_SETUP_FINISH_RELOAD=true`) and is the only path that reloads.
 */
export async function finishSetupAndEnter(options: {
  wallet: PersistenceBarrier
  profile: PersistenceBarrier
  notifyError: (error: Error) => void
  finishReloads: boolean
  location: ReloadLocation
  initialize: () => Promise<unknown>
  navigate: (path: string) => Promise<unknown> | unknown
}): Promise<void> {
  await flushSetupPersistence(
    options.wallet,
    options.profile,
    options.notifyError,
  )
  if (options.finishReloads) {
    options.location.hash = '#/'
    options.location.reload()
    return
  }
  try {
    await options.initialize()
  } catch (error) {
    const initError = error instanceof Error ? error : new Error(String(error))
    options.notifyError(initError)
    throw initError
  }
  await options.navigate('/forum')
}
