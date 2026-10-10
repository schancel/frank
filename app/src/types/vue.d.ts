import { Wallet } from '@frank/cashweb/legacy-wallet'

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    $wallet: Wallet
    $relay: {
      connected: boolean
    }
    $indexer: {
      connected: boolean
    }
    $status: {
      loaded: boolean
      setup: boolean
    }

    openURL: (url: string) => void
  }
}
