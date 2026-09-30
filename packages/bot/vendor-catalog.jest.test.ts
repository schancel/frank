import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES } from "@frank/cashweb/relay/monad-message-envelope";
import { serializeMessageItems } from "@frank/wallet/chain/monad-chain";

import {
  buildFulfillItems,
  catalogItem,
  DEFAULT_CATALOG_DIR,
  loadVendorCatalog,
  MAX_THUMBNAIL_BYTES,
} from "./vendor-catalog";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (extra = 0) => Buffer.concat([PNG_HEAD, Buffer.alloc(extra, 7)]);

describe("bundled demo catalog", () => {
  const items = loadVendorCatalog(DEFAULT_CATALOG_DIR);

  it("ships several distinct real pictures with thumbnails, each well under 100 KB", () => {
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(new Set(items.map((i) => i.image)).size).toBe(items.length);
    for (const item of items) {
      const raw = Buffer.from(item.image.split(",")[1], "base64");
      // Not the old 1x1 placeholder: real dimensions from the PNG header.
      expect(raw.readUInt32BE(16)).toBeGreaterThanOrEqual(320);
      expect(raw.readUInt32BE(20)).toBeGreaterThanOrEqual(200);
      expect(raw.length).toBeLessThan(100 * 1024);
      expect(item.thumbnail).toMatch(/^data:image\/png;base64,/);
      expect(item.thumbnail!.length).toBeLessThan(MAX_THUMBNAIL_BYTES);
    }
  });

  it("fits the relay message limit for the catalog and every delivery", () => {
    const bytes = (x: any) =>
      Buffer.byteLength(serializeMessageItems(x), "utf8");
    expect(bytes([catalogItem(items)])).toBeLessThan(
      MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES
    );
    for (const item of items) {
      expect(bytes(buildFulfillItems(item))).toBeLessThan(
        MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES
      );
    }
  });

  it("puts the thumbnail in the catalog wire item and the picture in the delivery", () => {
    const cat = catalogItem(items) as any;
    expect(cat.catalog[0].thumbnail).toBe(items[0].thumbnail);
    expect(cat.catalog[0].priceWei).toBe(items[0].priceWei.toString());
    expect(JSON.stringify(cat)).not.toContain(items[0].image);
    const [fulfill, image] = buildFulfillItems(items[0]) as any[];
    expect(fulfill).toMatchObject({
      action: "fulfill",
      itemId: items[0].itemId,
    });
    expect(image).toEqual({ type: "image", image: items[0].image });
  });
});

