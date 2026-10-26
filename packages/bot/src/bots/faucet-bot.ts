import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
  BotScheduleDefinition,
} from "@frank/bot-framework";
import { ACCOUNT_TYPE_SERVICE, BOT_ROLE_FAUCET } from "@frank/codec";
import { generateAvatarPng } from "../../bot-directory";
import { Outbox, replyFree, sendFree } from "./money";

export const FAUCET_DEFAULT_AMOUNT_WEI = 50_000_000_000_000_000n; // 0.05 MON
export const FAUCET_DEFAULT_MIN_RESERVE_WEI = 100_000_000_000_000_000n; // 0.1 MON
/** The most one grant may be configured to: a misconfigured amount must not empty the wallet. */
export const MAX_AMOUNT_WEI = 1_000_000_000_000_000_000n; // 1 MON

/** State key of the new accounts the faucet was too low to grant at sign-up. */
const WAITING = "waiting_for_grant";

export interface FaucetBotOptions {
  /** What each profile is granted, once (`FAUCET_AMOUNT_WEI`). */
  amountWei?: bigint;
  /** The faucet wallet keeps at least this (`FAUCET_MIN_RESERVE_WEI`). */
  minReserveWei?: bigint;
}

/** Grants each account once, as the payment carried by its welcome message. */
export class FaucetBot implements FrankBotDefinition {
  readonly id = "faucet";
  readonly label = "Monad Faucet";
  readonly defaultIdentityPath =
    process.env.FAUCET_BOT_IDENTITY_JSON ?? "/tmp/faucet-bot-identity.json";

  private readonly outbox = new Outbox("faucet");
  readonly schedules: BotScheduleDefinition[] = [
    this.outbox.schedule,
    {
      // A new account the faucet was too low to grant at sign-up is granted here once the
      // faucet has been topped up (`paidMessageFunding`), without it having to ask again.
      id: "faucet-waiting",
      intervalMs: 30_000,
      runOnStartup: true,
      handler: (ctx) => this.grantWaiting(ctx),
    },
  ];

  private readonly amountWei: bigint;
  private readonly minReserveWei: bigint;
  /** Grants are decided one at a time: two for one profile never both pass the check. */
  private turn: Promise<unknown> = Promise.resolve();
  /** The waiting list changes one write at a time. */
  private waitingTail: Promise<unknown> = Promise.resolve();

  private waitingTurn<T>(run: () => Promise<T>): Promise<T> {
    const next = this.waitingTail.then(run, run);
    this.waitingTail = next.catch(() => undefined);
    return next;
  }

  constructor(options?: FaucetBotOptions) {
    this.amountWei =
      options?.amountWei ??
      (process.env.FAUCET_AMOUNT_WEI
        ? BigInt(process.env.FAUCET_AMOUNT_WEI)
        : FAUCET_DEFAULT_AMOUNT_WEI);
    if (this.amountWei <= 0n || this.amountWei > MAX_AMOUNT_WEI)
      throw new Error(
        `Faucet grant must be between 1 wei and ${MAX_AMOUNT_WEI} wei, got ${this.amountWei}`
      );
    this.minReserveWei =
      options?.minReserveWei ??
      (process.env.FAUCET_MIN_RESERVE_WEI
        ? BigInt(process.env.FAUCET_MIN_RESERVE_WEI)
        : FAUCET_DEFAULT_MIN_RESERVE_WEI);
  }

  get paidMessageFunding(): { belowWei: bigint; toWei: bigint } {
    const required = this.amountWei + this.minReserveWei;
    return { belowWei: required, toWei: required };
  }

  getProfile(): BotProfile {
    return {
      name: "Monad Faucet",
      bio: "Automated testnet faucet. Grants starter testnet coins to newly registered accounts.",
      avatarPng: generateAvatarPng("faucet", [40, 160, 220]),
      bot: true,
      accountType: ACCOUNT_TYPE_SERVICE,
      botRole: BOT_ROLE_FAUCET,
    };
  }

