# AVU details page and chart presentation (tier 2)

Base: `4029b21b`. Direct owner request; integration owned by root. Scope: AVU chart and details view/tests, Wallet.vue entrypoints/tests, removal of obsolete dialog mock, router entry/test, AVU-only English/French labels. Locale edits are disjoint from browser QA's username keys.

Current: Wallet opens a modal containing dollar reference history; chart endpoint labels are offset from the corresponding plot ends and raw protocol labels reach the UI. Target: a routed `/avu` page reuses the existing details implementation directly, with no intermediate wrapper; all three wallet help entrypoints navigate there. Both benchmark curves keep one USD axis, have an explicit legend, and use readable dollar precision. Visible names become AVU (Hash) and AVU (Spot); toggle styles agree with the wallet.

Oracle/feed code remains the authority for formulas and history. No change to custody, pricing methodology, persistent or wire formats, network requests, data seeds, or synthetic history. The asset table keeps native assets and adds one USD row from the existing hash benchmark; no managed stablecoin rows or new feeds. Gold remains explicitly unavailable without dated data.

Evidence: focused component tests for readable labels/legend/currency and exact scale placement, router test for the dedicated page, Wallet navigation tests, retained missing/future/single-point/gap cases. Root owns execution slot grants and browser verification. No tests until granted. Remove obsolete modal source/API and update every caller/mock in this patch. Rollback is the bounded commit; no data reset.

Scientific trace: AVU (Hash) sums price × reward / (difficulty × hashesPerDifficulty) per merged-mining entry, multiplies hardware hashes/kWh, inverts, and market-cap-weights the inverses. Details USD/AVU is the inverse of the basket result. Inputs use latest-at-or-before step-hold; bundled mining series are monthly means at month starts, hardware efficiency and rewards use dated steps. Curve changes therefore cannot be attributed to difficulty alone. Preserve methodology pending explicit owner direction.

Verification: focused AVU details/chart, Wallet, chain balance and route suites pass (100 tests); `yarn typecheck:fast` passes all 22 projects; scoped ESLint has zero errors and formatting passes. Copied base-source regressions fail at the intended boundaries: right endpoint y=14 rather than 30, and the dedicated AVU route is absent. No tracked candidate source was changed for fail-before. Browser layout verification remains with root.

Scientific sources: `packages/wallet/oracle/energy-basket.ts` (`avuHashAt`, `basketWeights`); `packages/price-feeds/src/timeseries.ts` (latest-at-or-before lookup); `packages/price-feeds/src/temporary-direct-feed.ts` (monthly historical input timestamps). This patch preserves those sources and datasets.
