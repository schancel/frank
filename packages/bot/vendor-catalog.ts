/**
 * The vendor bot's catalog, loaded from a directory (#315) so a seller swaps content by
 * configuration, never by editing code:
 *
 *   <dir>/manifest.json   {"items": [{itemId, description, priceWei, image, thumbnail?}, ...]}
 *   <dir>/<image files>   png / jpg / gif / webp, referenced by relative path
 *
 * `VENDOR_BOT_CATALOG_DIR` selects the directory; the default is the bundled `demo-catalog/`
 * (three generated pictures, see `scripts/generate-demo-pictures.ts`).
 *
 * Everything is validated once, at startup, and a bad catalog is a clear error (never a
 * half-loaded shop): a delivered purchase or the catalog message that would not fit the relay's
 * 2 MiB request cap is refused here rather than failing at sale time after the buyer has paid.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";

import { MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES } from "@frank/cashweb/relay/message-envelope";
import { MAX_BLOB_BYTES } from "@frank/wallet/message-item-plugins/blob/codec";
import { encodeItemFrames } from "@frank/wallet/message-item-plugins/wire";
import { createBotMessageItemRegistry } from "./src/message-items";
import { MessageItem, BlobItem } from "@frank/cashweb/types/messages";

export const DEFAULT_CATALOG_DIR = join(__dirname, "demo-catalog");
export const MAX_CATALOG_ITEMS = 50;
/** A thumbnail is shown inline in a list, so it must stay small. */
export const MAX_THUMBNAIL_BYTES = 64 * 1024;

export interface VendorCatalogItem {
  itemId: string;
  description: string;
  priceWei: bigint;
  /** Native image content, sent as a blob entry with required MIME metadata. */
  image: BlobItem;
  /** Optional small `data:` URI shown in the catalog. */
  thumbnail?: string;
}

const MIME: Record<string, { mime: string; magic: number[] }> = {
  ".png": { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  ".jpg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".jpeg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".gif": { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  ".webp": { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] }, // plus WEBP at byte 8, below
};

function fail(dir: string, message: string): never {
  throw new Error(`Vendor catalog (${dir}): ${message}`);
}

function loadImage(
  dir: string,
  realDir: string,
  itemId: string,
  field: string,
  file: unknown
): BlobItem {
  if (typeof file !== "string" || file === "") {
    fail(dir, `item "${itemId}": "${field}" must be a file name`);
  }
  if (isAbsolute(file)) {
    fail(
      dir,
      `item "${itemId}": "${field}" must be relative to the catalog directory`
    );
  }
  const full = resolve(realDir, file);
  if (!existsSync(full)) {
    fail(dir, `item "${itemId}": ${field} file "${file}" does not exist`);
  }
  const real = realpathSync(full);
  const rel = relative(realDir, real);
  if (
    rel === "" ||
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    rel.split(sep)[0] === ".."
  ) {
    fail(
      dir,
      `item "${itemId}": ${field} "${file}" is outside the catalog directory`
    );
  }
  if (!lstatSync(real).isFile()) {
    fail(dir, `item "${itemId}": ${field} "${file}" is not a regular file`);
  }
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const kind = MIME[ext];
  if (!kind) {
    fail(
      dir,
      `item "${itemId}": ${field} "${file}" must be .png, .jpg, .gif or .webp`
    );
  }
  if (field === "image" && lstatSync(real).size > MAX_BLOB_BYTES) fail(dir, `item "${itemId}": image exceeds the ${MAX_BLOB_BYTES} byte blob limit`);
  const bytes = readFileSync(real);
  const webpOk =
    kind.mime !== "image/webp" ||
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!webpOk || !kind.magic.every((b, i) => bytes[i] === b)) {
    fail(
      dir,
      `item "${itemId}": ${field} "${file}" is not a valid ${kind.mime} file`
    );
  }
  return { type: "blob", mimeType: kind.mime, data: Uint8Array.from(bytes) };
}

function plaintextBytes(items: MessageItem[]): number {
  const registry = createBotMessageItemRegistry();
  return encodeItemFrames(registry, items).reduce((sum, frame) => sum + frame.length, 0);
}

