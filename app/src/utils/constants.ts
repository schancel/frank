export const chronikServers = [{ url: 'https://chronik.be.cash/xpi' }]

// The separation here is due the fork. Not all backends support the new network prefixes yet
// So we are using the legacy prefixes everywhere for API calls, but using
// the ecash prefix for display
export const networkName = 'cash-livenet'
export const displayNetwork = 'livenet'

// Wallet constants
export const recomendedBalance = 500_000
export const nUtxoGoal = 10
export const defaultFeePerByte = 2

// Registry constants
export const registrys = ['https://mainnet-keyserver.cashweb.io']

// Relay constants
export const defaultAcceptancePrice = 100
export const defaultRelayUrl = 'https://mainnet-relay.cashweb.io'
export const relayUrlOptions = ['https://mainnet-relay.cashweb.io']

// Avatar constants
export const defaultAvatars = [
  'bunny_cyborg.png',
  'croc_music.png',
  'kitty_standard.png',
  'panda_ninja.png',
  'dog_posh.png',
]

// Chat constants
// Both of these remain Lotus-denominated (ticket #44): `defaultStampAmount` is raw satoshis,
// `stampLowerLimit` is whole XPI, and `pages/Chat.vue`'s `stampAmount` computed getter/setter
// hardcodes the `* 1_000_000`/`/ 1_000_000` satoshi<->XPI conversion between them -- none of which
// maps onto MonadChain's actual denomination (18-decimal wei, via `activeChain.toDisplayAmount`/
// `fromDisplayAmount`, `active-chain.ts`). `ChatInput.vue`'s suffix label was switched to
// `activeChain.unit` for display, but the underlying numeric scaling in `Chat.vue` is untouched --
// that's a real unit-conversion migration (raw amount, not just a display label), out of this
// ticket's scope.
export const defaultStampAmount = 1_000_000 // Sats
export const stampLowerLimit = 1 // XPI

// Contact defaults
export const defaultUpdateInterval = 1000 * 60 * 60 * 1 * 1

// Formatting constants
// TODO: Generate this
export const colorSalt = Buffer.from('salt')
