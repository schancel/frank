# [bug] Cover frontend TypeScript and Vue in the compiler gate

Readiness: NEEDS_SPECIFICATION for implementation slices. Parent explicitly requested this durable baseline/coverage follow-up; the accepted outcome is clear, but diagnostic ownership and the exact app/Vue compiler boundary must be inventoried before dispatch. Owner: repair coordinator.

## Evidence and impact

At main acb41f0c40bf4bde5ae8edbfb9f513f04c36353a, scripts/typecheck.ts enumerates packages/*/tsconfig.json and app/src/accounts/custody/tsconfig.json. It does not add app/tsconfig.json or a Vue SFC checking target. Both ordinary and fast commands share that enumerator. The hosted typecheck workflow runs the same scripts. Therefore a green 22-project result does not cover most frontend UI or session orchestration.

During the separately reviewed session fix (PR1251, reviewed9f12afd2ce9397beee17bc4763d9c336c57baa27), full-app checking reported 222 identical pre-existing diagnostics between its tested base and candidate. That is earlier exact review evidence, not a freshly measured count for current main. No heavy whole-app rerun was performed for this ticket. The execution progress record already discloses this limitation.

## Expected outcome

Inventory and explicitly name the checked frontend surfaces, then repair real diagnostics in bounded owned slices and add an appropriate app TypeScript/Vue gate. A production frontend type error must fail the appropriate gate. Existing package and custody coverage must remain. The gate must not claim whole-app success while omitting the app.

## Contract to freeze and acceptance

- Identify the existing build/compiler configurations and exact included/excluded app, Vue, generated and test surfaces; distinguish intentional test exclusion from missing production coverage.
- Preserve a reproducible diagnostic inventory tied to an exact revision and assign real defects to their owners, respecting active wallet/session/conversation mutexes.
- Select the appropriate existing or explicitly added app/Vue compiler command after tracing local tooling; do not invent a command or assume ordinary tsc checks Vue templates.
- Fix diagnostics through correct types and boundaries. No blanket any, ts-ignore, production exclusions, weakened strictness or false-success baseline.
- Prove a small representative production TS and Vue template/type error fails the configured gate, while a clean candidate passes all required configured projects.
- Integrate bounded predecessors separately; no unreviewed whole-tree rewrite or suppression sweep.

Fresh searches found no matching open/recently closed coverage ticket. Closed #174 concerns earlier wallet/TypeScript/browser CI and does not establish current frontend coverage. This ticket does not claim the current runtime is unusable or that existing behavioral tests provide no value.
