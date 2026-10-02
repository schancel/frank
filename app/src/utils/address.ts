import { lotusFromAddress } from '@frank/cashweb/legacy-wallet/lotus-address'
import { networkName, displayNetwork } from './constants'

// Lotus-only (ticket #44): these convert between bitcore-lib-xpi's cash-address/legacy-XAddress
// encodings, which only exist because Lotus has more than one address representation for the same
// pubkey hash. There is no Monad equivalent -- `ChainAddress` (`@frank/wallet/chain/active-chain.ts`)
// is a single canonical `0x...` string, formatted/parsed via `activeChain.formatAddress`/
// `parseAddress` instead. Superseded for anything chain-generic; still genuinely needed by the
// remaining Lotus-only callers of this file (`components/setup/DepositStep.vue`, part of the
// still-unmigrated Setup.vue onboarding wizard -- see issue #47).
type AddressInput =
  | string
  | {
      readonly hashBuffer: Uint8Array
      readonly type: string
    }

function asLotusInput(
  address: AddressInput,
): Parameters<typeof lotusFromAddress>[0] {
  return address as Parameters<typeof lotusFromAddress>[0]
}

export function toAPIAddress(address: AddressInput) {
  return lotusFromAddress(asLotusInput(address), networkName)
}

export function toDisplayAddress(address: AddressInput) {
  return lotusFromAddress(asLotusInput(address), displayNetwork)
}
