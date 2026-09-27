/**
 * Boot wiring for the Monad direct-message poll loop (ticket #42 -- see `PLAN.md`'s M9 section).
 * A separate boot file rather than folding this into `setup-apis.ts`: that file is the pre-existing
 * Lotus (`Wallet`/`RelayClient`/Chronik) boot sequence, out of this ticket's scope to restructure
 * (`stores/chats.ts`/`contacts.ts` only) -- keeping this wiring in its own file means a failure in
 * either boot path can't take down the other, and this file has nothing to add/remove from
 * `setup-apis.ts` once ticket #44 eventually retires it.
 *
 * ## Where the Monad seed comes from
 *
 * `ActiveChain.createWallet` (`../cashweb/chain/active-chain.ts`) needs an `HDSeed` (BIP-39
 * mnemonic). This app already has exactly one: `stores/wallet.ts`'s `seedPhrase` (a real BIP-39
 * mnemonic, `generateMnemonic()` from the `bip39` package -- see `pages/Setup.vue`), currently used
 * only to derive the Lotus `HDPrivateKey`. Reusing it here (rather than inventing a second,
 * Monad-only seed with its own storage/setup UI, which would be new scope well beyond this
 * ticket's stores/chats.ts+contacts.ts file scope) gives "one seed backs up everything," matching
 * `monad-identity.ts`'s own header rationale for deriving its identity key HD-deterministically
 * from the same seed `createWallet` receives.
 *
 * If setup was never completed (no `seedPhrase` yet), this boot file simply no-ops -- there's
 * nothing to poll for yet, and forcing setup here would be out of scope.
 */
import { boot } from 'quasar/wrappers'

import { activeChain } from '../cashweb/chain'
import { useWalletStore } from '../stores/wallet'
import { useMonadWallet } from '../utils/clients'
import { startDirectMessagePolling } from '../adapters/pinia-chain-adapter'

const DIRECT_MESSAGE_POLL_INTERVAL_MS = Number(
  process.env.MONAD_DM_POLL_INTERVAL_MS ?? 7000,
)

export default boot(async () => {
  const walletStore = useWalletStore()
  await walletStore.restored

  if (!walletStore.seedPhrase) {
    console.log(
      'monad-direct-messages boot: no seed phrase yet (setup incomplete), skipping direct-message polling',
    )
    return
  }

  const wallet = await activeChain.createWallet({
    mnemonic: walletStore.seedPhrase,
  })
  useMonadWallet(wallet)

  startDirectMessagePolling({
    wallet,
    intervalMs: DIRECT_MESSAGE_POLL_INTERVAL_MS,
  })
})
