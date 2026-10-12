# Electron packaging

Electron uses the isolated, sandboxed renderer's existing encrypted IndexedDB /
nonextractable WebCrypto custody. It does not enable Node APIs in the renderer or
introduce a second key store. Capacitor and Cordova remain unsupported by this
custody composition. Native file origins retain the configured HTTP(S) relay;
web deployments retain their existing same-origin routing.

From the repository root, build a local unsigned Monad-testnet app:

```sh
yarn --cwd app prepare:packages
CI=true CSC_IDENTITY_AUTO_DISCOVERY=false \
QCLI_MONAD_RPC_CHAIN=monad-testnet \
QCLI_MONAD_NETWORK_ID=monad-testnet \
QCLI_FRANK_NETWORK_TAG=MONT \
QCLI_MONAD_CHAIN_ID=10143 \
QCLI_MONAD_RELAY_BASE_URL=http://127.0.0.1:28198 \
FRANK_DEMO_RELAY_PORT=28198 \
yarn --cwd app build
```

`prepare:packages` is also the `build` prehook. These scripts are introduced by
the companion PWA packaging change. Without that change, explicitly run:

```sh
yarn tsc -p packages/nakamoto/tsconfig.json
yarn tsc -p packages/crypto-box/tsconfig.json
```

On Apple Silicon, outputs are `app/dist/electron/Packaged/mac-arm64/Frank.app`,
`Frank-0.3.0-arm64.dmg`, and a macOS ZIP. Signing, notarization, publishing,
Windows/Linux packaging, and live payments are separate acceptance checks.
Use an operator relay URL appropriate to the deployment; a localhost URL works
only when the relay runs on the same machine.

Run the packaged startup, account-creation/reopen, and custody recovery checks:

```sh
ELECTRON_SMOKE_EXECUTABLE="$PWD/app/dist/electron/Packaged/mac-arm64/Frank.app/Contents/MacOS/Frank" \
node app/src-electron/test/custody-smoke.mjs
```

The runner creates its own temporary profile and retains it for inspection. It
never opens the default profile. UI operations block outbound HTTP/WebSocket
requests; custody tests prohibit network calls and secret logging. Coverage
includes encrypted account creation, UI activation/reopen, forced process exit
during staging and activation, repeated activation, backup reconstruction,
concurrent mutation, and malformed/corrupt storage. Test recovery shares remain
inside the synthetic renderer and are not printed.

## Passkeys / Mera

The packaged UI currently runs from `file://`. Chromium rejects WebAuthn on that
origin, and Mera's account-root adapter requires a nonempty relying-party
hostname. Browser login on localhost does not establish native support.
An HTTPS or localhost authentication bridge, or a native WebAuthn implementation,
needs its own RP/account-identity design and PRF compatibility proof before Mera
can be offered in this app.

References: [Chromium origin rules](https://chromium.googlesource.com/chromium/src/+/main/content/browser/webauth/origins.md),
[Electron WebAuthn configuration](https://github.com/electron/electron/blob/main/docs/api/app.md),
and [Mera authenticator support](https://mera.category.xyz/authenticator-support/).
