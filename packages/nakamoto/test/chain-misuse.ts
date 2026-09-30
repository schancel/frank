import { addressVersionBytes, getChain } from '../src/chain/index.js'

// Chain-dependent calls do not compile without a descriptor.
// @ts-expect-error chain is required
addressVersionBytes()

// @ts-expect-error both family and network are required; there is no default network
getChain('btc')