describe("loadVendorCatalog from a seller-supplied directory", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vendor-catalog-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const manifest = (items: unknown) =>
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ items }));
  const entry = (over: Record<string, unknown> = {}) => ({
    itemId: "cat",
    description: "A cat",
    priceWei: "1000",
    image: "cat.png",
    ...over,
  });

  it("loads whatever the manifest lists, with no code change", () => {
    writeFileSync(join(dir, "cat.png"), png(10));
    writeFileSync(join(dir, "cat-t.png"), png(5));
    manifest([entry({ thumbnail: "cat-t.png" })]);
    const [item] = loadVendorCatalog(dir);
    expect(item).toMatchObject({ itemId: "cat", priceWei: 1000n });
    expect(item.image).toBe(
      `data:image/png;base64,${png(10).toString("base64")}`
    );
    expect(item.thumbnail).toBe(
      `data:image/png;base64,${png(5).toString("base64")}`
    );
  });

  it("a thumbnail is optional", () => {
    writeFileSync(join(dir, "cat.png"), png());
    manifest([entry()]);
    const [item] = loadVendorCatalog(dir);
    expect(item.thumbnail).toBeUndefined();
    expect((catalogItem([item]) as any).catalog[0]).not.toHaveProperty(
      "thumbnail"
    );
  });

  it("refuses an image whose delivery would exceed the relay limit, naming the item", () => {
    writeFileSync(
      join(dir, "cat.png"),
      png(MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES)
    );
    manifest([entry()]);
    expect(() => loadVendorCatalog(dir)).toThrow(
      /item "cat".*over the relay message limit/
    );
  });

  it("accepts an image just under the limit (boundary)", () => {
    // base64 inflates by 4/3; leave room for the JSON wrapper around the data URI.
    const raw = Math.floor(
      ((MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES - 200) * 3) / 4
    );
    writeFileSync(join(dir, "cat.png"), png(raw - PNG_HEAD.length));
    manifest([entry()]);
    expect(loadVendorCatalog(dir)).toHaveLength(1);
  });

  it("refuses an oversized thumbnail", () => {
    writeFileSync(join(dir, "cat.png"), png());
    writeFileSync(join(dir, "t.png"), png(MAX_THUMBNAIL_BYTES));
    manifest([entry({ thumbnail: "t.png" })]);
    expect(() => loadVendorCatalog(dir)).toThrow(/thumbnail.*byte limit/);
  });

  it("refuses a catalog message that is too big in total", () => {
    const many = Array.from({ length: 50 }, (_, i) => {
      writeFileSync(join(dir, `t${i}.png`), png(MAX_THUMBNAIL_BYTES / 2));
      writeFileSync(join(dir, `i${i}.png`), png());
      return entry({
        itemId: `i${i}`,
        image: `i${i}.png`,
        thumbnail: `t${i}.png`,
      });
    });
    manifest(many);
    expect(() => loadVendorCatalog(dir)).toThrow(/catalog message/);
  });

  it.each([
    ["missing manifest", () => {}, /manifest.json not found/],
    [
      "bad JSON",
      () => writeFileSync(join(dir, "manifest.json"), "{"),
      /not valid JSON/,
    ],
    ["empty items", () => manifest([]), /non-empty/],
    ["bad itemId", () => manifest([entry({ itemId: "a b" })]), /itemId/],
    ["zero price", () => manifest([entry({ priceWei: "0" })]), /priceWei/],
    ["decimal price", () => manifest([entry({ priceWei: "0.5" })]), /priceWei/],
    [
      "missing image file",
      () => manifest([entry({ image: "nope.png" })]),
      /does not exist/,
    ],
    [
      "absolute path",
      () => manifest([entry({ image: "/etc/hosts" })]),
      /relative/,
    ],
  ])("rejects %s with a clear error", (_n, setup, re) => {
    setup();
    expect(() => loadVendorCatalog(dir)).toThrow(re as RegExp);
  });

  it("rejects duplicate ids, wrong file types and non-image bytes", () => {
    writeFileSync(join(dir, "cat.png"), png());
    writeFileSync(join(dir, "fake.png"), "not a png");
    writeFileSync(join(dir, "x.svg"), "<svg/>");
    manifest([entry(), entry()]);
    expect(() => loadVendorCatalog(dir)).toThrow(/duplicate/);
    manifest([entry({ image: "fake.png" })]);
    expect(() => loadVendorCatalog(dir)).toThrow(/not a valid image\/png/);
    manifest([entry({ image: "x.svg" })]);
    expect(() => loadVendorCatalog(dir)).toThrow(/must be \.png/);
  });

  it("a .webp must be RIFF....WEBP, not any RIFF container", () => {
    writeFileSync(
      join(dir, "w.webp"),
      Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4),
        Buffer.from("WAVE"),
        Buffer.alloc(20),
      ])
    );
    manifest([entry({ image: "w.webp" })]);
    expect(() => loadVendorCatalog(dir)).toThrow(/not a valid image\/webp/);
    writeFileSync(
      join(dir, "w.webp"),
      Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4),
        Buffer.from("WEBP"),
        Buffer.alloc(20),
      ])
    );
    expect(loadVendorCatalog(dir)).toHaveLength(1);
  });

  it("does not follow a path out of the catalog directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "vendor-outside-"));
    writeFileSync(join(outside, "secret.png"), png());
    mkdirSync(join(dir, "sub"));
    symlinkSync(join(outside, "secret.png"), join(dir, "sub", "link.png"));
    manifest([entry({ image: "sub/link.png" })]);
    expect(() => loadVendorCatalog(dir)).toThrow(
      /outside the catalog directory/
    );
    manifest([entry({ image: "../secret.png" })]);
    expect(() => loadVendorCatalog(dir)).toThrow(
      /outside the catalog directory|does not exist/
    );
    rmSync(outside, { recursive: true, force: true });
  });
});
