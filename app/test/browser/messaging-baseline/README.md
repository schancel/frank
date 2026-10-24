# Offline composed messaging browser fixture

Run from the repository root with installed workspace dependencies and Chrome/Chromium:

```sh
node app/test/browser/messaging-baseline.mjs --source-ref=HEAD --out=/absolute/evidence/current
node app/test/browser/messaging-baseline.mjs --source-ref=8c913085b6b64bb8186f55a546605b6337ad085d --out=/absolute/evidence/baseline
```

`CHROME_BIN` overrides the executable. Nothing is installed. The runner exports the requested Git commit into an owned disposable directory, overlays the same test fixture, compiles its prerequisite packages and SPA, and starts a loopback server plus a fresh browser profile. Workspace dependency links resolve to that exported revision; external installed dependency bytes are shared, preserving package-local installed versions. The selected worktree and its production files are never modified. Each result records the source SHA, fixture hash and browser version. Run comparisons serially on a quiet host.

The full App/AppRuntime, routes, layouts, Quasar/CSS, Pinia stores, IndexedDB message persistence, Chat, ChatMessage and ChatInput run normally. The fixture injects synthetic account/messaging readiness and synthetic chain service capabilities at module/composition boundaries. No Chat method, outgoing store action or message renderer is replaced. A deterministic disposable wallet supplies a valid identity, but direct-message construction/submission is intercepted: **no financial transaction is signed or broadcast by the send fixture**. This does not measure real custody startup, directory publication, wallet construction, RPC latency, settlement or native extension behavior.

The first vertical scenario seeds 120 synthetic history messages outside measurement, types through the actual input, presses Enter, and waits for the matching outbound row and the matching synthetic service invocation. It asserts that message is pending while the service is held for at least two seconds, navigates Forum then conversations through real rail controls, and only then releases that specific send and checks confirmation. Startup can independently create a conversation-state sync send; the scenario identifies the text operation explicitly and never assumes it is send index zero.

Results contain Enter-to-DOM and Enter-to-next-animation-frame latency, Forum/conversation route-to-frame latency, and long tasks split between startup and the interaction window. Frame callbacks are paint proxies. One run is one smoke sample, not a stable percentile or a speedup claim. The seeded Forum service returns an empty synthetic feed; this first slice does not benchmark large Forum trees or network-dependent reads. Seeding can itself be expensive and its timings must not be presented as normal app startup cost.

The loopback server applies a restrictive CSP (`connect-src 'self'`, no workers/frames), and CDP intercepts requests and rejects nonfixture origins. WebSocket/EventSource constructors fail explicitly. A negative-control fetch to `offline-probe.invalid` must be rejected by CSP; expected containment messages are recorded separately from application errors. Real external services are never a fallback. Background Chrome networking is disabled. The fixture is a browser page, not a real extension host; extension background targets, popup auto-sizing, native Safari scrolling and real-custody PIN pairing require separate host tests.

Only owned browser/build processes and temporary profile/build paths are cleaned. Cleanup verifies the private ownership marker and handles interruption. Detached process groups remain owned after their original parent exits; cleanup terminates remaining group members, escalates to SIGKILL and verifies absence before deleting the temporary tree. Run `node --test app/test/browser/messaging-baseline/processes.test.mjs` for the orphaned, SIGTERM-ignoring descendant regression. Evidence files contain metrics, public synthetic message labels, diagnostics and a screenshot, not private keys or storage exports. Do not supply a user browser profile; the runner has no option to do so.

`--typecheck` runs the app TypeScript compiler against the exported production source plus the fixture before building. It fails on all reported errors, including existing app dependency/declaration problems; it does not filter or waive errors. This is distinct from a successful browser build, which transpiles TypeScript. Root package typechecks and independent review remain required before integrating the harness.

This initial harness is intentionally limited to the queue/route vertical test. Full scroll/history-anchor, browser startup/failure, paired multi-sample distributions, actual extension focus/pairing and isolated real construction measurements remain separate acceptance work. Do not represent this smoke as satisfying those later gates.

## History geometry scenarios

```sh
node app/test/browser/messaging-baseline.mjs --scenario=history-desktop --source-ref=HEAD --out=/absolute/evidence/history-desktop
node app/test/browser/messaging-baseline.mjs --scenario=history-narrow --source-ref=HEAD --out=/absolute/evidence/history-narrow
```

`--scenario=queue-route` remains the default and retains the existing send/route assertions. The history scenarios use fresh 1280×860 or 390×860 Chromium page viewports, real Chat/ChatMessage/ChatInput and Quasar scrolling. They wheel upward, check the visible reading anchor across render-window expansion and two incoming deliveries through real `chats.receiveMessages`, and explicitly jump to the latest message. Incoming data is a typed synthetic already-decoded wrapper; this does not test authentication, decoding or financial receipt verification. No component method or scroll position is directly assigned. The jump control uses its actual mousedown interaction.

`report.history` retains before/after scroll geometry, unique text anchors, confirmed store rows and every failed invariant. The tolerance is two CSS pixels after layout settles. A current production regression produces a nonzero exit; the fixture does not compensate for it. This is expansion of already-loaded history, not fetching older history from storage or a server. These are functional geometry checks, not performance, touch keyboard, installed-extension or native Safari evidence. `history.png` captures the final scenario state; exact intermediate geometry is in `result.json`.
