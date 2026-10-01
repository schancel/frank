import {
  addressesFor,
  convertAddress,
  encodeAddress,
  type Destination,
} from '../src/address.js'
import { BTC_MAINNET } from '../src/btc.js'
import type {
  CompressedPublicKey,
  XOnlyPublicKey,
} from '../src/constructors.js'

declare const pubkey: CompressedPublicKey
declare const outputKey: XOnlyPublicKey
declare const tweak: Uint8Array
declare const destination: Destination

// Chain-dependent address calls do not compile without a descriptor.
// @ts-expect-error chain is required; there is no default chain
addressesFor(pubkey)

// @ts-expect-error chain is required
encodeAddress(destination, 'base58check')

// @ts-expect-error chain is required
convertAddress(destination)

// @ts-expect-error a compressed public key is not an x-only output key
addressesFor(pubkey, BTC_MAINNET, { outputKey: pubkey, tweak })

// @ts-expect-error the taproot output key does not imply a tweak
addressesFor(pubkey, BTC_MAINNET, { outputKey })
