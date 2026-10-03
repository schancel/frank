// @frank/nakamoto public surface. Browser-safe: no Node built-ins.
// Per-chain entries: ./btc ./bch ./xec ./xpi.
// Feature entries: ./integer ./script ./script-num ./base58 ./base58check
// ./varint ./reader ./convert-bits ./base32 ./encoding-error ./constructors
// ./bech32 ./cashaddr ./address ./backend ./keys ./hd ./transaction ./sign
// ./block ./curve.

export const PACKAGE_NAME = '@frank/nakamoto'

export {
  CryptoBackendError,
  cryptoBackend,
  nobleBackend,
  selectCryptoBackend,
} from './backend.js'
export type { BackendCode, CryptoBackend } from './backend.js'

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
  ScriptRules,
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

export { evaluateScript, isScriptError, verifyScript } from './script.js'
export type {
  ScriptCode,
  ScriptContext,
  ScriptFailure,
  ScriptResult,
} from './script.js'

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

export {
  addressesFor,
  convertAddress,
  decodeAddress,
  encodeAddress,
  isAddressError,
  lockingScript,
  pubkeyHashFromOutputScript,
  sameDestination,
} from './address.js'
export type {
  AddressEncoding,
  AddressError,
  AddressForm,
  AddressListing,
  AddressResult,
  DecodedAddress,
  Destination,
  ScriptHash,
  TaprootCommitment,
  WitnessScriptHash,
} from './address.js'

export {
  isKeyError,
  privateKeyFromHex,
  privateKeyFromSecretBytes,
  privateKeyFromWif,
  privateKeyToWif,
  publicFromPrivate,
} from './keys.js'
export type {
  CompressionRequired,
  DerivedPublicKey,
  HexInvalid,
  KeyError,
  KeyFailure,
  KeyResult,
  PublicKeyInvalid,
  ScalarOutOfRange,
  UncompressedPublicKey,
  WifCompressionFlag,
  WifPayloadLength,
  WifVersion,
} from './keys.js'

export {
  deriveBip44Account,
  deriveHdPath,
  deriveHdPrivate,
  deriveHdPublic,
  deriveHdPublicPath,
  hdChildScalar,
  hdPrivateFromSeed,
  hdPublicFromPrivate,
  isHdError,
  parseHdPrivate,
  parseHdPublic,
  serializeHdPrivate,
  serializeHdPublic,
} from './hd.js'
export type {
  CoinTypeRequired,
  HdDepth,
  HdError,
  HdFailure,
  HdHardenedPublic,
  HdIndex,
  HdInvalidChild,
  HdKeyPrefix,
  HdPath,
  HdPayloadLength,
  HdPrivateNode,
  HdPublicNode,
  HdResult,
  HdSeedLength,
  HdVersion,
} from './hd.js'

export {
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_DEFAULT,
  SIGHASH_FORKID,
  SIGHASH_LOTUS,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SIGHASH_UTXOS,
  blockMerkleLeaf,
  isTxError,
  parseTransaction,
  serializeTransaction,
  sighash,
  transactionHash,
  transactionId,
} from './transaction.js'
export type {
  OutPoint,
  SighashAlgorithm,
  SighashOptions,
  SpentOutput,
  Transaction,
  TxFailure,
  TxInput,
  TxOutput,
  TxResult,
} from './transaction.js'

export {
  BITCOIN_HEADER_BYTES,
  LOTUS_HEADER_BYTES,
  headerHash,
  isBlockError,
  merkleRoot,
  parseHeader,
  parseMerkleBlock,
  partialMerkleRoot,
  serializeHeader,
  serializeMerkleBlock,
} from './block.js'
export type {
  BitcoinHeader,
  BlockFailure,
  BlockHeader,
  BlockResult,
  LotusHeader,
  MerkleBlock,
} from './block.js'

export { isSignError, signAll, signInput } from './sign.js'
export { signingKey } from './signing-key.js'
export {
  ecdh,
  ecdhWithHash,
  generateDleqProof,
  isCurveError,
  messageDigest,
  pointAdd,
  pointMultiply,
  signEcdsa,
  signMessage,
  signSchnorr,
  tweakAddPrivateKey,
  tweakAddPublicKey,
  verifyDleqProof,
  verifyEcdsa,
  verifyMessage,
  verifySchnorr,
} from './curve.js'
export type { SigningKey, SigningKeyMap } from './signing-key.js'
export type {
  InputSigner,
  InputStatus,
  SignAssignment,
  SignCode,
  SignFailure,
  SignOptions,
  SignResult,
  SignedInput,
  SignedOutput,
  SignedTransaction,
} from './sign.js'
export type {
  BadLength,
  CompressionRequired as CurveCompressionRequired,
  CurveError,
  CurveResult,
  DleqInput,
  DleqProof,
  DleqVerifyInput,
  HashRequired,
  HighS,
  MessageBytes,
  MessageMagicUnpinned,
  PointAtInfinity,
  PointInvalid,
  ScalarOutOfRange as CurveScalarOutOfRange,
  SharedPoint,
  SignatureInvalid,
} from './curve.js'
