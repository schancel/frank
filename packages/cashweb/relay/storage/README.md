# MessageStore application records

MessageStore schema 3 retains outgoing application decisions and financial envelope
bindings independently of chat history. `deleteMessage`, `suppressAndDelete` and
`clear` cannot discard these authorities; `clear` retains the format marker too.
Receipt, suppression and quarantine metadata remain presentation/history facts and
follow the existing history policy. There is no intent eviction or account-reset API.

The application derives an account-private semantic `intentKey`, validates its own
opaque application bytes and calls `claimOutgoingApplicationMessage` before signing.
An exact claim replay returns the current record, including any completed signed
payload. `completeOutgoingApplicationMessage` requires that same claim and saves the
exact signed bytes and message ID once. The successor composer must reuse these
saved bytes and identity through the existing messaging delivery/recovery paths.
This storage seam does not sign, deliver, validate application schemas or provide
distributed exclusion across different local databases.

The metadata adapter serializes comparison, capacity inspection, write and first
schema marker in one strict IndexedDB transaction. Native storage uses the owner's
mutation queue, exclusive Level handle and synchronous batch. Capacity is 128 retained
records per account; records have no derived count index. Expected conflicts and
capacity refusals leave the owner usable. An uncertain acknowledgment holds further
mutations until close/reopen; a read after reopening determines what actually committed.
All returned records are frozen independent copies. Missing reads do not persist a
marker or defaults.

Schema 2 and other old formats are explicitly unsupported, without migration,
automatic deletion or a tolerant reader. For development-only synthetic data, stop
its host and configure `new LevelMessageStore(freshSyntheticNamespace)` to use a fresh
namespace, then recreate synthetic history there. Preserve the old namespace for
inspection. Do not reset a funded account, delete keys/custody databases, or discard
financial authority to resolve an unsupported history format. This change contains
no account reset implementation.

Qualification commands from the repository root, using already installed dependencies:

```sh
node node_modules/jest/bin/jest.js --config packages/cashweb/jest.config.js --runInBand
node packages/cashweb/relay/storage/outgoing-application-intent.browser-test.mjs
yarn typecheck:fast
```

The browser harness bundles the production MessageStore and LevelJS adapter with
browser polyfills matching the app, uses disposable local Chrome pages/profiles and
synthetic application choices, and checks independent-page contention plus process
kill/reopen. It excludes wallet implementation imports. It does not qualify physical
power failure, browser eviction or external messaging. The native tests exercise the
public seam with owned temporary Level profiles and synchronous-write evidence.
