import { existsSync, mkdirSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { getAddress } from 'ethers';
import { createEvmChain } from '@frank/wallet/chain/monad-chain';
import { createMonadWalletMaterial } from '@frank/wallet/monad-wallet-material';
import { CreditLedger } from '../ledger/credit-ledger';
import { MailJournal } from '../ledger/mail-journal';
import { loadGatewayWalletRoots, provisionGatewayWalletAdmission } from './gateway-wallet';
import type { GatewayProvisionConfig } from './gateway-config';

/** One explicit mutation for a genuinely new, unfunded Monad testnet gateway. */
export async function provisionNewMailGateway(config: GatewayProvisionConfig): Promise<void> {
  if (config.chain.chainIdentifier !== 'monad-testnet' || config.chain.requireBoundWalletState !== true)
    throw new Error('Mail provisioning requires a bound Monad testnet wallet');
  if (typeof config.chain.walletStorageLocation !== 'string' ||
    !isAbsolute(config.chain.walletStorageLocation) || !isAbsolute(config.journalFile))
    throw new Error('Mail provisioning requires absolute durable state paths');
  const primaryStat = statSync(config.rootFile);
  const backupStat = statSync(config.backupRootFile);
  if (primaryStat.dev === backupStat.dev && primaryStat.ino === backupStat.ino)
    throw new Error('Gateway root backup must be a distinct private file');
  const roots = loadGatewayWalletRoots(config.rootFile);
  let backup: ReturnType<typeof loadGatewayWalletRoots> | undefined;
  try {
    backup = loadGatewayWalletRoots(config.backupRootFile);
    for (const purpose of ['evm', 'authentication', 'messaging'] as const) {
      if (!timingSafeEqual(roots[purpose].bytes, backup[purpose].bytes))
        throw new Error('Gateway root backup does not match primary roots');
    }
    const material = createMonadWalletMaterial(roots);
    let walletLocation: string;
    try {
      if (getAddress(material.identity.displayAddress) !== getAddress(config.expectedIdentityAddress))
        throw new Error('Gateway root identity differs from expected public address');
      walletLocation = `${config.chain.walletStorageLocation}-evm-${material.mainAccount.address.toLowerCase()}`;
    } finally {
      material.dispose();
    }
    if (existsSync(walletLocation) || existsSync(config.journalFile))
      throw new Error('Gateway wallet or mail journal already exists; refusing provisioning');

    const chain = createEvmChain(config.chain);
    const wallet = await chain.createWallet(roots);
    try {
      if (getAddress(wallet.identity.displayAddress) !== getAddress(config.expectedIdentityAddress))
        throw new Error('Opened gateway identity differs from expected public address');
    } finally {
      await wallet.close();
    }

    // Opening the just-created wallet verifies all wallet-owned bindings before
    // writing the separate host admission marker. A crash leaves state intact.
    const admitted = await provisionGatewayWalletAdmission({
      rootFile: config.rootFile,
      chain: config.chain,
      expectedIdentityAddress: config.expectedIdentityAddress,
    });
    try {
      mkdirSync(dirname(config.journalFile), { recursive: true });
      const ledger = new CreditLedger(config.journalFile);
      try {
        new MailJournal(ledger, {
          chainIdentifier: admitted.chain.chainIdentifier,
          gatewayAccount: admitted.wallet.identity.address.raw.toLowerCase(),
          gatewayDomain: config.gatewayDomain,
        });
      } finally {
        ledger.closeSqlite();
      }
    } finally {
      await admitted.close();
    }
  } finally {
    for (const bundle of [roots, backup]) {
      if (!bundle) continue;
      bundle.evm.bytes.fill(0);
      bundle.authentication.bytes.fill(0);
      bundle.messaging.bytes.fill(0);
    }
  }
}
