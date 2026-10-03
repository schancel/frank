# Disposable directory trust fixture

This opt-in Node utility provisions **public trust inputs and synthetic signed
evidence only** for the later #750 integration. It does not admit directory state,
return a usable head, configure a runtime consumer, or start the normal demo.
The stable consumer surface is `./index.ts`. No runtime imports this module.

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
CI remains unchanged. The base has no prior implementation; proof is the new
facade and positive/negative transport/lifecycle evidence, not an invented
fail-before claim. Reversal before any future consumption is deleting these
ten additive files. Integration and runtime proof remain #750's responsibility.
