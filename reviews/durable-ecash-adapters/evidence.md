# Q3a candidate evidence

Base: `3951bbf2557a31d7380a3ae6b07431f966e031b5`.
Requested lane: GPT-6.1 Sol medium; model selection follows the dispatched lane.
No production host/default changes, schema changes, dependencies or funded checks.

| Gate | Result |
| --- | --- |
| `yarn typecheck:fast` | 23 configured projects checked, 23 passed, 0 failed |
| `cd packages/wallet && ../../node_modules/.bin/jest storage/ecash-operations/native.jest.test.ts storage/level-durability.jest.test.ts --runInBand` | 2 suites, 8 tests passed; actual installed Level |
| `node packages/wallet/storage/ecash-operations/browser-test.mjs` | Actual Chrome 155.0.8059.40; all phases passed, including two independent pages |

Full result logs are adjacent. Initial typecheck used an incomplete temporary
overlay and selected Node declarations 26.6.3 for bot; preserving its installed
package-local declarations 16.18.126 restored the expected all-23 result without
source changes. Temporary links point `@frank` to this candidate and are removed
after qualification. Native runtime was Darwin/Node 26.10.0, level 7.0.1,
leveldown 6.1.1 with bundled LevelDB 1.20.

The tests qualify adapter behavior and actual backend acknowledgment boundaries.
They do not prove resistance to hardware dishonesty, physical WAL corruption,
eviction or rollback. Native Linux and other browser versions require deployment
qualification. Host lifecycle, strict owner installation/default removal and
actual-wallet multi-instance selection integration remain Q3b. See adapter README
for authority, exact namespace, interruption/recovery and supported-runtime limits.
