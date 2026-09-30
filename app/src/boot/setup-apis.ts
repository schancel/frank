/* eslint-disable @typescript-eslint/no-explicit-any */

import { defaultRelayUrl, chronikServers } from '../utils/constants'
import type { Wallet } from '@frank/cashweb/legacy-wallet'
import { boot } from 'quasar/wrappers'
import type { Utxo, UtxoId } from '@frank/cashweb/types/utxo'
import { reactive } from 'vue'
import type { UtxoStore } from '@frank/cashweb/legacy-wallet/storage/storage'
import type { WsEndpoint } from 'chronik-client'
import { useWalletStore } from 'src/stores/wallet'
import { useProfileStore } from 'src/stores/my-profile'
import { useRelayClientStore } from 'src/stores/relay-client'
import { useContactStore } from 'src/stores/contacts'
import { useAppearanceStore } from 'src/stores/appearance'
import { useForumStore } from 'src/stores/forum'
import { useTopicStore } from 'src/stores/topics'
import { useChatStore } from 'src/stores/chats'
import { monadModeEnabled } from 'src/utils/runtime-mode'
import { isSetupComplete } from 'src/utils/account-state'

function instrumentIndexerClient({
  chronikWs,
  observables,
}: {
  chronikWs: WsEndpoint
  observables: { connected: boolean }
}) {
  chronikWs.onConnect = () => {
    console.log('chronik connected')
    observables.connected = true
  }

  chronikWs.onReconnect = () => {
    console.log('chronik disconnected')
    observables.connected = false
  }

  chronikWs.onError = err => console.error('Chronik error:', err)
}

async function createAndBindNewIndexerClient({
  observables,
  wallet,
}: {
  observables: any
  wallet: Wallet
}) {
  const { ChronikClient } = await import('chronik-client')
  const chronikConf =
    chronikServers[Math.floor(Math.random() * chronikServers.length)]
  console.log('Using chronik server:', chronikConf)
  try {
    const chronikClient = new ChronikClient(chronikConf.url)
    const chronikWs = chronikClient.ws({})

    instrumentIndexerClient({
      chronikWs,
      observables,
    })
    console.log('setting chronik client')
    wallet.setChronik({ chronikClient, chronikWs })
    wallet.init()
  } catch (err: any) {
    console.log(err.message)
  }
}

async function getWalletClient() {
  const [{ Wallet }, { store: levelDbUtxoStore }] = await Promise.all([
    import('@frank/cashweb/legacy-wallet'),
    import('../adapters/level-utxo-store'),
  ])
  const utxoStore = await levelDbUtxoStore
  const wallet = useWalletStore()
  // FIXME: This shouldn't be necessary, but the GUI needs real time
  // balance updates. In the future, we should just aggregate a total over time here.
  const storageAdapter: UtxoStore = {
    getById(id: UtxoId) {
      return utxoStore.getById(id)
    },
    deleteById(id: UtxoId) {
      wallet.removeUTXO(id)
      return utxoStore.deleteById(id)
    },
    put(outpoint: Utxo) {
      wallet.addUTXO(Object.freeze({ ...outpoint }))
      return utxoStore.put(outpoint)
    },
    freezeById(id: UtxoId) {
      return utxoStore.freezeById(id)
    },
    unfreezeById(id: UtxoId) {
      return utxoStore.unfreezeById(id)
    },
    getUtxoMap() {
      return utxoStore.getUtxoMap()
    },
    utxosIter() {
      return utxoStore.utxosIter()
    },
    frozenUtxosIter() {
      return utxoStore.frozenUtxosIter()
    },
    clear() {
      return utxoStore.clear()
    },
  }

  return new Wallet(storageAdapter)
}

export default boot(async ({ app }) => {
  const walletStore = useWalletStore()
  await walletStore.restored
  const profileStore = useProfileStore()
  await profileStore.restored

  const xPrivKey = walletStore.xPrivKey
  const status = reactive({
    loaded: false,
    setup: false,
  })
  app.config.globalProperties.$status = status
  // Check if setup was finished.
  // TODO: There should be a better way to do this.
  const profile = profileStore.profile
  console.log('profile.name', profile.name)
  // Ticket #47: `profile.name` is set only by the old Lotus registry/relay round-trip
  // (Setup.vue's now-bypassed setupRelayData()/setUpRegistry()), which a Monad-only signup never
  // runs -- so this was permanently false forever after a real Monad signup, leaving the drawer
  // stuck showing "Login/Sign Up" even for a fully working identity. `walletStore.seedPhrase`
  // existing is exactly the same "is this wallet set up" signal router/index.ts's
  // `skipLegacySetupGate` already uses to let a Monad-only user reach `/chat` at all; mirrored here
  // (same env var, same default-on) so the drawer's own gate agrees with the router's.
  // #284: a stored seed alone is NOT "set up" (the old /setup bug stored one with no name); the
  // Monad path needs seed AND name, the same rule as the router (utils/account-state.ts).
  status.setup =
    (!!xPrivKey && !!profile.name) ||
    (monadModeEnabled() &&
      isSetupComplete({
        seedPhrase: walletStore.seedPhrase,
        name: profile.name,
        seedConfirmedAt: walletStore.seedConfirmedAt,
      }))

  const contactStore = useContactStore()
  await contactStore.restored

  const appearanceStore = useAppearanceStore()
  await appearanceStore.restored

  const forumStore = useForumStore()
  await forumStore.restored

  const chatStore = useChatStore()
  await chatStore.restored

  const topicStore = useTopicStore()
  await topicStore.restored

  // Monad mode must not instantiate or expose any part of the old Lotus mailbox protocol. Those
  // objects open their own database/network stack and previously caused misleading reconnect UI
  // even though all active messaging uses the Monad chain adapter.
  if (monadModeEnabled()) {
    return
  }

  const wallet = await getWalletClient()
  const indexerObservables = reactive({ connected: false })
  await createAndBindNewIndexerClient({
    observables: indexerObservables,
    wallet,
  })

  if (xPrivKey && profile.name) {
    console.log('Loaded previous private key')
    wallet.setXPrivKey(xPrivKey)
    status.setup = true
  }

  const [{ getRelayClient }, { useRelayClient, useWallet }] = await Promise.all(
    [import('../adapters/pinia-relay-adapter'), import('src/utils/clients')],
  )
  const { client: relayClient, observables: relayObservables } =
    await getRelayClient({
      relayUrl: defaultRelayUrl,
      wallet,
    })

  const relayStore = useRelayClientStore()
  await relayStore.restored
  if (relayStore.token) {
    relayClient.setToken(relayStore.token)
  }

  app.config.globalProperties.$wallet = useWallet(wallet)
  app.config.globalProperties.$indexer = indexerObservables
  app.config.globalProperties.$relayClient = useRelayClient(relayClient)
  app.config.globalProperties.$relay = relayObservables
})
