import {
  deriveBip44Account,
  hdPrivateFromSeed,
  privateKeyFromSecretBytes,
  privateKeyFromWif,
  privateKeyToWif,
  type HdPrivateNode,
  type PrivateKey,
} from '../src/index.js'

declare const bytes: Uint8Array
declare const key: PrivateKey
declare const node: HdPrivateNode

// @ts-expect-error compression is required; there is no uncompressed default
privateKeyFromSecretBytes(bytes)
// @ts-expect-error WIF needs the chain descriptor, not a default network
privateKeyFromWif('L')
// @ts-expect-error WIF needs the chain descriptor, not a default network
privateKeyToWif(key)
// @ts-expect-error the coin type is a required argument
deriveBip44Account(node)
// @ts-expect-error a seed is required; there is no random default
hdPrivateFromSeed()
