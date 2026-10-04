# Native JSON upstream pin/deploy preparation

Read-only against Frank exactfebcefa1874c1a323bb2a24f275ede2e7c7ae7f0 and accepted complete successor direction. No clone/build/install/deploy/spend/source edit/claim. GitHub API/raw and npm metadata only. Exact candidates below are source research pins, not evidence of deployed server version or compatibility.

## What is actually pinned

Frank cashweb/app ^0.8.2 resolves yarn.lock to chronik-client0.8.5, tarball SHA1 5f89b09c74c48f2b060f7fb520255b0fe556a431 and recorded SHA512integrity. Installed historical index.ts blob395a75a41a51719097c97969ae8f0ef42baa52df matches EXACT Bitcoin-ABC/bitcoin-abc modules/chronik-client/index.ts at npm gitHead70cb4f7f9dafb976ec82cccc673ee739c3986ed9, commit dated2023-10-24. Earlier source review called this the0.8.2 lineage; migration must freeze actual0.8.5 surface and separate vendored0.8.2 exports.

Frank wallet pins4.3.1, lock tarballSHA1 826482720553d5cc0499b0125183583288a412bf plus SHA512integrity, ecash-wallet6.2.1. npm4.3.1 lacks gitHead/repository. Installed src/ChronikClient.ts blob81f3d7fd66e891374479a54e64cbdf174b44a706 exactly matches that file at root-verified ABCb43357b70a71566e363d7d83b3998a67a203d2a0 dated2026-10-02. This strengthens candidate source mapping but does NOT prove every package file/failover/proto/SDK fixture or server semantic identity. Preserve exported latency helpers alongside full modernHTTP/WS factories.

No checked-in exact deployed indexer commit/image/plugin manifest found. Historical README URLs chronik.be.cash/xec, /xpi and tests/xec2 locate services, not maintained deployed version. Frank bitcoin_proxy supports configured Chronik URL and configured checkpoints; these cannot reveal build SHA absent operator manifest. Don't assume latest API version from URL.

## Candidate modern eCash source owner

Pin research/patch candidate Bitcoin-ABC/bitcoin-abc b43357b70a71566e363d7d83b3998a67a203d2a0. It has required script batchUTXOs/summary, token/plugin/LOKAD/native subscriptions, current client4.3.1 main source mapping. Official release notes mark batchsummary present inv0.33.4, but release minimum is not an exact required deployment pin. Owner must select candidate against actual4.3.1 differential fixtures and configured plugins/network upgrades before adoption.

Finite native seams: chronik/chronik-indexer/src/query/{blocks,broadcast,group_history,group_utxos,plugins,tx_token_data,txs,util}.rs; existing subscriptions subs.rs/subs_group.rs; chronik-http/src/{server,handlers,parse,ws,error,protobuf}.rs; new ordinary DTO/value and nativeJSON request/response modules/tests. Current query types and assembly use proto::Tx/UTXO/history/token objects below serializer. Extract DTO assembly where actual indexed domain facts are gathered, leaving old protobuf adapter separately outside normalJSON path during transitional fork preparation. Preserve node/state locks, token/plugin engines and subscription machinery; no HTTPJSON client of protobuf upstream.

Full matrix must include native header/range/proofs, raw bytes, all routed blocks/mempool, Script/TokenID/LOKAD/Plugin, batchecho/count/latesttx semantics, validate_tx and exact broadcast options/results/finalization. Rust SDK itself has PluginEndpoint factory/history/confirmed/unconfirmed/UTXO, not token-ID factory; preserve both dialect capabilities according to real APIs. DirectSDKWS remains supported even while relayWS policy stays denied.

## Candidate historical Lotus source owner

Distinct historicalNNG implementation: raipay/chronik exact1970f249139a4a545bc5f4813e4f237910d34566 (GitHub master commit2024-01-03). README explicitly XPI/XEC network selection, validate-utxos, historical script history/groupedUTXOs and AddedToMempool/RemovedFromMempool/Confirmed/Reorg events. HTTP source returns domain RichTx from chronik-indexer then converts with chronik-http/src/convert.rs; native JSON can serialize those same rich/domain facts rather than convert through proto.

