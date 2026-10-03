# Disposable directory trust fixture

The provisioning facade `./index.ts` supplies **public trust inputs and synthetic
signed evidence only**; it never admits a directory or returns a usable head.
The separate #750 consumers `./admission.ts` and `./browser-admission.ts` perform
explicit demo-only admission through the public #748/#749 facades. Normal demo
routes, writers, DM and app behavior are unchanged without explicit selection.

## Opt-in admission integration

`openDemoNodeAdmission` requires a retained bundle reference, independently
installed public inputs, dedicated absolute Level location, separate continuity
file, explicit `new`/`reopen` intent and bigint nanosecond time. Every fresh call
first checks the real pinned HTTPS fixture through `checkNode`, then invokes the
public admission facade. `enroll` requires both the separately supplied exact
type4 and the fixture's exact signed type2. `advance` and `current` require fresh
explicit time; results are point-in-time, not cached routing permissions.
Both writable state paths must resolve outside the immutable trust-bundle
directory; continuity must also remain outside the admission rollback directory.
Invalid placements are rejected before creating either artifact, including
placements reached through a symlinked parent.

Input byte views are cumulatively bounded before copying, including shared-buffer
views. Signed history authentication, generations, no-reuse, fork quarantine and
durable acceptance remain owned by the admission packages, not these adapters.
Historical methods retain their historical-only types.

The versioned public continuity file pins manifest identity, complete installed
tuple, enrollment intent and the **whole** facade checkpoint. A prospective
checkpoint is synced outside the Level directory before first enrollment; a
committed-prefix checkpoint is synced after acceptance and before any usable
result is returned. Replacement uses a synced temporary file, rename and parent
barrier. Save failure exposes no result and requires explicit close/reopen from
the last durable prefix. A verified descendant may recover lost acknowledgement;
missing/corrupt state never becomes a fresh enrollment. Artifacts are preserved,
including incomplete public configuration after failure; no reset or disposal is
automatic. This is not full-disk rollback protection or secret custody.

The launcher accepts a separate mode:

```sh
yarn workspace @frank/bot demo --directory-admission /absolute/public-config.json
```

The bounded JSON file must have `mode: "synthetic-directory-admission"`, explicit
`intent: "new" | "reopen"`, decimal `nowNs`, `bundle: {runDir, manifestIdentity}`,
complete `installed` trust inputs (JSON expiry is decimal), `location`, and
`continuityFile`. New enrollment additionally requires lowercase exact
`statementHex`. `participants` must contain independently installed matching
`relay-a`, `relay-b`, and `bot` tuples. Any missing/mismatched participant leaves
the complete configuration unselected; there is no cross-database atomicity
claim. The mode starts only its owned fixture, admits/reopens through the Node
facade, reports the point-in-time head and closes its own resources. It neither
starts nor reconfigures the normal relay/bot stack. The topic wire remains
protobuf until its separately owned cutover.

Actual UI-created/recovered P and exact revision-zero T1 can occupy this public
configuration shape; they are never derived from the witness. These synthetic
tests do not substitute for actual UI export/enrollment proof. #774 owns real
authenticated publication/resolution; #778/#780 and later #696 consumers own
the actual UI/game/two-relay continuation. #258 remains held.

`openDemoBrowserAdmission` uses the public strict IndexedDB facade at the exact
controlled fixture origin. Its caller saves whole continuity records outside
that database; the owned runner acknowledges saves in the controlling Node
process before admission can return. `check-admission-browser.cjs` source-builds
the browser consumer, runs strict Node preflight, launches only an isolated
profile with the unique fixture leaf-SPKI exception, and reuses that profile for
browser restart. It is not general browser PKI. Same-key recertification is
caught by Node exact-certificate preflight, not claimed as browser detection.
The existing #758 certificate-negative and lifecycle gates remain required.
The browser adapter requires an exclusive Web Lock named
`frank-demo-directory-continuity-owner:v1` for its entire lifetime. The key is
origin-wide, independent of database name or installed trust: only one demo
admission/continuity writer may be active at that fixture origin. Unavailable
ownership fails closed. Close drains queued operations and external saves, then
releases ownership only after the public store closes successfully; failed close
retains it for explicit retry. Failed opening releases ownership. The runner is
the sole external checkpoint-file writer. Sharing a saver across origins,
profiles or independent controller processes is unsupported; this is not a
general cross-process persistence or enrollment framework.

The focused adapter Jest suite always runs real Node TLS and Level gates. Set
`DIRECTORY_ADMISSION_CHROMIUM` to an absolute executable for the separately
leased real-browser gate; an unset variable is an explicit skip, never a pass.
Tests sign fresh local-tuple evidence using disposable published keys; frozen
shared vectors are read-only. Process restart is not machine power-loss proof.

