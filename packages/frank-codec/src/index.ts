// @frank/codec public surface. Browser-safe: no Node built-ins, no DOM, no globals beyond
// ES2020 (`Uint8Array`, `BigInt`, `Map`).
export * from './constants'
export * from './errors'
export type { Counters, Encodable, FrankValue } from './cbor'
export {
  cborMap,
  decodeCanonical,
  encodeCanonical,
  isValidCanonical,
  newCounters,
} from './cbor'
export type { EnvelopeFields } from './frame'
export { encodeFrame, wrapFrame } from './frame'
export * from './types'
export type { Operation, SupportedSchema, ValidationContext } from './validate'
export {
  KNOWN_TYPES,
  defaultContext,
  parseFrame,
  validateFrame,
} from './validate'
export {
  commonTranscript,
  contentHash,
  contentHashNetwork,
  fromHex,
  messageContentDigest,
  paymentCommitment,
  recipientPayloadDigest,
  toHex,
  topicVoteCommitment,
} from './hash'
export { compareAccounts, compareBytes } from './semantic'
export type { TopicPostFields, TopicVoteDirection } from './topic'
export {
  TOPIC_CBOR_CALLDATA_LENGTH,
  TOPIC_CBOR_CALLDATA_VERSION,
  encodeTopicPost,
  encodeTopicPostSubmission,
  encodeTopicVote,
  topicBurnCalldata,
  topicBurnCommitment,
  topicPostHash,
} from './topic'
