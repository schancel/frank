# @frank/bot-framework

A unified, modular framework for building headless Frank bots on Monad testnet and mainnet.

## Overview

`@frank/bot-framework` abstracts the complex networking, cryptographic directory admissions, and EVM concurrency requirements needed to run automated bot identities over Frank.

Key features:

- **Canonical Open Directory Management**: Automatic generation and signing of Revision Zero and Next Revision directory attestations via `@frank/wallet` and `@frank/directory-admission`, with periodic heartbeat renewal before `binding_expiry_ns`. This ensures Frank clients never get `"Not Found: This address has not published itself yet"`.
- **Relay Profile Registration**: Publishes metadata profile fields (`name`, `bio`, `avatar`, and `bot: true`) to `/metadata/monad/:addr`.
- **Canonical CBOR Direct Messaging**: Full support for typed CBOR envelopes over `/message/monad/cbor` and `/message/monad/inbox`.
- **Shared EVM Nonce Sequencing (`EVMNonceSequencer`)**: Coordinates on-chain payout and funding transactions across multiple bots sharing a single bankroll account, eliminating EVM nonce collisions and transaction drops.
- **Durable LevelDB State Storage (`LevelBotStateStore`)**: Provides isolated, namespaced sublevel storage for game and conversation states.
- **Safety Invariants**:
  - `LoopGuard`: Eliminates self-echo loops, blocks denylisted peers and automated bots, and enforces per-peer reply rate limiting.
  - `PeerLaneQueue`: Serializes message processing per peer so concurrent moves/messages for the same user execute in strict FIFO order without race conditions, while allowing different peers to be served in parallel.
- **Multi-Bot In-Process Hosting (`FrankBotHost`)**: Run any number of bots concurrently in a single Node process, or run individual bots as standalone targets.
- **Proactive Discovery (`onNewUser`)**: Watches relay registration streams to proactively discover new Frank users and initiate contact (e.g. sending welcome messages and game rules).

## Usage

### Implementing a Bot

```typescript
import type {
  FrankBotDefinition,
  BotMessageContext,
  BotProfile,
  NewUserEvent,
  BotContext,
} from "@frank/bot-framework";

export class MyCustomBot implements FrankBotDefinition {
  readonly id = "my-bot";
  readonly label = "My Custom Bot";
  readonly defaultIdentityPath = "/tmp/my-bot-identity.json";

  getProfile(): BotProfile {
    return {
      name: "My Bot",
      bio: "An automated assistant built with Frank Bot Framework",
      bot: true,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    await ctx.sendDirectMessage(user.address, [
      { type: "text", text: `Welcome to Frank, ${user.displayAddress}!` },
    ]);
  }

  async onMessage(ctx: BotMessageContext): Promise<void> {
    await ctx.reply([
      {
        type: "text",
        text: `Received your message: ${ctx.items.length} item(s)`,
      },
    ]);
  }
}
```

### Running with FrankBotHost

```typescript
import { FrankBotHost } from "@frank/bot-framework";
import { MyCustomBot } from "./my-custom-bot";

async function main() {
  const host = new FrankBotHost({
    stateDir: "/path/to/state",
    relayBaseUrl: "https://relay.example.com",
    rpcUrl: "https://testnet-rpc.monad.xyz",
  });

  await host.register(new MyCustomBot());
  await host.start();
}

main().catch(console.error);
```
