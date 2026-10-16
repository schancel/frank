# Automatic UI language host implementation evidence

Accepted tier 2 contract: [contract.md](contract.md). Host source commit `321c64fc`; combined catalog/EN-FR signed UI baseline `fb711536`. This evidence accompanies the final fixture-only correction commit; its exact hash is recorded in the handoff.

## Ownership and behavior

`app/src/i18n/locale.ts` owns supported metadata and pure resolution. The appearance record still owns one string preference; a new unsaved store uses `auto`, while existing saved explicit values survive unchanged. The effective language is derived from that preference and ordered browser languages. No additional durable fact, migration, wire format, transaction parsing, or currency accounting change was introduced.

All seven catalogs and corresponding Quasar packs have explicit static imports in `i18n/index.ts`; there is no runtime translation fetch. Automatic matching supports tl/fil, Spanish/Vietnamese variants, English/French variants, and Chinese script-over-region precedence. Invalid or unsupported browser entries are skipped, with English fallback and browser-global absence support.

The existing boot, restored appearance, runtime creation, Settings Save and headless translation boundaries resolve the same effective locale. `applyLocale` applies it to Vue i18n, Quasar, and the document language. The boot watcher handles committed preference changes; the browser listener reapplies only automatic preferences and is removed when its app unmounts. Neither writes a detected language back into appearance. Settings selection remains a draft until Save; Cancel retains the committed choice.

## Acceptance evidence

Run from this candidate's `app/` directory:

```sh
node ../node_modules/jest/bin/jest.js --config test/jest/accounts.config.cjs --runInBand --silent src/i18n src/stores/appearance.jest.test.ts src/utils/apply-locale.jest.test.ts src/utils/apply-locale-contract.jest.test.ts src/pages/Settings.jest.test.ts src/App.startup.jest.test.ts src/composables/useTranslate.jest.test.ts
```

PASS: 13 suites, 1086 tests. Log: `/tmp/automatic-ui-language-focused.log`.

Coverage includes ordered language matching and malformed/missing browser globals; saved explicit/automatic preference round trips; real boot restoration with no hydration writes; automatic browser changes; explicit pinning and selecting automatic again; all seven real Quasar packs and document/Vue agreement; actual Settings select/Save/Cancel interactions; rendered new-script Settings captions and native-language labels; headless translation; required startup failure gates.

The shared catalog validator checks the complete recursively resolved English key set, including account recovery and committed signedSwap strings, against every catalog. It preserves interpolation/literal tokens, linked messages, plural alternatives, HTML and URLs; compiles every message with the installed Vue i18n compiler; and rejects English import/spread fallback scaffolding and mostly untranslated catalogs. All seven catalogs pass.

Run from the candidate root:

```sh
yarn typecheck:fast
```

PASS: all 25 configured projects, zero failures. Log: `/tmp/automatic-ui-language-typecheck.log`.

Scoped Prettier checks and `git diff --check` pass. Dependency overlays are candidate-local, use existing installed external packages, and resolve all 22 `@frank` workspace links to this candidate's packages. Wallet Chronik remains 4.3.1. No manifest/lockfile/install or shared dependency mutation.

## Fixture corrections and limits

The first combined run exposed old synthetic message-store schema markers (`2`) while the current storage baseline requires `3`; the startup fixture now uses the current marker and retains its deliberately unsupported `1` regression. Automatic test apps now mount/unmount so browser listeners are cleaned up between cases. The document synchronization test explicitly uses jsdom with Node package export conditions. No production correction was needed after the combined catalogs arrived.

Rendering evidence uses jsdom and the real Settings template/catalog values with stubbed Quasar controls. It checks strings and interaction semantics, not browser pixel layout, mobile clipping, or a built PWA's service-worker cache. Static imports and real pack dispatch are verified; a PWA build was not run. Native-speaker translation verification is not claimed; independent semantic catalog review belongs to the parent coordination/review. No live services, keys, funds, push, merge or deployment were used. The final candidate requires independent review before integration.
