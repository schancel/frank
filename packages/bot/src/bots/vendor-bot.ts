import { resolve } from "path";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  InterruptedMessage,
  NewUserEvent,
} from "@frank/bot-framework";
import type { DigitalGoodsItem, MessageItem } from "@frank/cashweb/types/messages";
import { ACCOUNT_TYPE_BOT, BOT_ROLE_MERCHANT } from "@frank/codec";
import { formatMon } from "@frank/wallet/monad-amount";
import { generateAvatarPng } from "../../bot-directory";
import { Outbox, refuse, type Received, replyFree, sendFree } from "./money";
import {
  buildFulfillItems,
  catalogItem,
  DEFAULT_CATALOG_DIR,
  loadVendorCatalog,
  type VendorCatalogItem,
} from "../../vendor-catalog";

export class VendorBot implements FrankBotDefinition {
  readonly id = "vendor";
  readonly label = "Picture Shop";
  readonly defaultIdentityPath =
    process.env.VENDOR_BOT_IDENTITY_JSON ?? "/tmp/vendor-bot-identity.json";

  private readonly catalog: VendorCatalogItem[];
  private readonly outbox = new Outbox("vendor");
  readonly schedules = [this.outbox.schedule];

  constructor(options?: { catalogDir?: string; catalogItems?: VendorCatalogItem[] }) {
    if (options?.catalogItems) {
      this.catalog = options.catalogItems;
    } else {
      const dir = resolve(
        process.cwd(),
        options?.catalogDir ??
          process.env.VENDOR_BOT_CATALOG_DIR ??
          DEFAULT_CATALOG_DIR
      );
      this.catalog = loadVendorCatalog(dir);
    }
  }

  getProfile(): BotProfile {
    return {
      name: "Picture Shop",
      bio: "Automated store selling demo pictures. Send any message to see the catalog.",
      avatarPng: generateAvatarPng("vendor", [60, 150, 90]),
      bot: true,
      accountType: ACCOUNT_TYPE_BOT,
      botRole: BOT_ROLE_MERCHANT,
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(`[vendor] Proactively presenting catalog to new user ${user.address}`);
    try {
      await sendFree(ctx, user.address, [
        catalogItem(this.catalog) as MessageItem,
        {
          type: "text",
          text: "Welcome to the Picture Shop. The price of a picture is paid with your purchase message: use Buy on the catalog.",
        },
      ]);
    } catch (err) {
      console.warn(`[vendor] Failed to send catalog to new user ${user.address}:`, err);
    }
  }

  /** A message cut off by a crash: what it paid is accounted for (see `Outbox.interrupted`). */
  onInterrupted(message: InterruptedMessage, ctx: BotContext): Promise<void> {
    return this.outbox.interrupted(ctx, message);
  }

  async onMessage(msgCtx: BotMessageContext, ctx: BotContext): Promise<void> {
    const request = msgCtx.items.find(
      (item): item is DigitalGoodsItem =>
        item.type === "digital-goods" && item.action === "request"
    );
    if (!request) {
      await replyFree(msgCtx, [
        catalogItem(this.catalog) as MessageItem,
        {
          type: "text",
          text: `${this.catalog.length} pictures for sale. The price is paid with your purchase message: use Buy on the catalog.`,
        },
      ]);
      return;
    }

    // What the purchase paid, on chain. The price is never taken on trust.
    return this.outbox.handle(msgCtx, ctx, (received) =>
      this.sell(request, msgCtx, ctx, received)
    );
  }

  private async sell(
    request: DigitalGoodsItem,
    msgCtx: BotMessageContext,
    ctx: BotContext,
    received: Received
  ): Promise<void> {
    const refused = (why: string) =>
      refuse(this.outbox, msgCtx, ctx, received, why, [
        { type: "digital-goods", action: "error", message: why },
      ]);
    const item = this.catalog.find(
      (candidate) => candidate.itemId === request.itemId
    );
    if (!item)
      return refused(`There is no item "${request.itemId}". Nothing was sold.`);
    if (received.unconfirmed.length > 0 || received.confirmedWei < item.priceWei)
      return refused(
        `"${item.itemId}" costs ${formatMon(item.priceWei)} and ${formatMon(
          received.confirmedWei
        )} is confirmed as paid with your message. Nothing was sold.`
      );

    // Paid for: the delivery is written down before it is sent, and sent until it has gone.
    // Anything paid above the price goes back with the picture.
    const excessWei = received.confirmedWei - item.priceWei;
    await this.outbox.owe(
      ctx,
      `sale:${msgCtx.payloadDigest}`,
      {
        to: msgCtx.peerAddress,
        conversationId: msgCtx.conversationId,
        items: [
          ...buildFulfillItems(item),
          {
            type: "text",
            text:
              `Thank you. Here is "${item.itemId}".` +
              (excessWei > 0n
                ? ` You paid ${formatMon(excessWei)} more than the price; it is returned with this message.`
                : ""),
          },
        ],
        valueWei: excessWei,
      },
      { digest: msgCtx.payloadDigest }
    );
    await this.outbox.settle(ctx);
  }
}
