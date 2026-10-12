import { closeSync, fstatSync, openSync, readFileSync, statSync, writeFileSync } from 'fs';
import { constants } from 'fs';
import { isAbsolute, join } from 'path';
import { getAddress, hexlify, randomBytes } from 'ethers';
import level from 'level';

import { hmacSha256 } from '@frank/crypto-box';
import { createEvmChain } from '@frank/wallet/chain/monad-chain';
import type { ActiveChain } from '@frank/wallet/chain/active-chain';
import type { EvmChainConfig } from '@frank/wallet/chain/evm-chain-config';
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle';
import {
  canonicalWalletPublicBinding,
  createMonadWalletMaterial,
  evmWalletPoolBindingId,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material';

const ROOT_REGISTRY = 'frank-domain-roots-v1';
const NETWORK = 'monad-testnet';
const ALIAS_LABEL = new TextEncoder().encode('frank/mail-reply-alias/v1');

async function existingLevelValue(location: string, key: string): Promise<string> {
  const database = level(location, { createIfMissing: false });
  try {
    return await database.get(key);
  } catch {
    throw new GatewayWalletStartRefusal('wallet-state-incomplete');
  } finally {
    await database.close().catch(() => undefined);
  }
}

function parsedObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Never include persisted content in an error.
  }
  throw new GatewayWalletStartRefusal('wallet-state-incomplete');
}

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
  readonly chain: ActiveChain;
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
  return openGatewayWalletMode(input, 'open');
}

/** Explicit first provisioning only, after the operator has established that these roots have
 * no prior spend history. Creates the host continuity marker with exclusive creation. */
export async function provisionGatewayWalletAdmission(
  input: OpenGatewayWalletInput
): Promise<OpenGatewayWalletResult> {
  return openGatewayWalletMode(input, 'provision');
}

async function openGatewayWalletMode(
  input: OpenGatewayWalletInput,
  mode: 'open' | 'provision'
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
  if (config.requireBoundWalletState !== true)
    throw new GatewayWalletStartRefusal('wallet-state-binding-not-required');
  let expectedAddress: string;
  try {
    expectedAddress = getAddress(input.expectedIdentityAddress);
  } catch {
    throw new GatewayWalletStartRefusal('expected-identity-invalid');
  }

  const roots = loadGatewayWalletRoots(input.rootFile);
  let salt: Uint8Array | undefined;
  let markerPath = '';
  let canonicalBindingId = '';
  try {
    const material = createMonadWalletMaterial(roots);
    try {
      if (getAddress(material.identity.displayAddress) !== expectedAddress)
        throw new GatewayWalletStartRefusal('identity-mismatch');
      const walletLocation = `${
        config.walletStorageLocation
      }-evm-${material.mainAccount.address.toLowerCase()}`;
      try {
        for (const namespace of [
          'wallet-manifest',
          'sub-account-pool',
          'change-pool',
          'evm-native-operations-v1',
          'canonical-stamp-attempts-v1',
        ]) {
          if (
            !statSync(join(walletLocation, namespace)).isDirectory() ||
            !statSync(join(walletLocation, namespace, 'CURRENT')).isFile()
          )
            throw new GatewayWalletStartRefusal('wallet-state-missing');
        }
      } catch {
        throw new GatewayWalletStartRefusal('wallet-state-missing');
      }
      const poolBinding = await existingLevelValue(
        join(walletLocation, 'sub-account-pool'),
        '__wallet_binding__'
      );
      const changeBinding = await existingLevelValue(
        join(walletLocation, 'change-pool'),
        '__wallet_binding__'
      );
      const expectedPoolBinding = evmWalletPoolBindingId(material, NETWORK, 10143n);
      if (poolBinding !== expectedPoolBinding || changeBinding !== expectedPoolBinding)
        throw new GatewayWalletStartRefusal('wallet-state-binding-mismatch');
      const nativeBinding = {
        version: 1,
        registry: ROOT_REGISTRY,
        chainIdentifier: NETWORK,
        nativeChainId: '10143',
        mainAddress: material.mainAccount.address.toLowerCase(),
        spend: material.keyring.publicBranchDescriptor(),
        change: material.changeKeyring.publicBranchDescriptor(),
      };
      const branch = (descriptor: {
        path: string;
        publicKey: Uint8Array;
        chainCode: Uint8Array;
      }) => ({
        path: descriptor.path,
        publicKey: hexlify(descriptor.publicKey),
        chainCode: hexlify(descriptor.chainCode),
      });
      const nativeTuple = JSON.stringify({
        ...nativeBinding,
        spend: branch(nativeBinding.spend),
        change: branch(nativeBinding.change),
      });
      const nativeManifest = parsedObject(
        await existingLevelValue(join(walletLocation, 'evm-native-operations-v1'), 'manifest')
      );
      if (
        nativeManifest.version !== 1 ||
        JSON.stringify(nativeManifest.binding) !==
          JSON.stringify({
            chainIdentifier: NETWORK,
            nativeChainId: '10143',
            publicTuple: nativeTuple,
          })
      )
        throw new GatewayWalletStartRefusal('wallet-state-binding-mismatch');
      const canonical = canonicalWalletPublicBinding(material, NETWORK, 10143n);
      const canonicalBinding = parsedObject(
        await existingLevelValue(
          join(walletLocation, 'canonical-stamp-attempts-v1'),
          'metadata:binding'
        )
      );
      if (canonicalBinding.version !== 1 || canonicalBinding.tuple !== canonical.tuple)
        throw new GatewayWalletStartRefusal('wallet-state-binding-mismatch');
      markerPath = join(walletLocation, 'mail-host-admission.json');
      canonicalBindingId = canonical.id;
      if (mode === 'open') {
        let marker: Record<string, unknown>;
        try {
          marker = parsedObject(readFileSync(markerPath, 'utf8'));
        } catch {
          throw new GatewayWalletStartRefusal('host-admission-missing');
        }
        if (
          Object.keys(marker).length !== 5 ||
          marker.version !== 1 ||
          marker.chainIdentifier !== NETWORK ||
          marker.identityAddress !== expectedAddress ||
          marker.canonicalBindingId !== canonical.id ||
          typeof marker.stateId !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(marker.stateId)
        )
          throw new GatewayWalletStartRefusal('host-admission-mismatch');
      } else {
        try {
          statSync(markerPath);
          throw new GatewayWalletStartRefusal('host-already-provisioned');
        } catch (error) {
          if (error instanceof GatewayWalletStartRefusal) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new GatewayWalletStartRefusal('host-admission-unavailable');
        }
      }
      salt = hmacSha256(ALIAS_LABEL, roots.messaging.bytes);
    } finally {
      material.dispose();
    }
    const chain = createEvmChain(config);
    const wallet = (await chain.createWallet(roots)) as EvmChainWalletHandle;
    try {
      if (
        wallet.chainIdentifier !== NETWORK ||
        getAddress(wallet.identity.displayAddress) !== expectedAddress
      )
        throw new GatewayWalletStartRefusal('opened-wallet-binding-mismatch');
      if (mode === 'provision') {
        try {
          writeFileSync(
            markerPath,
            JSON.stringify({
              version: 1,
              chainIdentifier: NETWORK,
              identityAddress: expectedAddress,
              canonicalBindingId,
              stateId: Buffer.from(randomBytes(32)).toString('hex'),
            }),
            { mode: 0o600, flag: 'wx' }
          );
        } catch {
          throw new GatewayWalletStartRefusal('host-admission-unavailable');
        }
      }
      let closed = false;
      const ownedSalt = salt;
      salt = undefined;
      return {
        chain,
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
