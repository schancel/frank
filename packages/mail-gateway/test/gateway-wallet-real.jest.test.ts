import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import level from 'level';

import { deriveDomainRoot } from '@frank/domain-roots';
import { createEvmChain } from '@frank/wallet/chain/monad-chain';
import { MonadIdentity } from '@frank/wallet/monad-identity';
import { createMonadWalletMaterial } from '@frank/wallet/monad-wallet-material';
import { openGatewayWallet, provisionGatewayWalletAdmission } from '../src/host/gateway-wallet';

it('real wallet factory refuses empty LevelDB namespaces, then reopens a provisioned bound state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frank-mail-real-wallet-'));
  try {
    const accountRoot = randomBytes(32);
    const roots = {
      evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
      authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
      messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
    };
    accountRoot.fill(0);
    const identityAddress = MonadIdentity.fromDomainRoot(roots.authentication).displayAddress;
    const material = createMonadWalletMaterial(roots);
    const walletBase = join(directory, 'wallet');
    const walletLocation = `${walletBase}-evm-${material.mainAccount.address.toLowerCase()}`;
    mkdirSync(walletLocation, { recursive: true });
    material.dispose();
    const rootFile = join(directory, 'roots.json');
    writeFileSync(
      rootFile,
      JSON.stringify({
        registry: 'frank-domain-roots-v1',
        roots: {
          'evm-wallet': Buffer.from(roots.evm.bytes).toString('hex'),
          'identity-authentication': Buffer.from(roots.authentication.bytes).toString('hex'),
          'messaging-encryption': Buffer.from(roots.messaging.bytes).toString('hex'),
        },
      }),
      { mode: 0o600 }
    );
    const input = {
      rootFile,
      expectedIdentityAddress: identityAddress,
      chain: {
        chainIdentifier: 'monad-testnet',
        rpcChain: 'monad-testnet',
        networkId: 'monad-testnet',
        networkTag: 'MONT',
        chainId: 10143,
        walletStorageLocation: walletBase,
        requireBoundWalletState: true,
        relayBaseUrl: 'http://127.0.0.1:1',
        stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
        defaultStampValueWei: 1n,
        defaultTopicVoteValueWei: 1n,
        subAccountPoolSize: 2,
      },
    } as const;

    for (const namespace of [
      'wallet-manifest',
      'sub-account-pool',
      'change-pool',
      'evm-native-operations-v1',
      'canonical-stamp-attempts-v1',
    ]) {
      const db = level(join(walletLocation, namespace));
      await db.put('temporary', '1');
      await db.del('temporary');
      await db.close();
    }
    await expect(openGatewayWallet(input)).rejects.toMatchObject({
      code: 'wallet-state-incomplete',
    });
    await expect(provisionGatewayWalletAdmission(input)).rejects.toMatchObject({
      code: 'wallet-state-incomplete',
    });

    // Explicit initial wallet creation is separate from ordinary mail-host startup.
    rmSync(walletLocation, { recursive: true });
    const first = await createEvmChain(input.chain).createWallet(roots);
    expect({
      chainIdentifier: first.chainIdentifier,
      identityAddress: first.identity.address.raw,
    }).toEqual({
      chainIdentifier: 'monad-testnet',
      identityAddress,
    });
    await first.close();
    await expect(openGatewayWallet(input)).rejects.toMatchObject({
      code: 'host-admission-missing',
    });
    const provisioned = await provisionGatewayWalletAdmission(input);
    const salt = provisioned.replyAliasSalt();
    await provisioned.close();
    const opened = await openGatewayWallet(input);
    expect(opened.replyAliasSalt()).toEqual(salt);
    expect(readFileSync(join(walletLocation, 'mail-host-admission.json'), 'utf8')).toContain(
      identityAddress
    );
    await opened.close();
    expect(() => opened.replyAliasSalt()).toThrow('wallet-closed');
    const markerPath = join(walletLocation, 'mail-host-admission.json');
    const originalMarker = readFileSync(markerPath, 'utf8');
    const marker = JSON.parse(originalMarker) as Record<string, unknown>;
    writeFileSync(markerPath, JSON.stringify({ ...marker, canonicalBindingId: '0'.repeat(64) }));
    await expect(openGatewayWallet(input)).rejects.toMatchObject({ code: 'host-admission-mismatch' });
    writeFileSync(markerPath, originalMarker);

    // A partial restore that loses only a spend pool must not silently start a fresh pool.
    const spendPath = join(walletLocation, 'sub-account-pool');
    const spendBackup = join(directory, 'spend-backup');
    cpSync(spendPath, spendBackup, { recursive: true });
    rmSync(spendPath, { recursive: true });
    const emptySpend = level(spendPath);
    await emptySpend.put('temporary', '1');
    await emptySpend.del('temporary');
    await emptySpend.close();
    await expect(openGatewayWallet(input)).rejects.toMatchObject({ code: 'wallet-state-incomplete' });
    await expect(createEvmChain(input.chain).createWallet(roots)).rejects.toThrow(
      'Refusing to open an unbound sub-account store'
    );
    rmSync(spendPath, { recursive: true });
    cpSync(spendBackup, spendPath, { recursive: true });

    const changePath = join(walletLocation, 'change-pool');
    rmSync(changePath, { recursive: true });
    const emptyChange = level(changePath);
    await emptyChange.put('temporary', '1');
    await emptyChange.del('temporary');
    await emptyChange.close();
    await expect(openGatewayWallet(input)).rejects.toMatchObject({ code: 'wallet-state-incomplete' });
    await expect(createEvmChain(input.chain).createWallet(roots)).rejects.toThrow(
      'Refusing to open an unbound change store'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
