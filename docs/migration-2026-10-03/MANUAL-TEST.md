# Manual test: encrypted UI ↔ Qwen over the canonical path

Last updated 2026-10-04 10:30 PDT. This is the first point that really works end to end. Typed
blackjack, two-relay forwarding and legacy-path retirement are not in it yet (see "Where it stops").

## What to check out

- Branch `local-stack`, commit `0bd66d3` (pushed to origin). Worktree on this machine:
  `~/repos/frank/.worktrees/local-stack`, already built.
- It contains main (`2769115`, with #825) plus the app cutover (PR #833), the Qwen bot's canonical
  mode (not yet in a PR) and the launcher under `demo/local-stack/`.

## Quickest path (about a minute)

From `~/repos/frank/.worktrees/local-stack`:

```sh
node demo/local-stack/stack.mjs e2e             # clean state → account → provision → fund → one message and reply
node demo/local-stack/stack.mjs chrome driven   # opens that account in a real Chrome window
# chat with the bot contact; replies take several seconds (real qwen2.5:7b on local Ollama)
node demo/local-stack/stack.mjs down
```

`e2e` prints `PASS` per browser phase and ends with "e2e finished". The Chrome window uses a
throwaway profile that trusts only this stack's certificates; your normal Chrome is untouched.

## Fully by hand

```sh
node demo/local-stack/stack.mjs up
node demo/local-stack/stack.mjs chrome          # empty throwaway profile
#   create the account; Settings → Networking → "Export public directory evidence"; download the file
node demo/local-stack/stack.mjs provision ~/Downloads/frank-ui-public-export.json
#   open the Receive page and copy the address shown THERE (not the one on the Wallet page, #834)
node demo/local-stack/stack.mjs fund 0x<receive address>
#   Settings → Networking → "Check installation"; Add Contact with the bot address the panel shows; chat
node demo/local-stack/stack.mjs down
```

`provision` and the empty-profile `chrome` command had not been run by anyone when this was
written; `e2e` runs the same steps through the driver. If `provision` fails, fall back to `e2e`.

`node demo/local-stack/stack.mjs build` rebuilds everything (relay binary, app, local chain) if you
change code. `stack.mjs status` shows what is running; logs are in `/private/tmp/frank-stack/logs`.

## One-hour limit

Everything must happen within one hour of `up` (or `e2e`). The operator policy is valid for at most
3600 s and the installation cannot be renewed for the same account (#831). After that, messaging
stops; run `e2e` or `up` again — it wipes all local state and takes about 20 s to re-provision.

## What I ran myself and saw

- `stack.mjs e2e` from clean state on `0bd66d3`: all phases PASS in 49 s. In real (headless) Chrome
  against the production build: account created through normal onboarding; public evidence exported;
  operator approve and install into both relays; bot started; "Check installation" → "Ready: local
  demo installation verified. Encrypted messaging is enabled."; after a Chrome restart messaging
  resumed without pressing Check; Add Contact with the bot address opened the chat; one message sent
  (0.01 MON stamp); the reply rendered once. Screenshot:
  `/private/tmp/frank-stack/shots/10-chat-after-wait.png`.
- `stack.mjs chrome driven` opens a real Chrome window on that account (launch only checked).
- The lane that built the stack also saw three consecutive turns with no duplicates, and the
  correct pending state without the bot ("Bot: no installation status available", nothing sent or
  paid). Evidence: `/private/tmp/frank-stack/evidence/final/` (`e2e.log`, `shots/`, `wire-report.txt`
  with the hex of each canonical PUT and inbox GET).

## Real and stand-in

Real: the `cashwebd` relay binaries and their directory runtime; the production app bundle; Chrome;
the operator tool; the bot code; the local Qwen model; all signing, encryption, stamp payments and
the relay's verification of them.

Stand-ins: the chain is a local Hardhat node with Monad testnet's chain id (a shim substitutes the
pinned genesis hash and serves raw transactions; it automines instantly); TLS is a throwaway local
CA trusted by a Chrome flag; the relay clock file is written from this machine's time; relay
identity points are random with the private half discarded; bot roots are random and disposable.
relay-b is installed and reports status, but nothing is homed on it and nothing is forwarded.

## Known rough edges

- Fund the address on the **Receive** page. The Wallet page shows a different address and funding it
  does not help (#834). The wallet panel banner still says messaging is unavailable even when it
  works (#834).
- Text only. The only contact you can message is the installed bot.
- If the home relay restarts, the bot exits and must be restarted (`stack.mjs bot-start live`) (#835).
- A reply the bot cannot pay for, or a relay that keeps answering "retained", holds later messages
  with no recovery screen (#830, #831).
- The console shows "No registered profile found" for the bot; harmless (#835).
- UI polish is deferred by decision; findings about look and wording are ticketed, not fixed.

## Not proven

- Account recovery in the rendered app, tampered-ciphertext rejection in the app path, relay
  kill/restart mid-delivery, and the persona reviews: a persona run is in progress; results will be
  appended here.
- The chain RPC proxy now authenticates operator-installed directory subjects (needed for anything
  to work). That is an authority change with no unit test yet; it is under independent review as
  part of #833.
- Nothing has run against a real chain or a real TLS deployment.
- `yarn` on this machine is a broken symlink, so the newest app jest tests (which need
  `fake-indexeddb`) were not run in the `local-stack` worktree; they pass in the app worktree.

## Where it stops

- **Typed blackjack (#780):** implementation in progress in `.worktrees/issue-780-blackjack-canonical`;
  not in this checkout. The approved bundle allows exactly one bot, so a local session will run
  either Qwen or blackjack.
- **Two relays with forwarding and restart/store-and-forward (#779):** not started. Both relays run
  and are installed, but the UI and the bot are homed on relay-a.
- **Retiring the active protobuf/CBC paths (#780, #797):** not started.
- **Landing:** #825 is merged. The app cutover is PR #833 (CI and review in progress). The bot's
  canonical mode and the launcher are local branches (`issue-703-qwen-coupling` at `c2cb664`,
  `local-stack` at `0bd66d3`) to be opened as PRs stacked on #833.

## Decisions waiting for you

- Drop the identifying `POND` calldata from message payments (#826). Default: after this milestone,
  before any deployment.
- The one-hour installation lifetime and how renewal should work (#831).
- Whether a second identity may ever use canonical messaging at the same wallet storage (#832).
- Dead bot replies are cleaned up and acknowledged so one dead reply does not block later ones; the
  turn stays held (#830).
