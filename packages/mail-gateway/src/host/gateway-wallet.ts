import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'fs';
import { constants } from 'fs';
import { isAbsolute, join } from 'path';
import { getAddress } from 'ethers';

import { hmacSha256 } from '@frank/crypto-box';
import { createEvmChain } from '@frank/wallet/chain/monad-chain';
import type { EvmChainConfig } from '@frank/wallet/chain/evm-chain-config';
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle';
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material';

const ROOT_REGISTRY = 'frank-domain-roots-v1';
const NETWORK = 'monad-testnet';
const ALIAS_LABEL = new TextEncoder().encode('frank/mail-reply-alias/v1');

export class GatewayWalletStartRefusal extends Error {
  constructor(readonly code: string) {
    super(`Mail gateway wallet refusing to start: ${code}`);
    this.name = 'GatewayWalletStartRefusal';
  }
}

/** The file contains the three typed, account-specific roots. It must be an existing owner-only
 * regular file (0400 or 0600 on Unix). The loader never creates, repairs or logs secret material. */
export function loadGatewayWalletRoots(path: string): MonadRootBundle {
  if (!isAbsolute(path)) throw new GatewayWalletStartRefusal('root-path-not-absolute');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (info.mode & 0o400) === 0))
    )
      throw new GatewayWalletStartRefusal('root-file-permissions');
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new GatewayWalletStartRefusal('root-file-invalid');
    const document = parsed as Record<string, unknown>;
    const roots = document.roots;
    if (
      Object.keys(document).length !== 2 ||
      document.registry !== ROOT_REGISTRY ||
      !roots ||
      typeof roots !== 'object' ||
      Array.isArray(roots)
    )
      throw new GatewayWalletStartRefusal('root-file-invalid');
    const record = roots as Record<string, unknown>;
    const purposes = ['evm-wallet', 'identity-authentication', 'messaging-encryption'] as const;
    if (
      Object.keys(record).length !== purposes.length ||
      purposes.some(
        (purpose) =>
          typeof record[purpose] !== 'string' || !/^[0-9a-f]{64}$/i.test(record[purpose] as string)
      )
    )
      throw new GatewayWalletStartRefusal('root-file-invalid');
    const root = <P extends (typeof purposes)[number]>(purpose: P) => ({
      registry: ROOT_REGISTRY as typeof ROOT_REGISTRY,
      purpose,
      bytes: new Uint8Array(Buffer.from(record[purpose] as string, 'hex')),
    });
    return {
      evm: root('evm-wallet'),
      authentication: root('identity-authentication'),
      messaging: root('messaging-encryption'),
    };
  } catch (error) {
    if (error instanceof GatewayWalletStartRefusal) throw error;
    throw new GatewayWalletStartRefusal('root-file-unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface OpenGatewayWalletInput {
  readonly rootFile: string;
  /** Existing persistent wallet-state base. A new path may reuse previously spent accounts. */
  readonly chain: EvmChainConfig;
  readonly expectedIdentityAddress: string;
}

export interface OpenGatewayWalletResult {
  readonly wallet: EvmChainWalletHandle;
  readonly identityAddress: string;
  /** Private, domain-separated HMAC key for deterministic per-conversation reply aliases. */
  replyAliasSalt(): Uint8Array;
  close(): Promise<void>;
}

/** Opens only a previously provisioned Monad testnet wallet. Wallet inventory, reservations and
 * attempt journals remain owned by the EVM wallet; this host owns only its lifecycle. */
export async function openGatewayWallet(
  input: OpenGatewayWalletInput
): Promise<OpenGatewayWalletResult> {
  const config = input.chain;
  if (
    config.chainIdentifier !== NETWORK ||
    config.rpcChain !== NETWORK ||
    config.networkId !== NETWORK ||
    config.networkTag !== 'MONT' ||
    BigInt(config.chainId) !== 10143n
  )
    throw new GatewayWalletStartRefusal('network-mismatch');
  if (config.walletStorageLocation === false || !isAbsolute(config.walletStorageLocation))
    throw new GatewayWalletStartRefusal('wallet-state-not-durable');
  let expectedAddress: string;
  try {
    expectedAddress = getAddress(input.expectedIdentityAddress);
  } catch {
    throw new GatewayWalletStartRefusal('expected-identity-invalid');
  }

  const roots = loadGatewayWalletRoots(input.rootFile);
  let salt: Uint8Array | undefined;
  try {
    const material = createMonadWalletMaterial(roots);
    try {
      if (getAddress(material.identity.displayAddress) !== expectedAddress)
        throw new GatewayWalletStartRefusal('identity-mismatch');
      const walletLocation = `${
        config.walletStorageLocation
      }-evm-${material.mainAccount.address.toLowerCase()}`;
      try {
        for (const namespace of ['wallet-manifest', 'sub-account-pool', 'change-pool']) {
          if (
            !statSync(join(walletLocation, namespace)).isDirectory() ||
            !statSync(join(walletLocation, namespace, 'CURRENT')).isFile()
          )
            throw new GatewayWalletStartRefusal('wallet-state-missing');
        }
      } catch {
        throw new GatewayWalletStartRefusal('wallet-state-missing');
      }
      salt = hmacSha256(ALIAS_LABEL, roots.messaging.bytes);
    } finally {
      material.dispose();
    }
    const wallet = (await createEvmChain(config).createWallet(roots)) as EvmChainWalletHandle;
    try {
      if (
        wallet.chainIdentifier !== NETWORK ||
        getAddress(wallet.identity.displayAddress) !== expectedAddress ||
        wallet.walletState?.durability !== 'persistent' ||
        wallet.walletState.canonicalUnavailable
      )
        throw new GatewayWalletStartRefusal('opened-wallet-binding-mismatch');
      let closed = false;
      const ownedSalt = salt;
      salt = undefined;
      return {
        wallet,
        identityAddress: expectedAddress,
        replyAliasSalt() {
          if (closed) throw new GatewayWalletStartRefusal('wallet-closed');
          return new Uint8Array(ownedSalt);
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            await wallet.close();
          } finally {
            ownedSalt.fill(0);
          }
        },
      };
    } catch (error) {
      await wallet.close().catch(() => undefined);
      throw error;
    }
  } finally {
    roots.evm.bytes.fill(0);
    roots.authentication.bytes.fill(0);
    roots.messaging.bytes.fill(0);
    salt?.fill(0);
  }
}
