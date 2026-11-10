# Composer typing measurement

From this candidate worktree:

```sh
node app/test/browser/messaging-baseline.mjs --scenario=typing --source-ref=830a92d201f2b2b8d95f2e9a1f844f5068e0be59 --out=/absolute/evidence/typing-830
```

The existing runner exports the selected production commit, overlays this fixture, builds prerequisite packages and the SPA, starts a loopback server, and opens one disposable Chromium profile. It retains the fixture's synthetic account/payment boundary and external-network refusal. It never uses a real account, signs a payment, or sends the typed draft. This measures a 400×600 SPA viewport; it does not exercise an installed extension or real custody startup.

The scenario drives actual Chat/ChatInput with CDP per-character native text insertion. After warmup, it records 60 individual beforeinput-event-to-next-animation-frame samples, then repeats with three deterministic JPEGs selected through the actual file picker and normal image preparation. Document capture marks beforeinput before the native text edit and Vue handlers; input capture schedules the frame callback. Image generation/preparation is outside timing. The existing fixture seeds 120 history rows; Chat initially renders its normal newest 30.

`result.json` contains `typing.cases`: nearest-rank p50/p95/max input-to-frame latency, long tasks overlapping each measured interval, and synchronous draft-key `localStorage.setItem` duration/count/value-byte totals. The storage observer delegates the original method unchanged. Its timing excludes JSON serialization; input-to-frame includes the application update. Bytes are UTF-16 value bytes, excluding key/browser overhead. Only lengths and timings are reported, with no draft content or image payloads.

Frame callbacks are paint proxies, and the measurement excludes CDP transport and browser work preceding beforeinput. Awaiting each frame gives one input per frame rather than saturated typing. Cases run text-only then images in one profile, so compare repeated serial runs on a quiet host and preserve the recorded source SHA, browser version and fixture hash. There is no performance threshold or speedup assertion. Functional assertions fail for missing beforeinput/input events, lost characters, mismatching durable draft content, absent representative attachments, or accidental message submission.

Scope reconciliation: the coordinator authorized the new non-pairing scenario after inspecting prior claimless fixture records. Pairing implementation/session/runtime and its README remain outside this candidate. The earlier workspace records and worktrees are preserved.
