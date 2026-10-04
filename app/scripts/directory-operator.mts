/**
 * Local/demo operator tool for #778. Public data only; it contacts nothing and installs nothing.
 *
 *   npx tsx --tsconfig packages/bot/tsconfig.json app/scripts/directory-operator.mts policy <input.json> <out/bootstrap-policy.json>
 *   npx tsx --tsconfig packages/bot/tsconfig.json app/scripts/directory-operator.mts approve <bootstrap-policy.json> <ui-export.json> \
 *       <bot-export.json> <out-dir> <relay-state-dir> [new|reopen]
 *
 * `policy` input: { networkTag, network, chainId, validSeconds (<= 3600), participants: [{processId,
 * origin, trustReference}] x3, relayTuples: [{processId, id, endpoint, key, expirySeconds}] x2 }.
 * Validity starts at this machine's clock. `approve` writes approved-bundle.json plus one native
 * `registry.directory` TOML section per relay; the operator reviews and installs each by hand.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseBootstrapPolicy } from '../src/utils/directory-provisioning'
import {
  buildApprovedBundle,
  buildBootstrapPolicy,
  relayDirectoryToml,
} from '../src/utils/directory-operator'

const [command, ...args] = process.argv.slice(2)
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
if (command === 'policy' && args.length === 2) {
  const input = json(args[0])
  const now = BigInt(Date.now()) * 1_000_000n
  const policy = buildBootstrapPolicy({
    networkTag: input.networkTag,
    network: input.network,
    chainId: input.chainId,
    participants: input.participants,
    relayTuples: input.relayTuples.map(
      (tuple: Record<string, string> & { expirySeconds: number }) => ({
        processId: tuple.processId,
        id: tuple.id,
        endpoint: tuple.endpoint,
        key: tuple.key,
        expiryNs: (
          now +
          BigInt(tuple.expirySeconds) * 1_000_000_000n
        ).toString(),
      }),
    ),
    exportValidity: {
      issuedAtNs: now.toString(),
      expiresAtNs: (
        now +
        BigInt(input.validSeconds) * 1_000_000_000n
      ).toString(),
    },
  })
  writeFileSync(args[1], JSON.stringify(policy, null, 2) + '\n')
  console.log(`policy ${policy.policyIdentity} -> ${args[1]}`)
} else if (command === 'approve' && (args.length === 5 || args.length === 6)) {
  const policy = parseBootstrapPolicy(readFileSync(args[0]))
  const mode = args[5] ?? 'new'
  if (mode !== 'new' && mode !== 'reopen') {
    console.error(`mode must be "new" or "reopen", got "${mode}"`)
    process.exit(64)
  }
  const approved = buildApprovedBundle(
    policy,
    { ui: json(args[1]), bot: json(args[2]) },
    BigInt(Date.now()) * 1_000_000n,
  )
  const out = resolve(args[3]),
    state = resolve(args[4])
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'approved-bundle.json'),
    JSON.stringify(approved, null, 2) + '\n',
  )
  for (const relay of ['relay-a', 'relay-b'])
    writeFileSync(
      join(out, `${relay}.directory.toml`),
      relayDirectoryToml(
        approved,
        {
          clockFile: join(state, relay, 'clock'),
          stateDir: join(state, relay, 'continuity'),
          bundleRoot: join(state, relay, 'bundle'),
        },
        mode,
      ),
    )
  for (const subject of approved.subjects)
    console.log(
      `${subject.role} P=${subject.subjectP} rev0=${subject.revisionZeroT1} home=${subject.homeProcessId}`,
    )
  console.log(`bundle ${approved.bundleIdentity}`)
  console.log(`configuration ${approved.expectedConfigurationIdentity}`)
} else {
  console.error(
    'usage: directory-operator.mts policy|approve ... (see file header)',
  )
  process.exit(64)
}