The example `backend/cashweb/cashweb-registry/examples/directory_trust_probe.rs`
consumes a validated **public** bundle snapshot and independently installed trust,
not private fixture files. Its sole argument is an absolute bounded JSON scenario
with `bundle`, retained `manifestIdentity`, `installed`, decimal `nowNs`, dedicated
absolute `location`, external `continuityFile`, explicit `mode: "new" | "reopen"`
and `candidates: [{statement, attestation}]` containing exact lowercase frame hex.
The bundle's JSON binding expiry is also decimal. New mode requires both paths
absent; reopen requires the full saved continuity and existing registry. An empty
reopen batch calls `current`. Only a durably accepted fresh result reaches stdout;
errors emit a bounded code and exit nonzero. Native continuity uses the public
Rust checkpoint serialization, not a shared on-disk format with the TS adapter.

The example-only pinned `native-tls` dependency uses a per-instance explicit CA,
normal hostname/expiry checks, and exact leaf-certificate digest on the same
connection before the bounded fixed HTTPS request. It does not change production
TLS, system roots, the admission policy or registry storage. Set
`DIRECTORY_ADMISSION_RUST_PROBE` to the absolute built example executable to enable
the Node/Rust exact-result, process-reopen, trust/TLS and quarantine comparison.
An unset variable is an explicit skip. Compile and run this gate only under the
same heavy-test lease as Chromium; the adapters are not production routes.

## Explicit inputs and public facade

`initBundle({ mode: 'synthetic-demo', runDir, trustInputs, nowNs, witnessHex? })`
requires every trust input independently from the caller:

- `network`: explicit canonical codec network, such as `monad-testnet`, never
  inferred from the legacy `MONT` label.
- `subject`: compressed key-type-1 secp256k1 point P, lowercase hex.
- `rev0T1`: exact complete revision-zero type-4 frame's 32-byte T1, lowercase hex.
- `relayId`: supplied 16-byte synthetic relay ID, lowercase hex; no URL hash.
- `relayIdentity: { keyType: 1, point }`: explicit compressed identity point.
- `endpoint`: exactly `https://127.0.0.1:<port>` with canonical decimal port 1–65535.
  No trailing slash, DNS, userinfo, query, fragment, or implicit port.
- `bindingExpiryNs`: bigint nanoseconds, strictly greater than caller `nowNs`.

`nowNs` is a required bigint for every operation. This utility supplies no clock.
A test clock is synthetic, not a trusted real-world time source. JSON boundaries
use canonical unsigned decimal strings, never JavaScript numbers. `parseTrust`
converts the JSON expiry; validation occurs at the provisioning boundary.

An optional `witnessHex` is verified by the active `@frank/codec` facade against
the independently supplied network/P/T1, revision zero, zero role generations,
and null predecessor. Historical expired signed evidence is allowed because it
is not returned as a usable head. Tests read the reviewed synthetic `bootstrap`
record from `docs/protocol/cbor/vectors/directory-preview.json`; they independently
pin its expected P and T1. The witness's historical relay URL is not authority
for this local fixture. The caller separately supplies the synthetic local tuple.

The result has kind `synthetic-directory-trust-inputs`, `trustInputs`, optional
`witnessHex`, public `tls` material, `runDir`, and `manifestIdentity`. Retain that
exact manifest digest independently. It is required for:

```ts
const reopened = reopenBundle({ runDir, manifestIdentity }, nowNs)
const fixture = await startFixture(reopened, nowNs)
try {
  await checkNode(reopened, nowNs)
  await checkBrowser(reopened, nowNs, absoluteChromiumExecutable)
} finally {
  await fixture.stop()
}
disposeBundle(reopened, nowNs)
```

No private keys are returned. The public result is configuration, not a
`verified` flag, accepted directory, routing grant, provider registration or
authenticated history. #748/#749 retain all admission/history obligations.

## Artifact and restart

Choose a new absolute run directory whose basename starts `directory-trust-`,
under an existing parent, outside `.frank-demo`. Init refuses even an empty
existing directory. It creates mode 0700 state with mode 0600 files:

