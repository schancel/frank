export interface PersistenceBarrier {
  flushPersistence(): Promise<void>
}

export interface ReloadLocation {
  hash: string
  reload(): void
}

/**
 * Cross the setup reload boundary only after both pieces of identity state are
 * durable. A rejected write deliberately prevents the reload so the next boot
 * cannot silently restore stale profile or wallet data.
 */
export async function persistSetupAndReload(
  wallet: PersistenceBarrier,
  profile: PersistenceBarrier,
  location: ReloadLocation,
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
  location.hash = '#/'
  location.reload()
}
