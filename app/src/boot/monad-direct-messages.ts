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
 * `ActiveChain.createWallet` (`@frank/wallet/chain/active-chain.ts`) needs an `HDSeed` (BIP-39
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

import { activeChain } from '@frank/wallet/chain'
import { useWalletStore } from '../stores/wallet'
import { useMonadWallet } from '../utils/clients'
import { startDirectMessagePolling } from '../adapters/pinia-chain-adapter'
import {
  MonadIdentity,
  registerMonadIdentity,
} from '@frank/wallet/monad-identity'
import {
  MonadChainConfig,
  loadMonadChainConfigFromEnv,
} from '@frank/wallet/chain/monad-chain'

// KNOWN BROKEN (ticket #53 GUI verification): setting MONAD_DM_POLL_INTERVAL_MS currently has no
// effect -- see router/index.ts's MONAD_SKIP_LEGACY_SETUP_GATE comment for the full
// investigation (a `viteConf.define` gap that doesn't reach first-party source at all in this
// toolchain) and the tracked follow-up issue.
const DIRECT_MESSAGE_POLL_INTERVAL_MS = Number(
  process.env.MONAD_DM_POLL_INTERVAL_MS ?? 7000,
)

/** Registers `wallet.identity` with the relay (`PUT /metadata/:addr`, no payment -- POP disabled
 * for the demo) if it isn't already, so this wallet can actually be discovered/messaged by anyone
 * else (`activeChain.fetchProfile`, and by extension every direct-message/AddContact flow that
 * depends on it -- ticket #42/#44). Found missing tonight: `registerMonadIdentity`
 * (`monad-identity.ts`, ticket #41, proven end-to-end by ticket #45's backend route) had zero
 * callers anywhere in the app -- every Monad-native wallet `createWallet` ever produced was
 * silently unregistered, un-discoverable, and unable to receive a reply (the sender side of
 * `MonadChain.directMessages.fetchSince` resolves `envelope.from`'s pubkey via `fetchMonadProfile`
 * to decrypt -- an unregistered sender's messages can never be decrypted by anyone, including
 * replies back to them).
 *
 * No balance/payment is required for this: POP protection is disabled for the hackathon demo
 * (`PLAN.md` constraint 4; see `backend/.../pop_protection.rs` and ticket #35), so registration is
 * a free, unauthenticated `PUT`. There is deliberately no "wait until funded" gate here to
 * toggle -- none exists on this (Monad-native) signup path today, unlike the old, still-unported
 * Lotus `Setup.vue`/`DepositStep.vue` wizard (issue #47) which does hard-gate on balance. If a real
 * funding requirement is wanted before registration/messaging is allowed, that's its own scoped
 * feature to design, not a flag to bolt on speculatively here.
 *
 * Re-registers on every boot rather than tracking "did I already register" locally: `Registry::
 * put_monad_profile`'s monotonic-timestamp check (ticket #45) makes a re-PUT with `Date.now()`
 * idempotent-enough (always accepted, since time only moves forward), matching the same pattern
 * `qwen-bot-common.ts`'s `registerAndLog` already established for the Lotus side. Failures are
 * logged, not fatal to boot -- a relay hiccup on startup shouldn't brick the whole app when direct
 * messaging isn't being used yet.
 */
async function ensureIdentityRegistered(
  identity: MonadIdentity,
  config: MonadChainConfig,
): Promise<void> {
  try {
    await registerMonadIdentity({ relayBaseUrl: config.relayBaseUrl, identity })
    console.log(
      `monad-direct-messages boot: registered identity ${identity.displayAddress} with ${config.relayBaseUrl}`,
    )
  } catch (err) {
    console.error(
      `monad-direct-messages boot: failed to register identity ${identity.displayAddress} -- ` +
        'others will not be able to discover or message this wallet until this succeeds',
      err,
    )
  }
}

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

  await ensureIdentityRegistered(
    wallet.identity as MonadIdentity,
    loadMonadChainConfigFromEnv(),
  )

  startDirectMessagePolling({
    wallet,
    intervalMs: DIRECT_MESSAGE_POLL_INTERVAL_MS,
  })
})
