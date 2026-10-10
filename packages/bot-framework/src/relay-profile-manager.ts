import {
  fetchMonadProfile,
  registerMonadIdentity,
  registerMonadIdentityCbor,
  type MonadIdentity,
  type MonadProfileFields,
} from "@frank/wallet/monad-identity";
import {
  UsernameError,
  claimUsername,
} from "@frank/cashweb/relay/username-client";
import type { BotProfile } from "./types";

export class RelayProfileManager {
  /**
   * Claims the bot's unique username on the relay, signed by the bot's identity key. The name
   * is `profile.username`, or the bot's id (`label`). Call after the bot's directory entry is
   * published: the relay gives names only to published accounts. Claiming a name the bot
   * already holds changes nothing. A refusal is logged and does not stop the bot.
   */
  static async claimUsername(params: {
    relayBaseUrl: string;
    /** Canonical network of the relay's directory, e.g. `monad-testnet`. */
    network: string;
    identity: MonadIdentity;
    label: string;
    profile: BotProfile;
  }): Promise<void> {
    const username = params.profile.username ?? params.label;
    try {
      const held = await claimUsername({
        relayBaseUrl: params.relayBaseUrl,
        network: params.network,
        signer: params.identity,
        username,
      });
      console.log(
        `[${params.label}] username @${held.username} points to ${params.identity.displayAddress}`
      );
    } catch (err) {
      console.warn(
        err instanceof UsernameError && err.code === "taken"
          ? `[${params.label}] username @${username} is held by another account; this bot has no username`
          : `[${params.label}] could not claim username @${username}: ${
              err instanceof UsernameError
                ? `${err.code}${err.detail ? ` (${err.detail})` : ""}`
                : (err as Error).message
            }`
      );
    }
  }

  static async registerProfile(params: {
    relayBaseUrl: string;
    identity: MonadIdentity;
    label: string;
    profile: BotProfile;
    force?: boolean;
    /** When given, the bot's username is claimed on this network before the profile is sent. */
    network?: string;
    /** Canonical network the profile statement is signed for (Monad testnet when omitted). */
    statementNetwork?: string;
  }): Promise<void> {
    if (params.network !== undefined) {
      await RelayProfileManager.claimUsername({
        relayBaseUrl: params.relayBaseUrl,
        network: params.network,
        identity: params.identity,
        label: params.label,
        profile: params.profile,
      });
    }

    let avatarStr: string | undefined = undefined;
    if (typeof params.profile.avatarPng === "string") {
      avatarStr = params.profile.avatarPng;
    } else if (params.profile.avatarPng instanceof Uint8Array) {
      avatarStr = `data:image/png;base64,${Buffer.from(
        params.profile.avatarPng
      ).toString("base64")}`;
    }

    const wanted: MonadProfileFields = {
      name: params.profile.name,
      bio: params.profile.bio,
      avatar: avatarStr,
      bot: params.profile.bot ?? true,
      accountType: params.profile.accountType,
      botRole: params.profile.botRole,
    };

    if (!params.force) {
      try {
        const existing = await fetchMonadProfile({
          relayBaseUrl: params.relayBaseUrl,
          address: params.identity.address,
        });
        if (
          existing &&
          (existing.name ?? "") === (wanted.name ?? "") &&
          (existing.bio ?? "") === (wanted.bio ?? "") &&
          (existing.bot ?? false) === (wanted.bot ?? false) &&
          existing.accountType === wanted.accountType &&
          existing.botRole === wanted.botRole
        ) {
          console.log(
            `[${params.label}] profile on relay already current (${params.identity.displayAddress})`
          );
          return;
        }
      } catch {
        // Continue to register if check fails
      }
    }

    try {
      await registerMonadIdentityCbor({
        relayBaseUrl: params.relayBaseUrl,
        identity: params.identity,
        profile: wanted,
        network: params.statementNetwork,
      });
    } catch (cborErr) {
      console.warn(
        `[${params.label}] CBOR profile registration failed; falling back to protobuf:`,
        (cborErr as any)?.response?.data ?? (cborErr as Error).message
      );
      await registerMonadIdentity({
        relayBaseUrl: params.relayBaseUrl,
        identity: params.identity,
        profile: wanted,
      });
    }
    console.log(
      `[${params.label}] registered profile on relay for ${params.identity.displayAddress} ("${wanted.name}")`
    );
  }
}
