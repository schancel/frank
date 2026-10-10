import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import { formatMon } from "@frank/wallet/monad-amount";
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
 * nothing a profile or a message carries names a wallet's separate deposit address. The app
 * counts money there in the balance it shows, and the wallet pays message stamps from it. The
 * welcome message says where the money went.
 */
export class FaucetBot implements FrankBotDefinition {
  readonly id = "faucet";
  readonly label = "Monad Faucet";
  readonly defaultIdentityPath =
    process.env.FAUCET_BOT_IDENTITY_JSON ?? "/tmp/faucet-bot-identity.json";

  private readonly amountWei: bigint;
  private readonly minReserveWei: bigint;
  /** Grants are decided one at a time: two for one profile never both pass the check. */
  private turn: Promise<unknown> = Promise.resolve();

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
      bio: "Automated testnet faucet. Grants starter testnet MON to newly registered accounts.",
      avatarPng: generateAvatarPng("faucet", [40, 160, 220]),
      bot: true,
      accountType: ACCOUNT_TYPE_SERVICE,
      botRole: BOT_ROLE_FAUCET,
    };
  }

  /** Grants `address` once. `granted`: the transfer was broadcast now. `already`: this profile
   * was granted before. `low`: the faucet is at its reserve. A grant is recorded before its
   * transfer is sent; a record left unfinished by a crash counts as granted only if the address
   * holds the grant. */
  private grant(
    ctx: BotContext,
    address: string
  ): Promise<{ outcome: "granted"; txHash: string } | { outcome: "already" | "low" }> {
    const run = async () => {
      const key = `funded:${address.toLowerCase()}`;
      const record = await ctx.state.get(key);
      if (
        record !== undefined &&
        (record !== "pending" || (await ctx.getBalance(address)) >= this.amountWei)
      )
        return { outcome: "already" as const };
      if ((await ctx.getBalance()) < this.amountWei + this.minReserveWei)
        return { outcome: "low" as const };
      await ctx.state.put(key, "pending");
      const { txHash } = await ctx.sendTransfer({
        to: address,
        valueWei: this.amountWei,
      });
      await ctx.state.put(key, txHash);
      return { outcome: "granted" as const, txHash };
    };
    const next = this.turn.then(run, run);
    this.turn = next.catch(() => undefined);
    return next;
  }

  private sentText(address: string, txHash: string): string {
    return `Sent ${formatMon(
      this.amountWei
    )} to your profile address ${address} (transaction ${txHash}). It is part of the balance your wallet shows.`;
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    try {
      const result = await this.grant(ctx, user.address);
      if (result.outcome === "low")
        console.warn(`[faucet] At the reserve; ${user.address} not funded`);
      if (result.outcome !== "granted") return;
      console.log(`[faucet] Funded ${user.address} (tx: ${result.txHash})`);
      await sendFree(ctx, user.address, [
        {
          type: "text",
          text: `Welcome to Frank. ${this.sentText(user.address, result.txHash)}`,
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
        result.outcome === "granted"
          ? this.sentText(msgCtx.peerAddress, result.txHash)
          : result.outcome === "already"
          ? "You have already received funds from the faucet. It grants once per account."
          : "The faucet is at its reserve. Please check back later.";
    } catch (err) {
      console.error(`[faucet] Grant to ${msgCtx.peerAddress} failed:`, err);
      text =
        "The faucet could not send your grant just now. Send any message to try again.";
    }
    await replyFree(msgCtx, [{ type: "text", text }]);
  }
}
