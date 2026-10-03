# Directory admission

`@frank/directory-admission` is an opt-in browser/Node owner of authenticated,
bounded preview directory history. It changes no app, bot, wallet, codec default,
route, publication or message consumer. It stores public evidence only.

Use `@frank/directory-admission/browser` or `@frank/directory-admission/node`.
The root entry exports types only. Each explicitly named database belongs to
one installed `(network, P, revision-zero T1)` anchor. The browser entry has no
Node modules or Level dependency in its bundle.

```ts
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import type {
  Anchor,
  Candidate,
  Checkpoint,
  Context,
} from '@frank/directory-admission'

async function enrollContact(
  name: string,
  installedAnchor: Anchor,
  signedHistory: Candidate[],
  trustedContext: Context,
  saveExternalCheckpoint: (checkpoint: Checkpoint) => Promise<void>,
) {
  if (!trustedContext.now) throw new Error('Trusted time is required')
  const store = await openBrowserDirectoryStore({
    name,
    anchor: installedAnchor,
    mode: { kind: 'new' },
  })
  try {
    // Save the expectation outside this database's rollback domain before writing.
    const prospective = await store.checkpointForEnrollment(
      signedHistory[0],
      trustedContext.now,
    )
    await saveExternalCheckpoint(prospective)
    const current = await store.enroll(signedHistory, trustedContext)
    await saveExternalCheckpoint(current.status.checkpoint)
    return {
      exactStatement: current.evidence.statement,
      statementT1: current.evidence.hash,
      messageKey: current.messageKey,
      stampKey: current.stampKey,
    }
  } finally {
    await store.close()
  }
}
```

The caller authenticates the anchor and relay tuple, supplies trusted nanosecond
time on **every** fresh operation, retains external continuity, and remembers
new versus reopen intent. This package fetches nothing and supplies no defaults.
Track that intent by network/P even if a database name or location changes;
a new namespace is not permission to reenroll an existing subject or reset caps.
For subsequent use, reopen with `{ kind: 'reopen', checkpoint }` and call
`current` with fresh context. A result is a point-in-time snapshot; it is not
permission to route or send indefinitely. `historicalEvidence` and `status`
never grant freshness authority.

The Node opener replaces `name` with an absolute dedicated `location`; its
parent directory must already exist. `new` refuses an existing namespace.
`reopen` requires existing, enrolled, fully validated state and a checkpoint.
Neither mode resets unknown/corrupt data. Interrupted creation can leave an
unusable empty namespace; disposal or choosing a genuinely new namespace is an
external decision, never automatic reenrollment.

See [the client protocol and persistence contract](../../docs/protocol/directory-preview-client-admission.md)
for checkpoint kinds, transaction semantics, error recovery and trust limits.

## Gates

- `yarn workspace @frank/directory-admission typecheck`
- `yarn workspace @frank/directory-admission test`: shared policy/facade
- `yarn workspace @frank/directory-admission test:node`: native Level processes
- `yarn workspace @frank/directory-admission test:browser`: real Chromium
- `yarn workspace @frank/directory-admission test:resources`: actual signed retained-history caps
- `yarn workspace @frank/directory-admission check:boundary`
- `yarn workspace @frank/directory-admission format`

Browser tests require Chrome/Chromium (set `FRANK_CHROME` when discovery cannot
find it); a missing browser is a failure, not a simulated pass. Test fixtures
are synthetic offline public identities, not trust provisioning examples.