| File                 | Meaning                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`      | Immutable local format `frank-synthetic-directory-trust-v1`; exact public inputs, initial clock, optional witness, TLS file digests, leaf DER SHA-256 and leaf SPKI SHA-256 |
| `clock`              | Last checked caller nanosecond value                                                                                                                                        |
| `ca.pem`, `leaf.pem` | Disposable public CA and leaf certificates                                                                                                                                  |
| `ca.key`, `leaf.key` | Separate private TLS keys; never print or publish                                                                                                                           |

The format is local tooling, not a Frank protocol allocation. #750 can consume
the explicit inputs through the index without migrating them into admitted
state here. No provider or storage framework is introduced.

Reopen checks the retained manifest digest, file identity, permissions, keys,
clock monotonicity and binding expiry. It never regenerates missing state.
The immutable digest does not advance with the clock. These checks are local
configuration continuity, not full-disk rollback protection; a caller still
owns independent continuity and trusted time. TLS certificate wall-clock
validity is a separate check performed on each Node TLS connection.

`.operation` serializes file operations; `.listener` reserves a listener owner.
Stop closes owned sockets and releases that reservation, retaining the bundle.
Dispose requires a valid, unexpired bundle and refuses a running listener,
symlinks, unrelated contents and broad paths. It unlinks only the six exact
validated artifact files and then the empty directory. Neighbor state survives.
Failed provisioning removes only its newly created known files. SIGKILL or a
crash can leave incomplete files or stale leases; reopen fails closed. There is
no automatic stale-lock removal, reset, repair, or re-anchor command.

## Transport boundaries

Installed OpenSSL generates a fresh RSA CA and a unique RSA leaf with
`subjectAltName=IP:127.0.0.1`. Arguments are arrays; key contents never enter argv
or logs. Certificate generation is bounded to ten seconds per subprocess.
Only the exact requested port is bound; a conflict fails. The listener serves
GET `/fixture/health`, `/fixture/evidence`, and `/fixture/proof`. Other routes,
methods and Host values fail. There are no enrollment or production routes.

Node uses a private explicit-CA agent, standard chain/hostname/expiry validation,
and exact leaf DER and SPKI pins. Redirects, response tuple mismatches, overlarge
responses and timeouts fail. Connections and TLS sessions are not reused. No
global TLS setting or system trust store is changed.

Chromium is a **limited synthetic transport proof**, not general browser PKI.
A strict Node check must succeed first. Each launch owns a fresh temporary
profile and process group; it reaps only that group and removes its profile.
The proof page fetches only the exact evidence URL with redirects rejected,
checks the full independently provisioned tuple/evidence, and emits a checked
DOM marker. CSP confines scripts and connections; there are no links, forms,
external resources, redirects or arbitrary navigation inputs. Missing Chromium,
an interstitial, blank output or an aborted process is a nonzero failure.
Negative certificate proofs additionally require a sanitized Chromium certificate
network-error code and zero HTTP requests, paired with a reachable correct-pin
control. Timeout alone does not satisfy those negative tests. Raw browser logs
are discarded; only the bounded certificate error code is reported.

The sole leaf `--ignore-certificate-errors-spki-list` entry is a Chromium
certificate-verification bypass. Chromium matches SPKI anywhere in the chain;
it is not enforce-only pinning, and otherwise publicly trusted certificates can
still validate. It does not establish hostname, expiry or exact-certificate
identity. Same-key reissued certificates cannot be distinguished by that flag;
the strict Node preflight rejects them by exact certificate digest. This is why
the harness uses only a unique disposable leaf and controlled loopback pages.
Never reuse the profile or flag for ordinary browsing or runtime admission.
See [Chromium's verifier](https://chromium.googlesource.com/chromium/src/+/main/services/network/ignore_errors_cert_verifier.cc)
and [Node's HTTPS pinning example](https://nodejs.org/download/release/latest-jod/docs/api/https.html).

## CLI and local proof

From the repository root, with the existing workspace dependencies installed:

```sh
TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx \
  packages/bot/demo/directory-trust/cli.ts init /absolute/input.json
```

Init input contains `mode`, `runDir`, the complete `trustInputs` object, `nowNs`
and optional `witnessHex`, using decimal strings for nanoseconds. Other commands
(`reopen`, `serve`, `check-node`, `check-browser`, `dispose`) take an input JSON
file containing `runDir`, retained `manifestIdentity` and `nowNs`; browser checks
also require `chromium`, an absolute executable path. `serve` retains its owned
listener until SIGINT/SIGTERM, then closes it. Browser cancellation terminates
its exact spawned process group. No command reads trust from environment or a
home profile. Provision before starting a listener; stop before explicit dispose.

Required local gates (browser tests must run with the shared heavy-test lease):

```sh
yarn workspace @frank/bot test --runInBand demo/directory-trust
DIRECTORY_TRUST_CHROMIUM='/absolute/path/to/chromium' \
  yarn workspace @frank/bot test --runInBand demo/directory-trust
node_modules/.bin/tsc -p packages/bot/demo/directory-trust/tsconfig.json
node_modules/.bin/prettier --config app/.prettierrc.json --check \
  packages/bot/demo/directory-trust
```

The first command explicitly skips browser tests; that alone is not a browser
pass. Real-browser proof logs Node, Chromium and OpenSSL versions. TLS negative
tests require OpenSSL's `x509 -not_before/-not_after` support for an actually
expired certificate. Required negatives cover wrong CA, leaf, SAN, expiry,
endpoint, redirect, relay tuple, same-key reissue, missing tools, no/wrong browser
pin and unrelated certificate. Lifecycle tests cover real restart, failure,
signals, socket closure, exclusive leases and neighboring process/state survival.
CI remains unchanged. #758's provisioning and transport facade remains separate
from these additive #750 admission consumers. Deselecting the opt-in mode leaves
normal demo behavior intact and preserves trust, admission and continuity
artifacts. These consumer proofs do not complete #774's runtime publication or
the later actual UI/game/two-relay acceptance obligations.
