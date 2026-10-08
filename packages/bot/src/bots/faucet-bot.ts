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

export const FAUCET_DEFAULT_AMOUNT_WEI = 50_000_000_000_000_000n; // 0.05 MON
export const FAUCET_DEFAULT_MIN_RESERVE_WEI = 100_000_000_000_000_000n; // 0.1 MON
export const FAUCET_DEFAULT_MAX_PER_RUN = 1000;
export const FAUCET_DEFAULT_MAX_PER_DAY = 100;

export interface FaucetBotOptions {
  amountWei?: bigint;
  minReserveWei?: bigint;
  maxPerRun?: number;
  maxPerDay?: number;
}

export class FaucetBot implements FrankBotDefinition {
  readonly id = "faucet";
  readonly label = "Monad Faucet";
  readonly defaultIdentityPath =
    process.env.FAUCET_BOT_IDENTITY_JSON ?? "/tmp/faucet-bot-identity.json";

  private readonly amountWei: bigint;
  private readonly minReserveWei: bigint;
  private readonly maxPerRun: number;
  private readonly maxPerDay: number;
  private fundedThisRun = 0;

  constructor(options?: FaucetBotOptions) {
    this.amountWei =
      options?.amountWei ??
      (process.env.FAUCET_AMOUNT_WEI
        ? BigInt(process.env.FAUCET_AMOUNT_WEI)
        : FAUCET_DEFAULT_AMOUNT_WEI);
    this.minReserveWei =
      options?.minReserveWei ??
      (process.env.FAUCET_MIN_RESERVE_WEI
        ? BigInt(process.env.FAUCET_MIN_RESERVE_WEI)
        : FAUCET_DEFAULT_MIN_RESERVE_WEI);
    this.maxPerRun =
      options?.maxPerRun ??
      (process.env.FAUCET_MAX_PER_RUN
        ? parseInt(process.env.FAUCET_MAX_PER_RUN, 10)
        : FAUCET_DEFAULT_MAX_PER_RUN);
    this.maxPerDay =
      options?.maxPerDay ??
      (process.env.FAUCET_MAX_PER_DAY
        ? parseInt(process.env.FAUCET_MAX_PER_DAY, 10)
        : FAUCET_DEFAULT_MAX_PER_DAY);
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

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    const addr = user.address.toLowerCase();
    const alreadyFunded = await ctx.state.get(`funded:${addr}`);
    if (alreadyFunded) {
      return;
    }

    if (this.fundedThisRun >= this.maxPerRun) {
      console.warn(`[faucet] Run limit reached (${this.maxPerRun}); skipping ${user.address}`);
      return;
    }

    try {
      const faucetBalance = await ctx.getBalance();
      if (faucetBalance < this.amountWei + this.minReserveWei) {
        console.warn(
          `[faucet] Balance too low (${formatMon(faucetBalance)}) to fund ${user.address}`
        );
        return;
      }

      if (ctx.provider && typeof ctx.provider.getBalance === "function") {
        try {
          const userBalance = await ctx.provider.getBalance(user.address);
          if (userBalance >= this.amountWei) {
            console.log(
              `[faucet] User ${user.address} already has balance (${formatMon(userBalance)}); skipping`
            );
            await ctx.state.put(`funded:${addr}`, "skipped:has_funds");
            return;
          }
        } catch {
          // Non-blocking on provider lookup error
        }
      }

      console.log(`[faucet] Funding new user ${user.address} with ${formatMon(this.amountWei)}`);

      const { txHash } = await ctx.sendTransfer({
        to: user.address,
        valueWei: this.amountWei,
      });

      await ctx.state.put(`funded:${addr}`, String(Date.now()));
      this.fundedThisRun++;

      console.log(`[faucet] Funded ${user.address} (tx: ${txHash})`);

      try {
        await ctx.sendMessage(user.address, [
          {
            type: "text",
            text: `Welcome to Frank! We sent ${formatMon(
              this.amountWei
            )} to your wallet (${txHash.slice(0, 12)}...) to get you started.`,
          },
        ]);
      } catch (dmErr) {
        console.warn(`[faucet] Failed to send welcome DM to ${user.address}:`, dmErr);
      }
    } catch (err) {
      await ctx.state.del(`funded:${addr}`).catch(() => {});
      console.error(`[faucet] Failed to fund ${user.address}:`, err);
    }
  }

  async onMessage(
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<void> {
    const addr = msgCtx.peerAddress.toLowerCase();
    const alreadyFunded = await ctx.state.get(`funded:${addr}`);

    if (alreadyFunded && alreadyFunded !== "skipped:has_funds") {
      await msgCtx.reply([
        {
          type: "text",
          text: "You have already received funds from the faucet. Faucet grants are limited to once per account.",
        },
      ]);
      return;
    }

    try {
      const faucetBalance = await ctx.getBalance();
      if (faucetBalance < this.amountWei + this.minReserveWei) {
        await msgCtx.reply([
          {
            type: "text",
            text: "The faucet reserve is currently low. Please check back later.",
          },
        ]);
        return;
      }

      console.log(`[faucet] Funding request from ${msgCtx.peerAddress}`);
      await ctx.state.put(`funded:${addr}`, String(Date.now()));
      this.fundedThisRun++;

      const { txHash } = await ctx.sendTransfer({
        to: msgCtx.peerAddress,
        valueWei: this.amountWei,
      });

      await msgCtx.reply([
        {
          type: "text",
          text: `Sent ${formatMon(this.amountWei)} to your wallet! Transaction: ${txHash}`,
        },
      ]);
    } catch (err) {
      console.error(`[faucet] Error processing request from ${msgCtx.peerAddress}:`, err);
      await msgCtx.reply([
        {
          type: "text",
          text: "Sorry, an error occurred while processing your faucet grant. Please try again later.",
        },
      ]);
    }
  }
}
