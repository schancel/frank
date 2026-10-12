# Chrome and Safari extension feasibility

Research date: 2026-10-11. Inspected release revision `5acd57e8`. This is a
feasibility report, not an implemented or tested extension. No account storage,
credentials, live payments, or browser profiles were accessed.

## Recommended first version

Package the existing Vue/Quasar SPA as a full extension page opened by the toolbar
button. Keep custody and messaging in that page initially, with the existing
persisted operation recovery when it reopens. A Chrome side panel can follow after
testing narrow layouts and the existing single-owner tab coordinator. A popup is
better as a launcher than the sole wallet surface: closing it must not lose an
authorized send or its recovery state.

This is an installable Frank UI, not an injected dapp wallet provider. Provider
injection, site permissions for signing, and transaction approval protocols would
be a separate product/security scope. The first version needs no content scripts,
page injection, broad browsing access, or native messaging.

Chrome supports extension side panels with the `sidePanel` permission; a global
panel can remain available across tabs. Its API and extension-page resources are
documented in the [Chrome side panel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
Safari portability should start from the full-page/toolbar experience rather than
assuming the Chrome panel API exists there.

## Concrete changes required in this repository

| Area | Current evidence | Required extension work |
| --- | --- | --- |
| Build | `app/quasar.config.js` has hash routing and SPA/PWA/Electron configuration; there is no extension build target. | Add a dedicated reproducible packaged SPA target, manifest, toolbar launcher, local icons, relative asset/chunk URLs, and artifact check. Do not ship the Vite development server. |
| CSP | `app/src/index.template.html` contains an inline script installing an ngrok header shim. | Remove that shim from extension output or move justified logic into a packaged external script. Test actual production chunks under extension CSP. |
| Passkeys | `app/src/accounts/mera-passkey.ts` explicitly uses `location.hostname` as the RP ID and a fixed PRF salt domain. | Inject an explicit platform RP policy. Website, extension, and localhost are different scopes; preserve the existing credential and PRF inputs when recovering an existing account. |
| Custody | `app/src/accounts/custody/persistence.ts` uses IndexedDB with strict transactions. | Reuse storage in the extension page and prove reopen/update behavior with a synthetic account. Extension origin storage does not automatically contain the website wallet. |
| Background storage | `packages/wallet/storage/level-durability.ts` considers a browser runtime to require `window`; otherwise it attempts Node filesystem paths. | Before moving wallet ownership to a service worker, replace this environment inference with an explicit storage composition that supports worker IndexedDB and retains strict durability. |
| Runtime | `app/src/stores/chats.ts` uses document focus; oracle scheduling uses timers/visibility; swaps use localStorage; tab coordination uses window/pagehide, sessionStorage, and BroadcastChannel. | Keep the UI runtime in a document for the first version. A background owner requires headless capabilities and explicit lifecycle wiring, not importing these Pinia stores into a worker. |
| Network | Development config proxies relay traffic to localhost. | Configure real HTTPS relay/RPC endpoints and narrow host permissions. Test fetch, WebSockets, custom headers, blobs and CORS using the installed extension origin. Development proxy success does not establish production connectivity. |

Chrome extension pages prohibit inline script and JavaScript string evaluation;
packaged WASM can be enabled with `wasm-unsafe-eval` when needed. It is not permission
for ordinary `unsafe-eval`. Audit the built dependency graph rather than assuming
the development build is suitable. No active WASM/worker construction was found in
the targeted app/wallet source search; `worker-loader` and an older xpriv worker
source still exist, so this remains a bundle-level verification task.
[Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).

Bundle executable dependencies locally. Relay messages, prices and profiles are
remote data; they must not become remotely supplied executable application code.
[Manifest V3 code requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements).

## Mera and account identity are the first compatibility spike

On a Chrome extension page, `location.hostname` is the extension ID. Passing that
as though it were the website RP ID is not a valid cross-platform identity policy.
Chromium supports its own extension RP scope, with the RP fields omitted, and
Chrome 122 added claiming website RP IDs covered by extension host permissions.
An explicit configured website RP plus narrow permission is therefore a plausible
way to recover the same website-created passkey in Chrome. Verify actual PRF output
and derived Frank identity equality using a synthetic credential, including the
intended credential manager. Never silently create another account when lookup
fails. [Chromium origin rules](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/webauth/origins.md),
[Chrome WebAuthn implementer announcement](https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html).

Safari 18 introduced WebAuthn PRF and related-origin support for websites. That
does **not** establish support for the same ceremony in a `safari-web-extension`
page or for claiming website RP IDs through host permissions. This research did
not establish that compatibility from Apple documentation. Test Safari macOS and
iOS separately; do not promise shared Mera accounts until both RP acceptance and
32-byte PRF identity equality are proven. A normal HTTPS app remains the fallback
distribution surface, not an automatic secret-export bridge.
[WebKit Safari 18 features](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/).

Changing domains does not move localhost passkeys. Any intentional transfer must
use an explicitly authorized recovery flow and preserve funded wallet derivation.
The extension is a new storage origin even if it retrieves the same passkey root.
Use a stable extension ID across development/distribution updates; Chrome documents
the development `key` mechanism in its [manifest key reference](https://developer.chrome.com/docs/extensions/reference/manifest/key).

## Background recovery is a second, larger scope

Manifest V3 service workers are disposable: Chrome normally stops them after
30 seconds of inactivity, and there are request/fetch time limits. IndexedDB is
available, but localStorage and sessionStorage are not. Timers, in-memory keys,
and a live WebSocket are not an operation journal. Alarms/startup/explicit UI
events can trigger bounded recovery; they do not guarantee an always-running
wallet. [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

If background sending/notifications are required, establish one durable wallet
authority, inject its narrow capabilities into messaging, and have page surfaces
communicate through validated internal messages. Persist the encrypted message,
signed transaction set, reservations and intended amount before external exposure.
Restart must reconcile that original operation, not pay again. Define locked
behavior separately: a worker can potentially reconcile already signed work
without being allowed to derive fresh keys or construct another spend. Existing
page takeover and multiple-panel instances must not introduce competing owners.

Chrome shares extension-origin storage among its pages and worker. Its storage
documentation describes quota/eviction protection through `unlimitedStorage` or
persistent storage; choose and test an explicit policy for custody and journals.
Neither option replaces backups or makes extension uninstallation safe for the
only copy of keys. Never put secret material into synchronized extension settings.
[Chrome storage behavior](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).

Cross-origin fetch from an extension page/worker uses declared host permissions;
content scripts retain the host page's origin restrictions. Request only the
configured relay, RPC and passkey RP origins, with optional permissions if users
add endpoints. Do not request `<all_urls>` as a convenience.
[Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

## Safari packaging and distribution

Apple provides a converter to package an existing WebExtension into an Xcode
project, with a containing macOS/iOS app. Conversion is a packaging starting point,
not a guarantee that Chrome APIs, storage semantics or WebAuthn will behave the
same. Maintain a shared web bundle plus explicit platform manifests/adapters.
[Apple Safari extension overview](https://developer.apple.com/safari/extensions/),
[Safari packaging documentation](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari).

Unsigned macOS Safari extensions can be tested during development. iOS simulator
testing is possible without distribution signing; real-device/beta/App Store
distribution requires signing the extension and containing app. Public App Store
distribution requires Apple Developer Program enrollment and review. macOS also
supports Developer ID signed, notarized distribution outside the Mac App Store.
[Apple distribution requirements](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension).

Chrome supports unpacked development testing. Public distribution requires a
developer account, packaged ZIP, listing/privacy material and store review; a
working local build is not an approved store release.
[Chrome publishing](https://developer.chrome.com/docs/webstore/publish),
[developer registration](https://developer.chrome.com/docs/webstore/register/).

## Suggested execution order and effort

These are engineering estimates, not measured implementation results or store
review promises:

1. **Chrome UI-only spike: roughly 1–2 engineering days.** Package production SPA,
   externalize inline script, set endpoints/permissions, and test a synthetic
   passkey/recovery account in a full extension page. RP/PRF compatibility is the
   first go/no-go experiment, before polishing panel UX.
2. **Safari spike: another 1–3 days if the shared bundle works.** Convert, install
   on macOS and an iOS simulator/device, and verify passkeys, IndexedDB durability,
   relay/WebSocket connectivity and reopen. Unresolved RP/PRF behavior can change
   the design rather than merely add packaging time.
3. **Reliable background wallet: several additional days or more.** Separate
   document-dependent composition, worker storage support, lifecycle scheduling,
   owner arbitration, lock policy and interruption regressions. Scope this only
   if users need operation progress while all Frank pages are closed.
4. **Distribution follows technical acceptance.** Accounts, signing, listing
   materials and independent store review are external lead times.

Acceptance must include reload/update and closed-page recovery after relay
acceptance and ambiguous broadcast; repeated reconciliation without duplicate
payment; canonical chain isolation; multiple page/panel ownership; unsupported
PRF without account replacement; same credential/salt giving the same identity;
and a backup/restore rehearsal. No installed extension, build, browser ceremony,
store submission, or live-chain acceptance was performed in this research.
