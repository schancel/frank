# Manual test: Frank Open Directory, P2P Blackjack & Bots

Last updated 2026-10-04 16:25 PDT. This describes the **new open design**:
- No operator approval file or installation step.
- Open directory registration: account signs its own entry on creation and publishes it to the relay.
- P2P encrypted direct messaging knowing only the recipient's address.
- P2P Blackjack plugin with stamp-based wagers from the message-types menu.
- Headless bots: Qwen bot (hosted Alibaba Cloud API using `~/.frank-demo-qwen.env`) and Blackjack bot (auto-challenges fresh accounts).
- Stuck-dealer recovery: interrupted/cut-off dealer sends are safely recovered when reopening the chat, without double-spending stamps.

## Exact Branch & Commit

- Branch: `integration-open`
- Commit: `e0201ee` (pushed to origin)
- Worktree: `/Users/shammah/repos/frank/.worktrees/integration-open`

## What Was Run & Verified

The coordinator executed `node demo/local-stack/stack.mjs e2e live` which completed in 1104 s with `exit=0`:
1. **Onboarding**: Alice and Bob onboard without any operator approval or Settings export.
2. **Encrypted DM**: Alice messages Bob by address, Bob receives and replies, Alice receives.
3. **Unpublished Address Refusal**: An unpublished address cannot be added as a contact and burns 0 MON.
4. **Qwen Bot**: Alice messages the Qwen bot; Qwen 3.8 Max answers via the cloud API in ~3.2 s (local Ollama is NOT used).
5. **Blackjack vs Bot**:
   - The bot automatically challenges Alice upon detecting her registration.
   - Alice plays as player against bot dealer (wagers, cards, hit/stand, payout verified on-chain).
   - Alice challenges bot with Alice as dealer; bot accepts, plays, and hand completes.
6. **Blackjack Human-to-Human**:
   - Alice challenges Bob (Alice deals, Bob bets and plays).
   - Bob challenges Alice (Bob deals, Alice bets and plays).
   - Hostile dealer interrupt test: dealer window killed mid-deal; on reopen, deal is safely recovered and delivered once, and hand finishes cleanly.
7. **Cross-Relay Refusal**: Carol on relay-b cannot message Alice on relay-a yet (phase 2 replication is in progress in `open-relay`).

All 143 unit test cases across `blackjack-hand`, `ChatMessageBlackjack`, `Chat.sendFollowUp`, and `chats.outgoing` pass.

## Quickest Path: Test Live Now

The local stack is already running in `/Users/shammah/repos/frank/.worktrees/integration-open`.

### 1. Open the UI in Chrome
Run:
```sh
cd /Users/shammah/repos/frank/.worktrees/integration-open
node demo/local-stack/stack.mjs chrome alice
```
(A browser window has already been opened for you).

In the browser:
- Complete onboarding (choose any username / create account).
- Note your address from the **Receive** page (e.g. `0x...`).

### 2. Fund your account
In terminal:
```sh
node demo/local-stack/stack.mjs fund <your-receive-address>
```
This gives you 5 local MON for stamps and bets.

### 3. Test Qwen Bot
- The Qwen bot is already in your contact list.
- Click into the conversation with the Qwen bot.
- Send a message (e.g., "Hello, what is two plus two?").
- Qwen answers using Alibaba Cloud Qwen 3.8 Max.

### 4. Test Blackjack Bot
- The Blackjack bot will challenge you automatically when it detects your account on the relay.
- Open the bot's chat and place a bet.
- Play buttons (Hit / Stand) will guide your turns.
- Payout happens automatically via stealth stamp.
- You can also challenge the bot yourself: click the "+" icon next to the message composer, select **Blackjack challenge**, choose your role and max bet.

### 5. Test Two Users (Human vs Human)
Open a second window with a distinct throwaway profile:
```sh
node demo/local-stack/stack.mjs chrome bob
```
- Onboard Bob.
- Fund Bob: `node demo/local-stack/stack.mjs fund <bob-receive-address>`
- Add Alice's address to Bob's contacts, and Bob's address to Alice's contacts.
- Message each other, or challenge each other to Blackjack!

### Stop the stack when done
```sh
node demo/local-stack/stack.mjs down
```

## What Does Not Work Yet

1. **Cross-relay store-and-forward (Phase 2)**: Carol on relay-b cannot yet message Alice on relay-a. Phase 2 relay code has passed initial tests on branch `open-directory-relay` and is undergoing independent review before being merged into `integration-open`.
2. **Escrow contracts / Adaptor signatures**: Money moves strictly via stealth stamp payments (Requirements 1-4). Escrow via adaptor signatures is deferred until the stamp-based flow is fully vetted.
