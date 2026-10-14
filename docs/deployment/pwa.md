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
`dist`. The deployable static directory is `app/dist/pwa`. `serve:pwa` starts a
localhost-only preview server; Quasar App CLI v3 does not implement `quasar serve`.
For deployment, serve the directory over HTTPS
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

## Updates and HTTP caching

Configure the production host to revalidate `index.html`, `sw.js`, the manifest,
and other unhashed resources (`Cache-Control: no-cache`). Content-addressed files
under `assets/` may use `Cache-Control: public, max-age=31536000, immutable`.
Do not apply immutable caching to the worker or HTML. Publish the complete build
atomically and retain previous hashed assets when possible, including for older
SPA tabs that were opened before service-worker installation. Relay/API paths
must not use the frontend's navigation fallback or asset cache policy.

The local `serve:pwa` command implements these headers. Verify the equivalent
headers on the actual deployment host, including any CDN, before release:

```sh
curl -I http://127.0.0.1:38770/
curl -I http://127.0.0.1:38770/sw.js
curl -I http://127.0.0.1:38770/manifest.json
# Also inspect one content-hashed /assets/*.js URL from the built index.html.
```

A new worker activates immediately on reload (`skipWaiting: true`) so that
users receive updates upon refreshing without needing to close all Frank windows.
This preserves application updates across browser and PWA sessions while
keeping wallet storage and transaction state durable.

The upgrade rehearsal used two actual builds with different entry and lazy-module
hashes. With B deployed, A's open tab stayed on A and imported its old lazy module
even though that file no longer existed on the server. B waited until all windows
closed, then activated on reopen. B also cold-started and imported its lazy module
offline. A synthetic IndexedDB marker survived the upgrade. These checks used an
isolated Chrome profile and did not exercise account derivation or live payments.

The service worker is event-driven. The browser can stop it between events; it
is not a persistent wallet daemon and does not guarantee transaction or message
reconciliation while every application window is closed. Financial recovery
continues through the existing wallet services when the application resumes.

## Blind WebPush Wakeup & VAPID Key Persistence

To wake an installed PWA or backgrounded browser tab when a new message arrives without exposing message plaintext or social graphs to push providers (Apple APNs, Google FCM, Mozilla Autopush), the relay and PWA implement **RFC 8030 WebPush** with **RFC 8292 VAPID** (`ES256` P-256 JWT authentication) and **RFC 8291 (`aes128gcm`)** payload encryption:

- **VAPID Public Key Endpoint**: The relay serves its P-256 public key (65-byte uncompressed SEC1 base64url) at `GET /push/vapid-public-key`, which the PWA passes as `applicationServerKey` to `pushManager.subscribe()`.
- **Persisting `FRANK_VAPID_PRIVATE_KEY` Across Restarts**:
  - Browser push subscriptions are cryptographically bound to the relay's `applicationServerKey` (VAPID public key). If a relay generates a fresh ephemeral key on restart, all existing browser push subscriptions break silently (`401`/`403` from push endpoints).
  - In **standalone mode**, if `FRANK_VAPID_PRIVATE_KEY` (or `registry.vapid_private_key`) is not set in the environment/config, `cashwebd` generates a 32-byte P-256 scalar on first boot and persists it in RocksDB metadata under `M_vapid_privkey` so single-node restarts preserve the same VAPID identity automatically.
  - In **containerized, ephemeral-disk, or multi-node clustered deployments**, operators **MUST** provision a persistent `FRANK_VAPID_PRIVATE_KEY` (64-character hex or base64url 32-byte P-256 secret scalar) via a shared secret store (e.g., Kubernetes Secret or Vault) alongside `FRANK_VAPID_SUBJECT` (e.g., `mailto:admin@example.com`) so every relay instance signs WebPush notifications with the identical VAPID keypair.
- **Content-Free Wakeup Payload**: The encrypted WebPush payload is fixed to `{"type":"sync","v":1}`. Neither sender identity, recipient address, nor message ciphertext ever traverses third-party push servers. Upon receiving the push event, the service worker wakes up, fetches and decrypts pending envelopes directly from the relay (`GET /messages`), and displays a local notification.
- **AVU Notification Threshold & Blinded Contact Wakeup Tokens**:
  - Push registrations (`PUT /push/register`, authenticated via `x-cashweb-auth`) include `min_notification_avu_micros` so the relay only dispatches a WebPush ping when the verified stamp value meets the recipient's minimum AVU threshold.
  - Approved contacts can bypass the AVU floor without revealing the user's contact list to the relay: the recipient shares a random preimage `token_secret` with an approved contact, registers only `wakeup_token = SHA256("frank-wakeup-v1" || token_secret)` with the relay, and the sender attaches `x-frank-wakeup-preimage` on delivery. The relay verifies the SHA-256 hash in constant time before firing the wakeup ping.

