import { Address, Networks } from 'bitcore-lib-xpi'
import { networkName, displayNetwork } from './constants'

// Lotus-only (ticket #44): these convert between bitcore-lib-xpi's cash-address/legacy-XAddress
// encodings, which only exist because Lotus has more than one address representation for the same
// pubkey hash. There is no Monad equivalent -- `ChainAddress` (`../cashweb/chain/active-chain.ts`)
// is a single canonical `0x...` string, formatted/parsed via `activeChain.formatAddress`/
// `parseAddress` instead. Superseded for anything chain-generic; still genuinely needed by the
// remaining Lotus-only callers of this file (`components/setup/DepositStep.vue`, part of the
// still-unmigrated Setup.vue onboarding wizard -- see issue #47).
export function toAPIAddress(address: string | Address) {
  return new Address(
    new Address(address).hashBuffer,
    Networks.get(networkName, undefined),
  ).toCashAddress()
}

export function toDisplayAddress(address: string | Address) {
  return new Address(
    new Address(address).hashBuffer,
    Networks.get(displayNetwork, undefined),
  ).toXAddress()
}
