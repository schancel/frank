/**
 * The error `useActiveWallet` throws while no seed phrase exists yet (before sign-up). It is
 * expected on a fresh load, so pollers such as the balance can wait quietly instead of logging an
 * error. Kept in its own module, and matched by `name`, so it survives tests that mock
 * `useActiveWallet` and any bundler duplication of the module.
 */
export const WALLET_NOT_READY = 'WalletNotReadyError'

export function walletNotReadyError(message: string): Error {
  const err = new Error(message)
  err.name = WALLET_NOT_READY
  return err
}

export function isWalletNotReady(err: unknown): boolean {
  return err instanceof Error && err.name === WALLET_NOT_READY
}
