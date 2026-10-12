import { constants, closeSync, fstatSync, fsyncSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAddress } from 'ethers';
import { deriveDomainRoot } from '@frank/domain-roots';
import { createMonadWalletMaterial } from '@frank/wallet/monad-wallet-material';
import { loadGatewayWalletRoots } from './gateway-wallet';

export interface GenerateGatewayRootsInput {
  readonly primaryFile: string;
  readonly backupFile: string;
}

function privateDestination(path: string): string {
  if (!isAbsolute(path)) throw new Error('Gateway roots destination must be absolute');
  const parent = realpathSync(dirname(path));
  const info = statSync(parent);
  if (!info.isDirectory() || (process.platform !== 'win32' &&
    ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())))
    throw new Error('Gateway roots parent must be an owner-only directory');
  return join(parent, basename(path));
}

function writeExclusive(path: string, contents: Buffer): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
      throw new Error('Gateway roots destination is not a private regular file');
    let offset = 0;
    while (offset < contents.length) offset += writeSync(fd, contents, offset, contents.length - offset);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  // File contents and the directory entry are distinct durability facts. A
  // successful return must survive a restart without relying on a warm cache.
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Creates a fresh, unfunded testnet identity. Existing files and partial writes are never reset. */
export function generateGatewayRoots(input: GenerateGatewayRootsInput): string {
  const primary = privateDestination(input.primaryFile);
  const backup = privateDestination(input.backupFile);
  if (primary === backup || dirname(primary) === dirname(backup))
    throw new Error('Gateway roots backup must use a separate private directory');

  const accountRoot = randomBytes(32);
  let roots: {
    evm: ReturnType<typeof deriveDomainRoot<'evm-wallet'>>;
    authentication: ReturnType<typeof deriveDomainRoot<'identity-authentication'>>;
    messaging: ReturnType<typeof deriveDomainRoot<'messaging-encryption'>>;
  };
  try {
    roots = {
      evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
      authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
      messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
    };
  } finally {
    accountRoot.fill(0);
  }
  let contents: Buffer | undefined;
  try {
    const material = createMonadWalletMaterial(roots);
    let identity: string;
    try {
      identity = getAddress(material.identity.displayAddress);
    } finally {
      material.dispose();
    }
    contents = Buffer.from(JSON.stringify({ registry: 'frank-domain-roots-v1', roots: {
      'evm-wallet': Buffer.from(roots.evm.bytes).toString('hex'),
      'identity-authentication': Buffer.from(roots.authentication.bytes).toString('hex'),
      'messaging-encryption': Buffer.from(roots.messaging.bytes).toString('hex'),
    } }) + '\n');
    writeExclusive(primary, contents);
    writeExclusive(backup, contents);

    // Verify both paths through the same permission and schema checks used at startup.
    const first = loadGatewayWalletRoots(primary);
    const second = loadGatewayWalletRoots(backup);
    try {
      for (const purpose of ['evm', 'authentication', 'messaging'] as const) {
        if (!timingSafeEqual(first[purpose].bytes, second[purpose].bytes) ||
          !timingSafeEqual(first[purpose].bytes, roots[purpose].bytes))
          throw new Error('Gateway roots backup verification failed');
      }
    } finally {
      for (const bundle of [first, second])
        for (const purpose of ['evm', 'authentication', 'messaging'] as const)
          bundle[purpose].bytes.fill(0);
    }
    return identity;
  } finally {
    contents?.fill(0);
    roots.evm.bytes.fill(0);
    roots.authentication.bytes.fill(0);
    roots.messaging.bytes.fill(0);
  }
}
