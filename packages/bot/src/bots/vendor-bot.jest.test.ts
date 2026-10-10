import type { DigitalGoodsItem } from "@frank/cashweb/types/messages";
import type { VendorCatalogItem } from "../../vendor-catalog";
import { harness, PLAYER } from "./bot-harness.testutil";
import { VendorBot } from "./vendor-bot";

const PRICE = 10_000_000_000_000_000n;
const catalog: VendorCatalogItem[] = [
  {
    itemId: "test-art-1",
    description: "Test Art 1",
    priceWei: PRICE,
    image:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  },
];
const BUY: DigitalGoodsItem = {
  type: "digital-goods",
  action: "request",
  itemId: "test-art-1",
};
const delivered = (h: ReturnType<typeof harness>) =>
  h.sent.some((m) => m.items.some((i) => i.type === "image"));

describe("VendorBot", () => {
  test("shows the catalog to a new user and to any other message", async () => {
    const h = harness();
    const bot = new VendorBot({ catalogItems: catalog });
    await bot.onNewUser({ address: PLAYER, registeredAtMs: 1 }, h.ctx);
    await bot.onMessage(h.message([{ type: "text", text: "hi" }]), h.ctx);
    expect(h.sent.map((m) => h.item("digital-goods", m).action)).toEqual([
      "catalog",
      "catalog",
    ]);
  });

  test("no payment, no goods", async () => {
    const h = harness();
    const bot = new VendorBot({ catalogItems: catalog });
    await bot.onMessage(h.message([BUY]), h.ctx);
    expect(delivered(h)).toBe(false);
    expect(h.item("digital-goods").action).toBe("error");
    expect(h.paidOut()).toBe(0n);
  });

  test("a payment the chain does not show buys nothing", async () => {
    const h = harness();
    const bot = new VendorBot({ catalogItems: catalog });
    await bot.onMessage(h.message([BUY], [h.pay(PRICE, { status: 0 })]), h.ctx);
    expect(delivered(h)).toBe(false);
  });

  test("an under-payment buys nothing and is returned", async () => {
    const h = harness();
    const bot = new VendorBot({ catalogItems: catalog });
    await bot.onMessage(h.message([BUY], [h.pay(PRICE - 1n)]), h.ctx);
    expect(delivered(h)).toBe(false);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].valueWei).toBe(PRICE - 1n);
  });

  test("a payment for an item that does not exist is returned", async () => {
    const h = harness();
    const bot = new VendorBot({ catalogItems: catalog });
    await bot.onMessage(
      h.message([{ ...BUY, itemId: "missing" }], [h.pay(PRICE)]),
      h.ctx
    );
    expect(delivered(h)).toBe(false);
    expect(h.sent[0].valueWei).toBe(PRICE);
  });

  test("the price, confirmed, delivers the picture once", async () => {
    const h = harness();
    const bot = new VendorBot({ catalogItems: catalog });
    await bot.onMessage(h.message([BUY], [h.pay(PRICE)]), h.ctx);
    expect(delivered(h)).toBe(true);
    expect(h.item("digital-goods").action).toBe("fulfill");
    expect(h.paidOut()).toBe(0n);
    expect(h.sent).toHaveLength(1);
  });

  test("a delivery that cannot be sent is kept and sent later", async () => {
    const h = harness();
    const bot = new VendorBot({ catalogItems: catalog });
    h.failSends(new Error("relay unreachable"));
    await bot.onMessage(h.message([BUY], [h.pay(PRICE)]), h.ctx);
    expect(delivered(h)).toBe(false);
    h.failSends();
    await new VendorBot({ catalogItems: catalog }).schedules[0].handler(h.ctx);
    expect(delivered(h)).toBe(true);
    expect(h.sent).toHaveLength(1);
  });
});
