import type { LotusV2ChainDescriptor } from './types.js'

// Lotus v2 descriptors. Only regtest is defined: mainnet and testnet have no
// launch genesis or frozen constants yet (lotusd refuses to start on them), so
// nakamoto has no descriptor for either. The address codec still recognises
// their prefixes, to report such a string as `network-not-defined`.

const SPEC =
  'Lotus repository docs/lotus-v2/ (read 2026-11-19): decisions/encoding-and-signatures.md (P01), decisions/commitments-and-state.md (P02), addresses.md'

export const LOTUS_V2_REGTEST: LotusV2ChainDescriptor = Object.freeze({
  format: 'lotus-v2' as const,
  protocolId: 'lotus-v2-regtest',
  proxyFamily: 'bitcoin' as const,
  allowedProxyCapabilities: Object.freeze([
    'json-rpc' as const,
    'chronik' as const,
  ]),
  identityProbes: Object.freeze([
    Object.freeze({
      kind: 'operator-block-checkpoint' as const,
      capability: 'json-rpc' as const,
    }),
    Object.freeze({
      kind: 'operator-block-checkpoint' as const,
      capability: 'chronik' as const,
    }),
  ]),
  network: 'regtest' as const,
  chainId: '00'.repeat(32),
  transactionVersion: 7 as const,
  hash: Object.freeze({
    kind: 'blake3-tagged' as const,
    tagPrefix: 'Lotus/v2/' as const,
  }),
  merkle: Object.freeze({
    kind: 'indexed-tagged' as const,
    oddRule: 'pad-zero' as const,
  }),
  address: Object.freeze({
    kind: 'lotus-v2-typed' as const,
    hrp: 'rxpi',
    checksumConstant: 0x8172b45d63n,
    types: Object.freeze([0 as const, 1 as const]),
  }),
  signature: Object.freeze({
    kind: 'bip340-x-only' as const,
    modes: Object.freeze([0 as const, 1 as const, 2 as const]),
  }),
  sources: Object.freeze([
    SPEC,
    'Regtest ChainID is 32 zero bytes: addresses.md "Adding a network" (regtest chain_id 00..00) and lotusd kernel/chainparams.cpp V2_REGTEST_CHAIN_ID{}',
    'Checksum constant K["rxpi"] = 0x8172b45d63: addresses.md "Checksum"',
  ]),
})

export const LOTUS_V2_CHAINS: readonly LotusV2ChainDescriptor[] = Object.freeze(
  [LOTUS_V2_REGTEST],
)
