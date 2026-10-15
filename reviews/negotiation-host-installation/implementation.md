# Installed negotiation recovery candidate

Contract: `contract.md`, base `5100b241ae6bf8337124071fdb279c0c5601688f`, contract digest `f6efa07d`. Tier 3. Parent owns independent review and integration.

## Result and ownership

The app's admitted messaging session installs swap recovery after directory installation. The bot host installs it after owner/wallet admission and cleans it on partial registration and shutdown. Each host captures its canonical messaging chain, signing public key, stable account incarnation and fixed testnet policy. Other networks and absent scanners expose unsupported capability without disabling ordinary messaging.

The new swap runtime owns context derivation, signed journal admission, derived public inspection and its own scan task. Existing qualified storage remains the sole durable journal/coverage owner. Raw rows retained in memory are a derived inspection view rebuilt by storage reads; public inspections reconstruct copied evidence and reductions. Ordinary chat history, bot inbound operations, financial recovery and wallet inventory are unchanged. No outgoing offer/response signing or financial automation is installed.

Only direct original authenticated scanner items enter admission. Canonical original UUID identities are decoded to their 16-byte representations, and the stamped outer digest is required. Response parties are bound by the authenticated role and original conversation, permitting response-before-offer replay. Nested self-outbox items remain inert. Journal validation retains equivocation evidence and removes usable acceptance on violations.

The runtime commits only scanner-qualified inclusive coverage after all applicable admissions. Capacity, ambiguous storage acknowledgment and corruption remain visible and pin coverage. Retry closes/reopens under the captured owner. Lost coverage CAS reads the committed winner. Stop synchronously revokes admission/publication and timers, drains already owned storage operations and closes without awaiting network scans. Network scans have a separate 30-second timeout; retries run at 3/6/12/24/48/60 seconds, with normal cadence 3 seconds. No ordinary mailbox cursor is lowered or read by the feature.

App status is exposed through `negotiationRecoveryStatus` and a localized composed indicator independent of ordinary mailbox success. Bot status is exposed through `FrankBotHost.negotiationStatus`; diagnostics log only bounded state names and retention/cleanup guidance.

Persisted/wire scope: no schema or wire change. Existing journal/coverage formats and qualified adapters are reused. The explicitly specified `app-v1-`/`bot-v1-` incarnation encodings and `app`/`bot` discriminators choose namespaces; there is no migration, reset, key access or deletion. Golden tests pin the exact incarnation digests.

## Evidence matrix

Commands run from candidate root unless noted. Logs are local review artifacts in `/tmp`, not permanent architecture claims.

| Boundary | Command | Result / log |
| --- | --- | --- |
| All configured projects | `node --import tsx scripts/typecheck.ts --fast` | 25/25 pass; `/tmp/negotiation-host-typechecks-frozen.log` |
| Full swap protocol and real native qualification | `node_modules/.bin/jest --config packages/swap-protocol/jest.config.cjs --runInBand` | 11 suites, 122 tests pass before final extra conversation regression; `/tmp/negotiation-host-swap-final.log` |
| Final changed runtime, identity and dependency boundary | `node_modules/.bin/jest --config packages/swap-protocol/jest.config.cjs --runInBand runtime host-identity` | 3 suites, 11 tests pass; `/tmp/negotiation-host-feature-frozen2.log` |
| App construction/session/polling/rendering | From `app`: `node ../node_modules/jest/bin/jest.js --config test/jest/accounts.config.cjs --runInBand negotiation-recovery monad-identity-session MailboxStatusIndicator pinia-chain-adapter.polling` | 4 suites, 64 tests pass; `/tmp/negotiation-host-app-final2.log` |
| Locale completeness/parity with app gates | Same app command with `locale-completeness parity` | 7 suites, 1012 tests pass; `/tmp/negotiation-host-app-final.log` |
| Full existing bot host suites | `node_modules/.bin/jest --config packages/bot-framework/jest.config.js --runInBand bot-host` | 6 suites, 121 tests pass before final capacity regression; `/tmp/negotiation-host-bot-final.log` |
| Final actual bot installation regressions | `node_modules/.bin/jest --config packages/bot-framework/jest.config.js --runInBand bot-host-reliability` | 31 tests pass, including second-page capacity and ordinary dispatch; `/tmp/negotiation-host-bot-frozen2.log` |
| Real Chrome qualified browser storage | `node packages/swap-protocol/src/storage/browser-test.mjs` | Pass; `/tmp/negotiation-host-browser.log` |
| Pure headless dependency direction | `runtime-boundary.jest.test.ts` in final runtime gate | Browser bundle excludes wallet/cashweb/bot/UI/native storage and Node built-ins |
| Formatting | Scoped Prettier checks for new swap files (single quotes/no semicolons/trailing commas), changed app sources and new bot composition | Pass; source styles match owning directories |
| Whitespace | `git diff --check` | Pass |

