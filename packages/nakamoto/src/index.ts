// @frank/nakamoto public surface. Browser-safe: no Node built-ins.
// Per-chain entries: ./btc ./bch ./xec ./xpi.
// Feature entries: ./integer ./script-num ./base58 ./base58check ./varint
// ./reader ./convert-bits ./base32 ./encoding-error ./constructors.

export const PACKAGE_NAME = '@frank/nakamoto'

export {
  BCH_MAINNET,
  BCH_REGTEST,
  BCH_TESTNET,
  BTC_MAINNET,
  BTC_REGTEST,
  BTC_TESTNET,
  CHAINS,
  XEC_MAINNET,
  XEC_REGTEST,
  XEC_TESTNET,
  XPI_MAINNET,
  XPI_REGTEST,
  XPI_TESTNET,
  addressVersionBytes,
  getChain,
  isUnknownChainError,
} from './chain/index.js'
export type {
  ChainDescriptor,
  ChainFamily,
  DisplayUnit,
  HeaderShape,
  MessageMagic,
  NetworkKind,
  PolicyAmount,
  SighashFamily,
  UnknownChainError,
} from './chain/types.js'

export { bigintToBytes, bytesToBigint, isIntegerError, mod } from './integer.js'
export type { IntegerError, IntegerResult } from './integer.js'

export {
  decodeScriptNum,
  encodeScriptNum,
  isMinimalScriptNum,
  isScriptNumError,
} from './script-num.js'
export type {
  ScriptNumDecodeOptions,
  ScriptNumError,
  ScriptNumResult,
} from './script-num.js'

export { BASE58_ALPHABET, decodeBase58, encodeBase58 } from './base58.js'
export { decodeBase58Check, encodeBase58Check } from './base58check.js'
export { decodeVarint, encodeVarint } from './varint.js'
export { ByteReader, ByteWriter } from './reader.js'
export { convertBits } from './convert-bits.js'
export { CASHADDR_CHARSET, decodeBase32, encodeBase32 } from './base32.js'
export { EncodingException, isEncodingError } from './encoding-error.js'
export type { EncodingError, EncodingResult } from './encoding-error.js'

export {
  compressedPublicKeyFromBytes,
  displayTxidFromBytes,
  displayTxidFromInternal,
  ecdsaSignatureFromBytes,
  internalHashFromBytes,
  internalHashFromDisplay,
  privateKeyFromBytes,
  pubkeyHashFromBytes,
  schnorrSignatureFromBytes,
  sighashByte,
  xAddressPayloadFromBytes,
  xOnlyPublicKeyFromBytes,
} from './constructors.js'
export type {
  CompressedPublicKey,
  DisplayTxid,
  EcdsaSignature,
  ExplicitSign,
  InternalHash,
  PrivateKey,
  PrivateKeyBytes,
  PubkeyHash,
  SchnorrSignature,
  SighashByte,
  SigningMethod,
  XAddressPayload,
  XOnlyPublicKey,
} from './constructors.js'
