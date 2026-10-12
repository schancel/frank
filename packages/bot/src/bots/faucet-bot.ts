import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { ACCOUNT_TYPE_SERVICE, BOT_ROLE_FAUCET } from "@frank/codec";
import { generateAvatarPng } from "../../bot-directory";
import { replyFree, sendFree } from "./money";

export const FAUCET_DEFAULT_AMOUNT_WEI = 50_000_000_000_000_000n; // 0.05 MON
export const FAUCET_DEFAULT_MIN_RESERVE_WEI = 100_000_000_000_000_000n; // 0.1 MON
/** The most one grant may be configured to: a misconfigured amount must not empty the wallet. */
export const MAX_AMOUNT_WEI = 1_000_000_000_000_000_000n; // 1 MON

export interface FaucetBotOptions {
  /** What each profile is granted, once (`FAUCET_AMOUNT_WEI`). */
  amountWei?: bigint;
  /** The faucet wallet keeps at least this (`FAUCET_MIN_RESERVE_WEI`). */
  minReserveWei?: bigint;
}

/**
 * Grants each profile testnet funds once: when it registers, or when it asks.
 *
 * The grant goes to the profile's own address, the only address of a user a sender can learn:
 * nothing a profile or a message carries names a wallet's separate deposit address. The wallet
 * counts money there in its balance and spends from it like from any other coin it holds. The
 * welcome message says where the money went.
 */
export class FaucetBot implements FrankBotDefinition {
  readonly id = "faucet";
  readonly label = "Monad Faucet";
  readonly defaultIdentityPath =
    process.env.FAUCET_BOT_IDENTITY_JSON ?? "/tmp/faucet-bot-identity.json";

  private readonly amountWei: bigint;
  private readonly minReserveWei: bigint;

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

  readonly schedules = [
    {
      id: "recover-grants",
      intervalMs: 15_000,
      runOnStartup: true,
      handler: async (ctx: BotContext) => {
        if (!ctx.nativeGrants)
          throw new Error("Durable faucet grant capability unavailable");
        await ctx.nativeGrants.resume();
      },
    },
  ];

  private async grant(ctx: BotContext, address: string) {
    // Old development grant records lack a binding to the wallet's signed operation. Never
    // turn that uncertainty into permission to pay again, even when the recipient spent it.
    if ((await ctx.state.get(`funded:${address.toLowerCase()}`)) !== undefined)
      throw new Error(
        "Legacy faucet grant requires explicit reconciliation; preserve state"
      );
    if (!ctx.nativeGrants)
      throw new Error("Durable faucet grant capability unavailable");
    return ctx.nativeGrants.grant({
      to: address,
      valueWei: this.amountWei,
      minReserveWei: this.minReserveWei,
    });
  }

  private sentText(
    ctx: BotContext,
    address: string,
    txHash: string,
    confirmed: boolean
  ): string {
    return `${confirmed ? "Sent" : "Submitted"} ${ctx.formatAmount(
      this.amountWei
    )} to your profile address ${address} (transaction ${txHash}). ${
      confirmed
        ? "It is part of the balance your wallet shows."
        : "Confirmation is still pending."
    }`;
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      const result = await this.grant(ctx, user.address);
      if (result.state === "low")
        console.warn(`[faucet] At the reserve; ${user.address} not funded`);
      if (
        result.already ||
        !result.txHash ||
        (result.state !== "submitted" && result.state !== "confirmed")
      )
        return;
      console.log(`[faucet] Funded ${user.address} (tx: ${result.txHash})`);
      await sendFree(ctx, user.address, [
        {
          type: "text",
          text: `Welcome to Frank. ${this.sentText(
            ctx,
            user.address,
            result.txHash,
            result.state === "confirmed"
          )}`,
        },
      ]);
    } catch (err) {
      console.error(`[faucet] Failed to fund or greet ${user.address}:`, err);
    }
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    let text: string;
    try {
      const result = await this.grant(ctx, msgCtx.peerAddress);
      text =
        result.state === "confirmed" && result.already
          ? "You have already received funds from the faucet. It grants once per account."
          : (result.state === "confirmed" || result.state === "submitted") &&
            result.txHash
          ? this.sentText(
              ctx,
              msgCtx.peerAddress,
              result.txHash,
              result.state === "confirmed"
            )
          : result.state === "low"
          ? "The faucet is at its reserve. Please check back later."
          : result.state === "failed"
          ? "Your original faucet grant needs review. No replacement payment was created."
          : "Your original faucet grant is being checked. Sending another message will check the same payment.";
    } catch (err) {
      console.error(`[faucet] Grant to ${msgCtx.peerAddress} failed:`, err);
      text =
        "The faucet could not send your grant just now. Send any message to try again.";
    }
    await replyFree(msgCtx, [{ type: "text", text }]);
  }
}
