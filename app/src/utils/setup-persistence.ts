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
): Promise<void> {
  await Promise.all([wallet.flushPersistence(), profile.flushPersistence()])
  location.hash = '#/'
  location.reload()
}
