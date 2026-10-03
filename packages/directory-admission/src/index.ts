/** Public data only. Open an explicit browser or Node backend to perform admission. */
export type { AccountRef, Timestamp, RelayBinding } from '@frank/codec'
import type { AccountRef, Timestamp, RelayBinding } from '@frank/codec'

export interface Anchor {
  network: string
  subject: AccountRef
  revisionZero: Uint8Array
}
export interface Candidate {
  statement: Uint8Array
  attestation: Uint8Array
}
export interface Context {
  now: Timestamp | null
  relay: RelayBinding | null
}
/** Retain the entire caller-owned checkpoint outside the database rollback domain. */
export interface Checkpoint {
  kind: 'ProspectiveEnrollment' | 'CommittedPrefix'
  identity: Uint8Array
  anchor: Uint8Array
  head: Uint8Array | null
  accepted: number
  retained: number
  evidenceDigest: Uint8Array
  checkedTime: Timestamp
  forked: boolean
}
export type OpenMode =
  | { kind: 'new' }
  | { kind: 'reopen'; checkpoint: Checkpoint }
export interface HistoricalEvidence extends Candidate {
  kind: 'historical-evidence'
  hash: Uint8Array
}
/** No freshness authority. Even a valid status requires current() before new use. */
export interface Status {
  kind: 'historical-status'
  checkpoint: Checkpoint
  head: Uint8Array | null
  revision: bigint | null
  generations: [bigint, bigint] | null
  currentStamp: AccountRef | null
  previousStamp: AccountRef | null
  accepted: number
  retained: number
  chargedBytes: number
  forked: boolean
  checkedTime: Timestamp
}
/** Point-in-time snapshot, not a persistent authority token. */
export interface Current {
  kind: 'current'
  evidence: HistoricalEvidence
  messageKey: AccountRef
  stampKey: AccountRef
  previousStamp: AccountRef | null
  revision: bigint
  generations: [bigint, bigint]
  status: Status
}
export type AdmissionErrorCode =
  | 'anchor'
  | 'evidence'
  | 'clock'
  | 'validity'
  | 'binding'
  | 'resource'
  | 'link'
  | 'rollback'
  | 'order'
  | 'generation'
  | 'key-reuse'
  | 'fork'
  | 'already-enrolled'
  | 'unenrolled'
  | 'continuity'
  | 'unavailable'
  | 'retryable'
export interface DirectoryStore {
  /** Prepare a continuity expectation before writing the exact anchor's signed record. */
  checkpointForEnrollment(
    candidate: Candidate,
    now: Timestamp,
  ): Promise<Checkpoint>
  enroll(candidates: readonly Candidate[], context: Context): Promise<Current>
  advance(candidates: readonly Candidate[], context: Context): Promise<Current>
  current(context: Context): Promise<Current>
  historicalEvidence(hash: Uint8Array): Promise<HistoricalEvidence | null>
  conflictEvidence(): Promise<HistoricalEvidence[]>
  status(): Promise<Status | null>
  close(): Promise<void>
}
