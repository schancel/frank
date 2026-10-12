# PWA packaging

From the repository root, install the workspace dependencies with `yarn install`.
Node 24 or newer is required. Build the PWA with explicit public network settings;
for the local Monad testnet relay:

```sh
QCLI_MONAD_RPC_CHAIN=monad-testnet \
QCLI_MONAD_NETWORK_ID=monad-testnet \
QCLI_FRANK_NETWORK_TAG=MONT \
QCLI_MONAD_CHAIN_ID=10143 \
QCLI_MONAD_RELAY_BASE_URL=http://127.0.0.1:28198 \
yarn --cwd app build:pwa

yarn --cwd app check:pwa
yarn --cwd app serve:pwa --port 38770
```

`build:pwa` first compiles the workspace packages that export JavaScript from
`dist`. The deployable static directory is `app/dist/pwa`. Serve it over HTTPS
(or localhost for local testing), not `file://`. Public relay URLs embedded in a
remote deployment must be reachable from the user's device; `127.0.0.1` is only
appropriate for the local setup above. The frontend bundle must never contain
upstream provider credentials.

Install from the browser's installation menu. Safari uses Add to Dock on macOS
or Add to Home Screen on iOS. Keep a stable origin: wallet storage and passkey
credentials are scoped to the website. An installed application on a different
origin does not inherit another origin's wallet.

The service worker precaches shipped static assets, excluding source maps. It
has no runtime response cache: relay requests, RPC responses, profiles, balances,
and private application records are not stored in Cache Storage. IndexedDB wallet
persistence remains owned by the existing account and wallet services. An update
waits for existing application windows to close before replacing their worker;
there is no forced activation during an open wallet session.

Offline availability means the application shell can reopen. It does not mean
balances are fresh, a message was delivered, or a payment settled. Existing
wallet journals and network reconciliation remain responsible for those facts.

Verification of the production output used an isolated synthetic Chrome profile:
manifest installability had no reported errors, setup rendered, reload and route
navigation worked offline, and a synthetic POST remained unavailable offline.
No funded account or payment was exercised. Safari installation and passkeys in
an installed PWA still need device testing; a successful Chrome build does not
establish those behaviors.
