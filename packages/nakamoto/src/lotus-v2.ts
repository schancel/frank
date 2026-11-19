// @frank/nakamoto/lotus-v2: Lotus v2 native (version 7) chain objects.
// Descriptors, typed addresses, spending templates, the P01 transaction
// grammar and identities, P02 commitments, and BIP340 signature messages.

export { LOTUS_V2_CHAINS, LOTUS_V2_REGTEST } from './chain/lotus-v2.js'
export type {
  AnyChainDescriptor,
  ChainFormat,
  ChainIdentity,
  LotusV2ChainDescriptor,
} from './chain/types.js'
export {
  blake3Hash,
  lengthPrefixed,
  lotusV2BranchLeaf,
  lotusV2BranchNode,
  lotusV2BranchProofRoot,
  lotusV2IndexedTreeRoot,
  lotusV2TaggedHash,
} from './lotus-v2/hash.js'
export type { LotusV2HashName } from './lotus-v2/hash.js'
export {
  LOTUS_V2_ADDRESS_PREFIXES,
  decodeLotusV2Address,
  encodeLotusV2Address,
  encodeLotusV2KeyhashAddress,
} from './lotus-v2/address.js'
export type {
  LotusV2AddressError,
  LotusV2AddressErrorCode,
  LotusV2AddressResult,
  LotusV2Destination,
} from './lotus-v2/address.js'
export {
  lotusV2Keyhash,
  lotusV2KeyhashProgram,
  lotusV2KeyhashTemplate,
  lotusV2PublicKeyProgram,
  lotusV2PublicKeyTemplate,
} from './lotus-v2/template.js'
export type { LotusV2SignatureTemplate } from './lotus-v2/template.js'
export {
  LOTUS_V2_MAX_COINBASE_DATA,
  LOTUS_V2_MAX_INPUTS,
  LOTUS_V2_MAX_OUTPUTS,
  LOTUS_V2_MAX_OUTPUT_BRANCHES,
  LOTUS_V2_MAX_OUTPUT_PATHS,
  LOTUS_V2_MAX_MONEY,
  LOTUS_V2_NO_LOCK,
  LOTUS_V2_SEQUENCE_FINAL,
  LotusV2FormatError,
  decodeLotusV2Output,
  decodeLotusV2Transaction,
  encodeLotusV2Input,
  encodeLotusV2Output,
  encodeLotusV2Transaction,
  lotusV2MoneyRange,
  lotusV2OutputLeaf,
  lotusV2TransactionIdentities,
  validateLotusV2Output,
} from './lotus-v2/transaction.js'
export type {
  LotusV2BranchWitness,
  LotusV2Identities,
  LotusV2Input,
  LotusV2Lock,
  LotusV2Output,
  LotusV2Transaction,
} from './lotus-v2/transaction.js'
export {
  LotusV2ScriptError,
  LotusV2UnsupportedError,
  lotusV2CoinsRoot,
  lotusV2OwnInputHash,
  lotusV2SignatureMessage,
  lotusV2SignatureOperand,
  lotusV2TemplatePaymentSize,
  signLotusV2Transaction,
  verifyLotusV2LegacyP2pkh,
  verifyLotusV2Signature,
} from './lotus-v2/sign.js'
export {
  LOTUS_V2_MAX_LEGACY_SCRIPT_BYTES,
  decodeLotusV2CoinOutput,
  encodeLotusV2CoinOutput,
  isLotusV2LegacyCoin,
  lotusV2LegacyBridgeLeaf,
  lotusV2LegacyBridgeWitness,
  lotusV2LegacyP2pkhKey,
  lotusV2LegacyTemplate,
} from './lotus-v2/legacy.js'
export type {
  LotusV2Coin,
  LotusV2LegacyCoin,
  LotusV2LegacyTemplate,
} from './lotus-v2/legacy.js'
export type {
  LotusV2ResolvedCoins,
  LotusV2SignatureTarget,
  LotusV2SignedTransaction,
  LotusV2SigningMode,
  LotusV2LegacyP2pkhSpend,
  LotusV2Spend,
  LotusV2TemplateSpend,
} from './lotus-v2/sign.js'
