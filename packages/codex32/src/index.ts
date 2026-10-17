import * as bip93 from './bip93-codex32.js'
import * as gf32 from './gf32-recovery-shares.js'

export type {
  Codex32Error,
  Codex32ErrorCode,
  Codex32Result,
  RecoveryShareError,
  RecoveryShareErrorCode,
  RecoveryShareMetadata,
  RecoveryShareResult,
  SplitGf32SymbolsInput,
  SplitRecoverySharesInput,
} from './gf32-recovery-shares.js'

export type {
  Codex32Share,
  EncodeCodex32Input,
  RecoveredCodex32,
  SplitCodex32Input,
} from './bip93-codex32.js'

export const GF32_ALPHABET = gf32.GF32_ALPHABET
export const interpolateGf32Symbols = gf32.interpolateGf32Symbols
export const createMasterPayload = gf32.createMasterPayload
export const validateMasterPayload = gf32.validateMasterPayload
export const createLongBchChecksum = gf32.createLongBchChecksum
export const verifyLongBchChecksum = gf32.verifyLongBchChecksum
export const splitGf32Symbols = gf32.splitGf32Symbols
export const splitRecoveryShares = gf32.splitRecoveryShares
export const combineRecoveryShares = gf32.combineRecoveryShares
export const bytesToGf32Symbols = gf32.bytesToGf32Symbols
export const gf32SymbolsToBytes = gf32.gf32SymbolsToBytes

export const encodeCodex32 = bip93.encodeCodex32
export const decodeCodex32 = bip93.decodeCodex32
export const validateCodex32Checksum = bip93.validateCodex32Checksum
export const codex32SecretPayloadSymbols = bip93.codex32SecretPayloadSymbols
export const interpolateCodex32Symbols = bip93.interpolateCodex32Symbols
export const codex32SymbolsToBytes = bip93.codex32SymbolsToBytes
export const splitCodex32 = bip93.splitCodex32
export const recoverCodex32Exact = bip93.recoverCodex32Exact
export const recoverCodex32 = bip93.recoverCodex32