Finite seams: chronik-http/src/{server,convert,error,validation,protobuf}.rs and new nativeDTO/JSON modules/tests; chronik-indexer/src/{blocks,broadcast,indexer,script_history,subscribers,tokens,txs,utxos}.rs only for missing ordinary domain exposure; chronik-exe startup configuration/main for explicit native listener namespace if accepted. Indexer txs.rs already returns bitcoinsuite_slp::RichTx, giving real nonproto result seam. Server.rs includes validate-utxos and WS state; preserve original order/state/validation and implicit block subscription behavior. Its bundled ts client index.ts differs from installed0.8.5, so domain->dialect differential mapping remains mandatory.

This fork has sibling ../../bitcoinsuite path dependencies (core,slp,error,bitcoindNNG etc.) and locking/build pairing must be pinned, not silently point at current Frank vendor. README suggests LogosFoundation/bitcoinsuite; current remote master SHA47590d5e753021e9a0688debba362ea88a993034 dated2026-08-21 is only a discovered head, NOT verified compatible dependency pin. Resolve historical dependency tree/API at candidate before build acceptance.

Lotus node official givelotus/lotusd latest releasev4.3.3 published2022-11-16, annotated/ref object is commit95607140fba8ac876346ca6924c4549de8cecf64. READMENNG minimum2.1.3 is historical guidance; don't downgrade current network node or infer4.3.3 is currently deployed. Exact deployed Lotus binary/source+NNG IPC compatibility and chain checkpoint/operator manifest remain missing prerequisites. Historical eCashNNG raipay/bitcoin-abc/nng_interface is NOT selected for modern eCash; two distinct maintained owners.

## Lightweight patch checkout proposal (not executed)

After explicit finite acceptance/claims, create separate upstream patch workspaces, outside Frank shared Registry/server scope. Modern: metadata-only git init/remote, fetch selected exact commit with depth1/filterblob:none, sparse checkout chronik, sharedRust/CMake dependency declarations and relevanttest/doc seams; expand only compiler-evidenced dependencies. Historical: small exact commit checkout of raipay/chronik plus separately exact pinned siblingbitcoinsuite directory preserving relative paths. Don't clone full ABC history or reuse another task's node_modules/native caches. Git shallow/sparse setup mutates only authorized dedicated upstream workspaces; heavy builds later require serialized lease and ownercache.

First change pure DTO/nativeJSON module+fixtures, freeze HTTP/WS namespace/media and unknown variants. Integration commits attach existing query/event owners and bound strict request/response codecs. Preserve old code solely for differential comparison until deployed cutover; final service rejects protobuf normal paths. Native upstream owner can work without current Frank Registry claims. Local pure schema/client Rust/TS paths can parallelize after schema acceptance; manifest/lock/export integration waits separately claimed shared consumer scope.

## Finite decision inputs needed for dispatch/deployment

1. Accept modernb433 candidate only after package-wide4.3.1/file/fixture comparison; choose maintained fork/operator and exactnode/plugin/network configuration.
2. Accept historicalraipay1970 candidate and exactcompatiblebitcoinsuite sibling/nodeNNG pin; verify full installed0.8.5+vendored0.8.2 semantics rather than claiming bundledts matches.
3. Freeze complete ordinaryHTTP/WS schemas, displayhash reversal, canonicaldecimal signedness/width, unknown token/plugin variants, resultordering and error/reconnect/finalization semantics. Pin captured fixture provenance.
4. Obtain real operator deployment manifest: endpoint origins/listeners, binaryimagehash/sourceSHA, chainnetwork/genesis/checkpoints, indexes/plugins, NNG/nodeifhistorical, migrationdatadir/readiness/backup and rollback. No deployment permission or spend inferred.
5. Select SDKpatch distribution and actual bundle no-codec proof. Preserve full modern/legacy exports, rawsignedtransactions/pending txid/uncertain evidence; no rebuilt payments/retryshortcut. FreshRPC authority and Frankproxy/currentprincipal/carveout remain separate owner decisions.

Source research establishes feasible exactcandidate forks and client-file mappings; it cannot locate an exact deployed version from missing manifests. That bounded missing operator input is actionable, not a reason to shrink required functionality.

Primary source links:
- https://github.com/Bitcoin-ABC/bitcoin-abc/tree/b43357b70a71566e363d7d83b3998a67a203d2a0/chronik
- https://github.com/Bitcoin-ABC/bitcoin-abc/blob/70cb4f7f9dafb976ec82cccc673ee739c3986ed9/modules/chronik-client/index.ts
- https://github.com/raipay/chronik/tree/1970f249139a4a545bc5f4813e4f237910d34566
- https://github.com/givelotus/lotusd/tree/95607140fba8ac876346ca6924c4549de8cecf64
