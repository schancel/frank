import { isAbsolute } from 'node:path';
import { openDirectory, type OpenDirectory } from '@frank/cashweb/relay/open-directory';
import { nodeDirectoryStorage } from '@frank/cashweb/relay/open-directory-node';
import { canonicalNetworkDescriptor } from '@frank/cashweb/relay/canonical-dm-transport';
import {
  installCanonicalDirectory,
  prepareMonadNextRevisionExport,
  prepareMonadRevisionZeroExport,
} from '@frank/wallet/chain/monad-chain';
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm';
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry';
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry';
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle';

export interface GatewayDirectoryOptions {
  readonly wallet: EvmChainWalletHandle;
  readonly relayBaseUrl: string;
  readonly storageDirectory: string;
}

/**
 * Publish this gateway's real identity before starting mail effects. The
 * directory binds a canonical Monad Testnet account to the selected relay;
 * the message registry decodes the same email item type used by clients.
 */
export async function openGatewayDirectory(options: GatewayDirectoryOptions): Promise<{
  readonly directory: OpenDirectory;
  close(): Promise<void>;
}> {
  if (!isAbsolute(options.storageDirectory)) throw new Error('Gateway directory storage must be absolute');
  const descriptor = canonicalNetworkDescriptor('MONT');
  if (descriptor.network !== 'monad-testnet') throw new Error('Gateway directory network mismatch');
  const wallet = options.wallet;
  const directory = openDirectory({
    network: descriptor.network,
    relayBaseUrl: options.relayBaseUrl,
    nowNs: () => BigInt(Date.now()) * 1_000_000n,
    fetch: (url, init) => fetch(url, init),
    ...nodeDirectoryStorage(options.storageDirectory),
    self: {
      subject: Buffer.from(wallet.identity.compressedPubKey).toString('hex'),
      signRevisionZero: input => prepareMonadRevisionZeroExport(wallet, {
        networkTag: descriptor.tag, network: descriptor.network, chainId: descriptor.chainId, ...input,
      }).attestation,
      signNextRevision: input => prepareMonadNextRevisionExport(wallet, {
        networkTag: descriptor.tag, network: descriptor.network, chainId: descriptor.chainId, ...input,
      }).attestation,
    },
  });
  let removeDirectory: (() => void) | undefined;
  let removeItems: (() => void) | undefined;
  try {
    await directory.publish();
    removeDirectory = installCanonicalDirectory(wallet, directory);
    removeItems = installMessageItemRegistry(
      wallet, createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable)
    );
  } catch (error) {
    removeItems?.();
    removeDirectory?.();
    await directory.close();
    throw error;
  }
  return {
    directory,
    close: async () => {
      removeItems?.();
      removeDirectory?.();
      await directory.close();
    },
  };
}
