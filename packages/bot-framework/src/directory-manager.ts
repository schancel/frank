import { fromHex } from "@frank/codec";
import {
  openDirectory,
  type OpenDirectory,
  directoryAddress,
} from "@frank/cashweb/relay/open-directory";
import { nodeDirectoryStorage } from "@frank/cashweb/relay/open-directory-node";
import { canonicalNetworkDescriptor } from "@frank/cashweb/relay/canonical-dm-transport";
import {
  prepareMonadNextRevisionExport,
  prepareMonadRevisionZeroExport,
} from "@frank/wallet/chain/monad-chain";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";

import { fetchMonadProfile } from "@frank/wallet/monad-identity";
import { toChainAddress, type DirectoryPeerInfo } from "./types";
import type { DirectoryFetch } from "@frank/cashweb/relay/directory-client";

export class DirectoryManager {
  private readonly directory: OpenDirectory;
  private readonly relayBaseUrl: string;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(directory: OpenDirectory, relayBaseUrl: string) {
    this.directory = directory;
    this.relayBaseUrl = relayBaseUrl;
  }

  static create(params: {
    handle: EvmChainWalletHandle;
    networkTag: "MONT" | "MON1";
    relayBaseUrl: string;
    location: string;
    fetch?: DirectoryFetch;
  }): DirectoryManager {
    const { tag, network, chainId } = canonicalNetworkDescriptor(
      params.networkTag
    );
    const descriptor = { networkTag: tag, network, chainId };
    const handle = params.handle;
    const subject = Buffer.from(handle.identity.compressedPubKey).toString(
      "hex"
    );

    const directory = openDirectory({
      network,
      relayBaseUrl: params.relayBaseUrl,
      nowNs: () => BigInt(Date.now()) * 1_000_000n,
      fetch:
        params.fetch ??
        ((url, init) =>
          (globalThis as unknown as { fetch: DirectoryFetch }).fetch(
            url,
            init
          )),
      ...nodeDirectoryStorage(params.location),
      self: {
        subject,
        signRevisionZero: (input) =>
          prepareMonadRevisionZeroExport(handle, { ...descriptor, ...input })
            .attestation,
        signNextRevision: (input) =>
          prepareMonadNextRevisionExport(handle, { ...descriptor, ...input })
            .attestation,
      },
    });

    return new DirectoryManager(directory, params.relayBaseUrl);
  }

  get rawDirectory(): OpenDirectory {
    return this.directory;
  }

  get network(): string {
    return this.directory.network;
  }

  get homeEndpoint(): string {
    return this.directory.homeEndpoint;
  }

  isHomeRelay(endpoint: string): boolean | Promise<boolean> {
    return this.directory.isHomeRelay
      ? this.directory.isHomeRelay(endpoint)
      : true;
  }

  async selfCurrent() {
    return this.directory.selfCurrent();
  }

  async peerCurrent(peer: { address: string } | { subject: string }) {
    return this.directory.peerCurrent(peer);
  }

  async forwarding(): Promise<boolean> {
    return this.directory.forwarding ? this.directory.forwarding() : true;
  }

  async publish(): Promise<void> {
    await this.directory.publish();
  }

  async publishWithRetry(
    label: string,
    retryDelayMs = 2000,
    maxAttempts = 10
  ): Promise<void> {
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        await this.directory.publish();
        console.log(`[${label}] published directory entry successfully`);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[${label}] directory publish attempt ${attempt}/${maxAttempts} failed (${msg}); retrying in ${retryDelayMs}ms...`
        );
        if (attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  startHeartbeat(intervalMs = 30 * 60 * 1000): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.directory.publish();
      } catch (err: unknown) {
        console.warn("Directory renewal heartbeat error:", err);
      }
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  async lookupPeer(rawAddress: string): Promise<DirectoryPeerInfo | undefined> {
    const address = rawAddress.toLowerCase();
    let current;
    try {
      current = await this.directory.peerCurrent({ address });
    } catch {
      return undefined;
    }
    if (!current) return undefined;

    const subject = current.subject;
    const pubKey = fromHex(subject);

    let displayName: string | undefined;
    let bio: string | undefined;
    let isBot: boolean | undefined;

    try {
      const profile = await fetchMonadProfile({
        relayBaseUrl: this.relayBaseUrl,
        address: toChainAddress(address),
      });
      if (profile) {
        displayName = profile.name;
        bio = profile.bio;
        isBot = profile.bot;
      }
    } catch {
      // Profile lookup failure does not invalidate directory entry
    }

    return {
      address,
      subject,
      pubKey,
      displayName,
      bio,
      isBot,
    };
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    await this.directory.close();
  }
}
