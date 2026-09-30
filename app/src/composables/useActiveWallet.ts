/**
 * Small bridge between the pre-existing (Lotus-oriented) wallet store (`stores/wallet.ts`, which
 * still stores the user's BIP-39 seed phrase under `seedPhrase`) and ticket #41's chain-agnostic
 * `ActiveChain` wallet factory (`@frank/wallet/chain/index.ts`'s `activeChain.createWallet`).
 *
 * `.vue` call sites that used to pass the raw Lotus `Wallet` object (`this.$wallet`) into
 * `stores/topics.ts`/`stores/forum.ts`'s actions (ticket #43) use this instead, now that those
 * actions expect an `ActiveChain` `WalletHandle`. Not exported from `@frank/wallet/chain/` itself --
 * that directory is ticket #41's compile-time chain seam and deliberately has no notion of the
 * old Lotus wallet store; this composable is the UI-layer glue on top of it.
 *
 * Memoized by seed phrase so repeated calls in the same session don't reconstruct
 * `MonadChain.createWallet`'s sub-account pool from scratch every time (that constructor derives,
 * and leases against, `subAccountPoolSize` HD sub-accounts -- not free, and every vote/post call
 * site needs a wallet handle).
 */
import { activeChain, WalletHandle } from '@frank/wallet/chain'
import { useWalletStore } from 'src/stores/wallet'
import { walletNotReadyError } from './wallet-not-ready'

let cached:
  | { seedPhrase: string; walletPromise: Promise<WalletHandle> }
  | undefined

/** Resolves the current user's `ActiveChain` `WalletHandle`, deriving it from the wallet store's
 * seed phrase. Throws if the wallet hasn't been initialized yet (no seed phrase set) -- callers
 * are expected to only reach this after wallet setup, matching the old `this.$wallet` precedent's
 * own implicit assumption. */
export function useActiveWallet(): Promise<WalletHandle> {
  const walletStore = useWalletStore()
  const seedPhrase = walletStore.seedPhrase
  if (!seedPhrase) {
    throw walletNotReadyError(
      'useActiveWallet: wallet not initialized yet (no seed phrase set)',
    )
  }
  if (!cached || cached.seedPhrase !== seedPhrase) {
    cached = {
      seedPhrase,
      walletPromise: activeChain.createWallet({ mnemonic: seedPhrase }),
    }
  }
  return cached.walletPromise
}
