import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

import { deriveDomainRoot } from "@frank/domain-roots";
import { MonadIdentity } from "@frank/wallet/monad-identity";
import type { MonadRootBundle } from "@frank/wallet/monad-wallet-material";
import { canonicalNetworkDescriptor } from "@frank/cashweb/relay/canonical-dm-transport";

import { LevelBotStateStore } from "./state-store";
import { InboundOperationStore } from "./inbound-operation-store";

export interface BotProfileLocation {
  /** The host's state directory; the profile lives in `<stateDir>/bots/<botId>`. */
  stateDir: string;
  botId: string;
  /** The bot's exported identity file, if it has one. Only its existence is checked. */
  identityPath?: string;
}

export interface AdmittedBotProfile {
  botStateDir: string;
  state: LevelBotStateStore;
  operations: InboundOperationStore;
  roots: MonadRootBundle;
}

/** Opens a bot profile for the canonical network `network`, creating it only when nothing of it
 * exists yet. The single admission rule, shared by the host and by provisioning:
 *
 * - a profile whose store carries the owner marker is reopened and must match its account root;
 * - a profile is created (account root, then owner marker) only when the directory holds no
 *   account root, no state store and no other file, and no identity file exists for it;
 * - anything in between is held unchanged. A new state path paired with a previously provisioned
 *   identity is not a fresh financial profile.
 *
 * The caller owns the returned store and operations and must close both. */
export async function admitBotProfile(
  location: BotProfileLocation & { network: string }
): Promise<AdmittedBotProfile> {
  const botStateDir = join(location.stateDir, "bots", location.botId);
  mkdirSync(botStateDir, { recursive: true, mode: 0o700 });

  const rootFile = join(botStateDir, "account-root.hex");
  const hadRoot = existsSync(rootFile);
  const hadIdentity =
    !!location.identityPath && existsSync(location.identityPath);
  const hadOtherFiles = readdirSync(botStateDir).some(
    (name) => name !== "state"
  );
  const statePath = join(botStateDir, "state");
  // An empty unversioned state path is still an existing profile. Opening Level
  // creates this path, so capture its prior existence before opening it.
  const hadState = existsSync(statePath);
  const state = await LevelBotStateStore.open(statePath);
  let operations: InboundOperationStore | undefined;
  try {
    const fresh = await InboundOperationStore.preflight(
      state,
      !hadRoot && !hadIdentity && !hadOtherFiles && !hadState
    );
    if (!fresh && !hadRoot)
      throw new Error("Bot admission root missing; preserve state");
    const rootHex = hadRoot
      ? readFileSync(rootFile, "utf8").trim()
      : randomBytes(32).toString("hex");
    if (!/^[0-9a-f]{64}$/i.test(rootHex))
      throw new Error("Bot admission root invalid; preserve state");
    if (!hadRoot) writeFileSync(rootFile, rootHex, { mode: 0o600, flag: "wx" });
    const accountRoot = Uint8Array.from(Buffer.from(rootHex, "hex"));
    const roots = {
      evm: deriveDomainRoot(accountRoot, "evm-wallet"),
      authentication: deriveDomainRoot(accountRoot, "identity-authentication"),
      messaging: deriveDomainRoot(accountRoot, "messaging-encryption"),
    };
    accountRoot.fill(0);
    const expected = MonadIdentity.fromDomainRoot(roots.authentication);
    operations = await InboundOperationStore.open(
      state,
      {
        chainIdentifier: location.network,
        botId: location.botId,
        subject: expected.compressedPubKey.toString("hex"),
        address: expected.address.raw.toLowerCase(),
      },
      fresh
    );
    return { botStateDir, state, operations, roots };
  } catch (error) {
    await operations?.close();
    await state.close();
    throw error;
  }
}

/** Creates a bot profile ahead of the bot's first start, or reopens one the host already owns,
 * and returns its identity. For a launcher that has to publish a bot's address before the bot
 * runs: the profile it leaves behind is exactly what `FrankBotHost.register` would have created,
 * so the host admits it afterwards. Holds under the same rule as the host; never adopts an
 * identity or account root that something else wrote. */
export async function provisionBotProfile(
  location: BotProfileLocation & { networkTag: string }
): Promise<MonadIdentity> {
  const { state, operations, roots } = await admitBotProfile({
    ...location,
    network: canonicalNetworkDescriptor(location.networkTag).network,
  });
  try {
    return MonadIdentity.fromDomainRoot(roots.authentication);
  } finally {
    await operations.close();
    await state.close();
  }
}