/** Catalog thumbnails remain presentation metadata; fulfillment content is native binary. */
function loadDataUri(...args: Parameters<typeof loadImage>): string {
  const image = loadImage(...args);
  return `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`;
}

export function loadVendorCatalog(dir: string): VendorCatalogItem[] {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(
      dir,
      "manifest.json not found (set VENDOR_BOT_CATALOG_DIR to a directory containing one)"
    );
  }
  const realDir = realpathSync(dir);
  let manifest: { items?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(dir, `manifest.json is not valid JSON (${(err as Error).message})`);
  }
  const entries = manifest.items;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(dir, 'manifest.json needs a non-empty "items" array');
  }
  if (entries.length > MAX_CATALOG_ITEMS) {
    fail(
      dir,
      `at most ${MAX_CATALOG_ITEMS} items are supported, got ${entries.length}`
    );
  }

  const seen = new Set<string>();
  const items: VendorCatalogItem[] = entries.map(
    (entry: any, index: number) => {
      const itemId = entry?.itemId;
      if (
        typeof itemId !== "string" ||
        !/^[A-Za-z0-9_.-]{1,64}$/.test(itemId)
      ) {
        fail(
          dir,
          `item #${
            index + 1
          }: "itemId" must be 1-64 characters of A-Z a-z 0-9 _ . -`
        );
      }
      if (seen.has(itemId)) fail(dir, `duplicate itemId "${itemId}"`);
      seen.add(itemId);
      if (
        typeof entry.description !== "string" ||
        entry.description === "" ||
        entry.description.length > 200
      ) {
        fail(dir, `item "${itemId}": "description" must be 1-200 characters`);
      }
      if (
        typeof entry.priceWei !== "string" ||
        !/^[1-9][0-9]*$/.test(entry.priceWei)
      ) {
        fail(
          dir,
          `item "${itemId}": "priceWei" must be a positive integer string of wei`
        );
      }
      const image = loadImage(dir, realDir, itemId, "image", entry.image);
      const thumbnail =
        entry.thumbnail === undefined
          ? undefined
          : loadDataUri(dir, realDir, itemId, "thumbnail", entry.thumbnail);
      if (
        thumbnail !== undefined &&
        Buffer.byteLength(thumbnail) > MAX_THUMBNAIL_BYTES
      ) {
        fail(
          dir,
          `item "${itemId}": thumbnail is ${Buffer.byteLength(
            thumbnail
          )} bytes encoded, over the ${MAX_THUMBNAIL_BYTES} byte limit`
        );
      }
      const item: VendorCatalogItem = {
        itemId,
        description: entry.description,
        priceWei: BigInt(entry.priceWei),
        image,
        thumbnail,
      };
      let deliverySize: number;
      try { deliverySize = plaintextBytes(buildFulfillItems(item)); } catch (error) { fail(dir, `item "${itemId}": ${error instanceof Error ? error.message : String(error)}`); }
      if (deliverySize > MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES) {
        fail(
          dir,
          `item "${itemId}": delivering "${entry.image}" needs ${deliverySize} bytes, over the relay message limit of ${MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES} bytes; use a smaller image`
        );
      }
      return item;
    }
  );

  let catalogSize: number;
  try { catalogSize = plaintextBytes([catalogItem(items)]); } catch (error) { fail(dir, `catalog message: ${error instanceof Error ? error.message : String(error)}`); }
  if (catalogSize > MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES) {
    fail(
      dir,
      `the catalog message needs ${catalogSize} bytes, over the relay message limit of ${MAX_MONAD_ENVELOPE_PLAINTEXT_BYTES} bytes; use smaller thumbnails or fewer items`
    );
  }
  return items;
}

/** What the buyer receives after paying: the fulfilment marker plus the picture. */
export function buildFulfillItems(item: VendorCatalogItem): MessageItem[] {
  return [
    { type: "digital-goods", action: "fulfill", itemId: item.itemId },
    item.image,
  ];
}

export function catalogItem(items: VendorCatalogItem[]): MessageItem {
  return {
    type: "digital-goods",
    action: "catalog",
    catalog: items.map((item) => ({
      itemId: item.itemId,
      description: item.description,
      priceWei: item.priceWei.toString(),
      ...(item.thumbnail !== undefined ? { thumbnail: item.thumbnail } : {}),
    })),
  };
}
