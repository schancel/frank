/**
 * A bot's message as its recipient reads it: the items are encoded by the real message-item
 * codecs, as the send path encodes them, and decoded again. Tests that judge what a bot said use
 * this instead of hand-written items, so they cannot drift from what the bot really sends.
 */
import { installGroupMessageItemPlugins } from '@frank/group-messaging/groups/plugin'
import {
  encodeFrame,
  standaloneItemBudget,
  validateFrame,
  type Encodable,
} from "@frank/codec";
import type { MessageItem } from "@frank/cashweb/types/messages";
import { createDefaultMessageItemRegistry } from "@frank/wallet/message-item-plugins/default-registry";
import { pluginCapabilitiesNotYetAvailable } from "@frank/cashweb/message-items/registry";
import {
  decodeItemFrames,
  encodeItemFrames,
} from "@frank/wallet/message-item-plugins/wire";

const registry = installGroupMessageItemPlugins(
  createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
  pluginCapabilitiesNotYetAvailable,
);

/** Encodes as the send path does and reads back as a recipient does. */
export function overTheWire(items: MessageItem[]): MessageItem[] {
  const frames = encodeItemFrames(registry, items);
  const revision = validateFrame(
    encodeFrame(
      { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, "frank"],
        [1, frames],
      ])
    )
  );
  if (revision.kind !== "parsed" || revision.typed?.type !== 8)
    throw new Error("expected a revision");
  return decodeItemFrames(
    registry,
    revision.typed.items,
    standaloneItemBudget()
  );
}
