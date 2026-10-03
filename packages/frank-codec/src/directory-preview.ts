// Provisional #719/#742 allocation. This facade returns signed structure, never trusted state.
import { FrankCodecError, FrankContextError } from './errors'
import { contentHash, directorySignatureDigest } from './hash'
import type {
  AccountRef,
  DirectoryStatement,
  ParsedFrame,
  PreviewDirectoryRoles,
  Timestamp,
} from './types'
import { defaultContext, validateFrame, ValidationContext } from './validate'
import { verifyDirectoryAttestation } from './verify'

/** Explicit opt-in; defaults used by existing runtime routes remain reader 2/schema 3. */
export function previewDirectoryContext(): ValidationContext {
  const ctx = defaultContext()
  return {
    ...ctx,
    readerVersion: 4,
    supportedSchemas: ctx.supportedSchemas.map(s =>
      s.typeId === 4 ? { ...s, schemaVersion: 4 } : s,
    ),
  }
}

/** Required typed roles in the allocated projection, including future optional retention. */
export interface PreviewDirectoryStatement
  extends DirectoryStatement<ParsedFrame> {
  stampKey: AccountRef
  expiry: Timestamp
  preview: PreviewDirectoryRoles
}

/** Cryptographic evidence only: does not authorize routing, DM, or persistence as a head. */
export interface PreviewDirectoryEvidence {
  kind: 'preview-directory-signed-evidence'
  attestationFrame: ParsedFrame
  statementFrame: ParsedFrame
  statement: PreviewDirectoryStatement
  /** T1 of the exact complete type-4 frame, never the type-2 wrapper. */
  statementHash: Uint8Array
  signatureDigest: Uint8Array
}

/**
 * Check canonical structure, role semantics, explicit network and the exact T2 subject signature.
 * Caller must separately enforce anchors, clock/freshness, authenticated relay binding,
 * contiguous history/generations/no-reuse, cumulative budgets, forks and atomic head acceptance.
 */
export function verifyPreviewDirectoryEvidence(
  bytes: Uint8Array,
  network: string,
): PreviewDirectoryEvidence {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(network))
    throw new FrankContextError(
      'an explicit valid expected network is required',
    )
  const ctx = previewDirectoryContext()
  ctx.routeByteLimit = 262_144
  const result = validateFrame(bytes, ctx)
  if (
    result.kind !== 'parsed' ||
    result.typed?.type !== 2 ||
    result.typed.statementFrame.typed?.type !== 4 ||
    !result.typed.statementFrame.typed.preview
  )
    throw new FrankCodecError(
      'unsupported',
      '7',
      'expected a preview directory attestation',
      'root',
    )
  const statementFrame = result.typed.statementFrame
  const statement = statementFrame.typed as PreviewDirectoryStatement
  if (statement.network !== network)
    throw new FrankCodecError(
      'semantic',
      '9',
      'directory network differs from expected network',
      'root/payload.0',
    )
  verifyDirectoryAttestation(result.typed)
  return {
    kind: 'preview-directory-signed-evidence',
    attestationFrame: result,
    statementFrame,
    statement,
    statementHash: contentHash(statementFrame),
    signatureDigest: directorySignatureDigest(network, statementFrame.frame),
  }
}
