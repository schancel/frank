# Draft: [bug] PWA production build fails because src-pwa/manifest.json is missing

Not published. Proposed bug; owner acceptance and finite implementation contract pending.

## Summary

The current branding candidate cannot complete its required PWA build/install/cache verification: Quasar's production PWA builder fails before compiling because app/src-pwa/manifest.json is missing. Existing inline pwa.manifest configuration does not satisfy the observed builder. Whether this is an older migration regression remains unproven.

## Reproduction

At recover/plainspoken-branding-20261003 e1164ab, based on main a7d0275, install the frozen root lockfile with Yarn Classic1.22.22; compile the existing nakamoto and crypto-box package tsconfigs to their ignored dist outputs; from app run the repository Cargo wrapper with node ../node_modules/@quasar/app-vite/bin/quasar.js build -m pwa.

Environment: macOS, Node26.10.0, Quasar2.33.2, @quasar/app-vite3.10.0, Vite8.3.1. Quasar creates a missing src-pwa package manifest and installs dependencies, then fails with ENOENT opening app/src-pwa/manifest.json. Terminal exit1. The production SPA build passes after the workspace outputs are built. Log retained privately; generated source package files were removed by their owner afterward.

## Expected behavior

The supported PWA build produces a valid Frank manifest, service worker and production assets so actual installation and cache-update verification can run.

## Impact

Blocks PWA packaging acceptance for the preserved branding candidate. No data-loss or messaging-security defect established.

## Proposed acceptance criteria

- A clean, documented PWA production build succeeds from supported dependencies without manual manifest fabrication.
- The emitted manifest retains intended Frank name, palette, icons and existing installation behavior.
- Actual isolated Chromium verifies manifest/icon loading and service-worker installation/update behavior; build success alone is insufficient.
- Scope preserves current onboarding, accessibility and Wallet navigation.

## Notes

Candidate source was unchanged by verification. Existing branding review explicitly held platform gates. Related #384 covers notifications, not this observed packaging failure. No implementation or external publication is included in this draft.
