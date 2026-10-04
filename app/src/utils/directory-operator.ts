/**
 * Operator-side construction of the public local/demo directory files (#778).
 *
 * Pure public data: a bootstrap policy before any account exports, and the approved bundle plus
 * each relay's native `registry.directory` principals after the operator has checked the UI and
 * bot exports. Nothing here contacts a process or grants trust; the operator installs the output
 * into both relays, the bot and the app deployment by hand. Used by `scripts/directory-operator.mts`.
 */
import { encodeCanonical, fromHex, toHex, type Encodable } from '@frank/codec'
import { sha256 } from '@frank/crypto-box'
import {
  bundleIdentity,
  configurationIdentity,
  expectedConfiguration,
  parseApprovedPolicy,
  parseBootstrapPolicy,
  type ApprovedPolicy,
  type BootstrapPolicy,
  type Subject,
} from './directory-provisioning'
import type { PublicExportFile } from './directory-readiness'

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))
const map = (values: Encodable[]): Encodable =>
  new Map(values.map((value, i) => [i, value]))

/** Ordinary comparator over every policy field except the identity itself. No authority. */
export function bootstrapPolicyIdentity(
  policy: Omit<BootstrapPolicy, 'policyIdentity'>,
): string {
  const byId = <T extends { processId: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.processId < b.processId ? -1 : 1))
  return toHex(
    sha256(
      encodeCanonical(
        map([
          policy.version,
          policy.kind,
          policy.networkTag,
          policy.network,
          policy.chainId,
          byId(policy.participants).map(p =>
            map([p.processId, p.origin, p.trustReference]),
          ),
          byId(policy.relayTuples).map(t =>
            map([
              t.processId,
              fromHex(t.id),
              t.endpoint,
              fromHex(t.key),
              t.expiryNs,
            ]),
          ),
          map([
            policy.exportValidity.issuedAtNs,
            policy.exportValidity.expiresAtNs,
          ]),
        ]),
      ),
    ),
  )
}

export function buildBootstrapPolicy(
  input: Omit<BootstrapPolicy, 'policyIdentity' | 'version' | 'kind'>,
): BootstrapPolicy {
  const body = {
    version: 1 as const,
    kind: 'directory-bootstrap-process-policy' as const,
    ...input,
  }
  // Round-trip through the app's own strict parser: the operator cannot emit what it rejects.
  return parseBootstrapPolicy(
    encode({ ...body, policyIdentity: bootstrapPolicyIdentity(body) }),
  )
}

/** Approve exactly one UI export and one bot export made against `policy`. */
export function buildApprovedBundle(
  policy: BootstrapPolicy,
  exports: { ui: PublicExportFile; bot: PublicExportFile },
): ApprovedPolicy {
  const checked = parseBootstrapPolicy(encode(policy))
  if (
    bootstrapPolicyIdentity(checked) !== checked.policyIdentity ||
    checked.policyIdentity !== policy.policyIdentity
  )
    throw new Error('Bootstrap policy identity mismatch')
  const subject = (role: 'ui' | 'bot', file: PublicExportFile): Subject => {
    if (
      file.version !== 1 ||
      file.kind !== 'public-revision-zero-export' ||
      file.bootstrapPolicyIdentity !== checked.policyIdentity ||
      file.networkTag !== checked.networkTag ||
      file.network !== checked.network ||
      file.chainId !== checked.chainId
    )
      throw new Error(`The ${role} export was not made for this policy`)
    const tuple = checked.relayTuples.find(
      t => t.processId === file.homeProcessId,
    )
    if (!tuple) throw new Error(`The ${role} export names an unknown relay`)
    return {
      role,
      network: file.network,
      subjectP: file.subjectP,
      revisionZeroT1: file.revisionZeroT1,
      statement: file.statement,
      attestation: file.attestation,
      homeProcessId: file.homeProcessId,
      relay: {
        id: tuple.id,
        endpoint: tuple.endpoint,
        key: tuple.key,
        expiryNs: tuple.expiryNs,
      },
    }
  }
  const subjects = [
    subject('ui', exports.ui),
    subject('bot', exports.bot),
  ].sort((a, b) =>
    a.network < b.network ||
    (a.network === b.network && a.subjectP < b.subjectP)
      ? -1
      : 1,
  )
  const draft: ApprovedPolicy = {
    version: 1,
    kind: 'operator-approved-directory-bundle',
    bootstrapPolicyIdentity: checked.policyIdentity,
    participants: checked.participants,
    subjects,
    bundleIdentity: '',
    expectedConfigurationIdentity: '',
  }
  draft.bundleIdentity = bundleIdentity(draft)
  draft.expectedConfigurationIdentity = configurationIdentity(
    expectedConfiguration(draft),
  )
  // The strict parser verifies both signed frames, revision zero, tuples and both identities.
  return parseApprovedPolicy(encode(draft))
}

/**
 * Native `registry.directory` section for one relay process. Every relay installs the complete
 * subject set. `stateDir` holds that process's continuity files and must be outside its database
 * and outside `bundleRoot`; `mode` is `new` only for a first installation of these subjects.
 */
export function relayDirectoryToml(
  approved: ApprovedPolicy,
  paths: { clockFile: string; stateDir: string; bundleRoot: string },
  mode: 'new' | 'reopen',
): string {
  const text = (value: string) => JSON.stringify(value)
  const lines = [
    '[registry.directory]',
    `clock_file = ${text(paths.clockFile)}`,
    '',
  ]
  for (const p of expectedConfiguration(approved).principals)
    lines.push(
      '[[registry.directory.principals]]',
      `network = ${text(p.network)}`,
      `subject = ${text(p.subjectP)}`,
      `revision_zero = ${text(p.revisionZeroT1)}`,
      `manifest_identity = ${text(p.manifestIdentity)}`,
      `relay_id = ${text(p.relayId)}`,
      `relay_identity = ${text(p.relayIdentity)}`,
      `endpoint = ${text(p.endpoint)}`,
      `binding_expiry_ns = ${text(p.bindingExpiryNs)}`,
      `continuity_file = ${text(
        `${paths.stateDir}/continuity-${p.subjectP}.json`,
      )}`,
      `bundle_root = ${text(paths.bundleRoot)}`,
      `mode = ${text(mode)}`,
      '',
    )
  return lines.join('\n')
}
