import { resolve } from "path";
import type {
  FrankBotDefinition,
  BotProfile,
  BotContext,
  BotMessageContext,
  NewUserEvent,
} from "@frank/bot-framework";
import type { DigitalGoodsItem, MessageItem } from "@frank/cashweb/types/messages";
import { generateAvatarPng } from "../../bot-directory";
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
    };
  }

  async onNewUser(user: NewUserEvent, ctx: BotContext): Promise<void> {
    console.log(`[vendor] Proactively presenting catalog to new user ${user.address}`);
    try {
      await ctx.sendMessage(user.address, [
        catalogItem(this.catalog) as MessageItem,
        {
          type: "text",
          text: "Welcome to the Picture Shop! Browse the catalog above and tap any picture to purchase.",
        },
      ]);
    } catch (err) {
      console.warn(`[vendor] Failed to send catalog to new user ${user.address}:`, err);
    }
  }

  async onMessage(
    msgCtx: BotMessageContext,
    ctx: BotContext
  ): Promise<void> {
    const request = msgCtx.items.find(
      (item: any) => item.type === "digital-goods" && item.action === "request"
    ) as DigitalGoodsItem | undefined;

    if (!request) {
      // Send interactive catalog
      await msgCtx.reply([
        catalogItem(this.catalog) as MessageItem,
        {
          type: "text",
          text: `Welcome! We have ${this.catalog.length} items available. Tap any item to buy with testnet MON.`,
        },
      ]);
      return;
    }

    console.log(`[vendor] Purchase request for "${request.itemId}" from ${msgCtx.peerAddress}`);
    const item = this.catalog.find((candidate) => candidate.itemId === request.itemId);

    if (!item) {
      await msgCtx.reply([
        {
          type: "digital-goods",
          action: "error",
          message: `Unknown item: ${request.itemId}`,
        } as DigitalGoodsItem,
      ]);
      return;
    }

    // Fulfill item delivery
    console.log(`[vendor] Delivering "${item.itemId}" to ${msgCtx.peerAddress}`);
    const deliveryItems = buildFulfillItems(item);
    await msgCtx.reply([
      ...deliveryItems,
      {
        type: "text",
        text: `Thank you for your purchase! Delivered "${item.itemId}".`,
      },
    ]);
  }
}