Regression evidence includes signed offer/response reconstruction, exact duplicate replay, original outbound provenance, distinct same-peer conversations, missing identities, nested outbox rejection, ambiguous durable admission/reopen, capacity, corrupt inventory, lost coverage CAS, no progress/truncated pages, stop during owned write, hanging and late scans, replacement status ownership, copied inspection bytes and golden stable identity. Actual app construction is exercised with the real native qualified store substituted at the browser factory; the browser adapter is separately qualified in real Chrome. The actual app poller delivers a later receipt and reaches cursor 101 while feature admission remains failed; presentation deletion/restart replays feature coverage zero and admits the earlier signed event. Real session wiring independently tests startup and retained cleanup.

Actual bot registration tests old never-dispatched history plus signed negotiation, new ordinary handler dispatch, native persisted discovery after restart, two feature pages with capacity pinning, and a hanging feature scan that permits ordinary polling and shutdown. Existing bot host reliability suites retain coverage of ordinary scan-floor/deferred recovery.

## Compression and limits

Compression retained the named admission/inspection seam, reused public plugin/schema and journal reducers, avoided a DI framework, and kept scheduling in the feature task. No scanner or storage production source changed. No dependencies were installed; candidate-owned overlay scopes point workspace names to candidate sources, with external installed dependency symlinks and wallet-local Chronik 4.3.1 retained.

All fixtures are synthetic local keys, Level namespaces or owned browser/loopback profiles. No live relay/provider, credentials, messages, funds, email, deployment or push was used. Host behavior is proven at construction and local scheduling/presentation boundaries, not through live network traffic or an end-user deployed browser session. Outgoing semantic decisions and their reachable proposal/accept UI remain a successor; public evidence is not spending authority. Zero coverage never proves availability before relay retention.

Requested lane/model: GPT-6.1 Sol medium. The worker runtime does not expose independently verifiable selected model metadata; requested configuration is parent-reported, not an attested runtime observation.

## Confirmed lifetime repair: NH-LIFETIME-1

Parent independent review and a separate verifier reproduced overlapping underlying scans on candidate `b3f5d140e58ac78b5d97822d35aff22ed78b7fac`: a never-settling first request survived its 30-second pass timeout, and 3-second/6-second retries launched more unresolved requests. The previous review is superseded for the changed candidate.

The runtime now tracks the outstanding scanner promise separately from the pass. A timeout still publishes `incomplete` and schedules bounded retry, but any retry while that promise is pending performs no new scan or storage restoration. Either late settlement clears the outstanding request and observes its rejection; its result is never admitted or used as coverage. The next scheduled retry reads the original durable position and starts a fresh request. Stop/replacement still revoke synchronously and never wait for the outstanding scanner. Scanner interfaces, request cancellation, storage, host composition and ordinary polling are unchanged.

Deterministic scheduler regressions fire the 30-second timeout followed by 3-second and 6-second retries and assert exactly one underlying scan. Separate late-success and late-rejection cases then permit a fresh retry at unchanged coverage zero; the late signed offer and proposed position 999 remain inert. A stop/replacement case checks canceled timers, cleanup without network settlement, successful replacement progress and observed late rejection with no old publication.

Fail-before proof: all three new cases fail against the exact prior committed runtime (`/tmp/negotiation-host-lifetime-fail-before.log`). Pass-after proof on the repaired runtime:

| Gate | Result / log |
| --- | --- |
| Runtime and headless dependency boundary: `node_modules/.bin/jest --config packages/swap-protocol/jest.config.cjs --runInBand runtime` | 2 suites, 12 tests pass; `/tmp/negotiation-host-lifetime-runtime-final.log` |
| All configured projects: `node --import tsx scripts/typecheck.ts --fast` | 25/25 pass; `/tmp/negotiation-host-lifetime-typechecks.log` |
| Actual app/session/polling/status command above | 4 suites, 64 tests pass; `/tmp/negotiation-host-lifetime-app.log` |
| Actual bot reliability: `node_modules/.bin/jest --config packages/bot-framework/jest.config.js --runInBand bot-host-reliability` | 31 tests pass; `/tmp/negotiation-host-lifetime-bot.log` |
| Scoped runtime/test Prettier and `git diff --check` | Pass |

Compression retained one per-owner outstanding-request field and a settlement observer, rather than adding cancellation, scanner contracts or host machinery. The original requested Sol medium configuration remains parent-reported; worker runtime model metadata remains unavailable. Fresh parent review is required before integration.