  /** Existing funded records remain authoritative, including ambiguous old bare transfers.
   * New grant ownership and its owed welcome are committed atomically before any send. */
  private grant(
    ctx: BotContext,
    address: string,
    conversationId?: string
  ): Promise<"queued" | "already" | "unresolved" | "failed" | "low"> {
    const run = async () => {
      const user = address.toLowerCase();
      const key = `funded:${user}`;
      const id = `grant:${user}`;
      const record = await ctx.state.get(key);
      if (record === "pending") return "unresolved" as const;
      if (await this.outbox.has(ctx, id)) {
        if (await this.outbox.failed(ctx, id)) return "failed" as const;
        return (await this.outbox.sent(ctx, id))
          ? ("already" as const)
          : ("queued" as const);
      }
      if (record !== undefined) return "already" as const;
      const spoken = await this.outbox.owedWei(ctx);
      const fee = (await ctx.minimumStampWei?.()) ?? 0n;
      if (
        (await ctx.getBalance()) <
        spoken + this.amountWei + this.minReserveWei + fee
      )
        return "low" as const;
      await this.outbox.owe(
        ctx,
        id,
        {
          to: address,
          conversationId,
          items: [
            {
              type: "text",
              text: `This is the Frank faucet. This message includes ${ctx.formatAmount(
                this.amountWei
              )} for you to start messaging.`,
            },
          ],
          valueWei: this.amountWei,
        },
        { writes: [{ type: "put", key, value: id }] }
      );
      return "queued" as const;
    };
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  /** New accounts waiting for a grant the faucet was too low to make when they signed up. */
  private async waiting(ctx: BotContext): Promise<string[]> {
    const raw = await ctx.state.get(WAITING);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  private async setWaiting(ctx: BotContext, addresses: string[]): Promise<void> {
    await ctx.state.put(WAITING, JSON.stringify(addresses));
  }

  /** Grants each waiting account that can be granted now; an account stays on the list only
   * while the faucet is still too low for it. */
  private grantWaiting(ctx: BotContext): Promise<void> {
    return this.waitingTurn(() => this.grantWaitingNow(ctx));
  }

  private async grantWaitingNow(ctx: BotContext): Promise<void> {
    const waiting = await this.waiting(ctx);
    if (!waiting.length) return;
    const still: string[] = [];
    let queued = false;
    for (const address of waiting) {
      try {
        const outcome = await this.grant(ctx, address);
        if (outcome === "low") still.push(address);
        if (outcome === "queued") queued = true;
      } catch (err) {
        still.push(address);
        console.warn(`[faucet] Waiting grant for ${address} not queued yet:`, err);
      }
    }
    await this.setWaiting(ctx, still);
    if (queued) await this.outbox.settle(ctx);
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      const outcome = await this.grant(ctx, user.address);
      if (outcome === "queued") await this.outbox.settle(ctx);
      if (outcome === "low" || outcome === "unresolved" || outcome === "failed")
        console.warn(`[faucet] Grant for ${user.address}: ${outcome}`);
      if (outcome === "low") {
        // Never silent: the new account is told, and granted once the faucet is topped up.
        const address = user.address.toLowerCase();
        await this.waitingTurn(async () => {
          const waiting = await this.waiting(ctx);
          if (!waiting.includes(address))
            await this.setWaiting(ctx, [...waiting, address]);
        });
        await sendFree(ctx, user.address, [
          {
            type: "text",
            text: "This is the Frank faucet. It is low right now, so your starter coins could not be sent yet. They are sent to you as soon as the faucet is topped up; you do not need to ask.",
          },
        ]);
      }
    } catch (err) {
      console.error(
        `[faucet] Failed to queue welcome for ${user.address}:`,
        err
      );
    }
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    let text: string;
    try {
      const outcome = await this.grant(
        ctx,
        msgCtx.peerAddress,
        msgCtx.conversationId
      );
      if (outcome === "queued") {
        await this.outbox.settle(ctx);
        return;
      }
      text =
        outcome === "already"
          ? "You have already received funds from the faucet. It grants once per account."
          : outcome === "failed"
          ? "Your faucet welcome could not be delivered and needs to be checked. It will not be paid again automatically."
          : outcome === "unresolved"
          ? "Your earlier faucet grant needs to be checked. It will not be sent again automatically."
          : "The faucet is at its reserve. Please check back later.";
    } catch (err) {
      console.error(`[faucet] Grant to ${msgCtx.peerAddress} failed:`, err);
      text =
        "The faucet could not queue your grant just now. Please try again later.";
    }
    await replyFree(msgCtx, [{ type: "text", text }]);
  }
}
