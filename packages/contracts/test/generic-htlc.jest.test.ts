import { parseEther, keccak256, sha256, toUtf8Bytes, Contract } from 'ethers';
import {
  getTestProvider,
  getTestWallets,
  getBalance,
  increaseTime,
  deployAll
} from './evm-test-env.js';

describe('GenericHTLC Contract', () => {
  let provider: any;
  let wallets: any;
  let genericHtlc: Contract;

  beforeAll(async () => {
    provider = await getTestProvider();
    wallets = await getTestWallets(provider);
    const deployed = await deployAll(wallets.deployer);
    genericHtlc = deployed.genericHtlc;
  }, 30000);

  const getLockId = (label: string) => keccak256(Buffer.from(label));

  it('locks and withdraws with Keccak256 preimage', async () => {
    const lockId = getLockId('lock-keccak');
    const preimage = toUtf8Bytes('frank-secret-keccak-preimage-42');
    const hashLock = keccak256(preimage);
    const amount = parseEther('1.0');
    const duration = 1800; // 30 mins

    const htlcSender = genericHtlc.connect(wallets.player) as Contract;
    const txLock = await htlcSender.lock(lockId, wallets.dealer.address, hashLock, duration, { value: amount });
    await txLock.wait();

    const lock = await genericHtlc.getLock(lockId);
    expect(lock.sender).toBe(wallets.player.address);
    expect(lock.recipient).toBe(wallets.dealer.address);
    expect(lock.amount).toBe(amount);
    expect(lock.hashLock).toBe(hashLock);
    expect(lock.withdrawn).toBe(false);
    expect(lock.refunded).toBe(false);

    const dealerBalBefore = await getBalance(provider, wallets.dealer.address);

    // Recipient withdraws with preimage
    const htlcRecipient = genericHtlc.connect(wallets.dealer) as Contract;
    const tx = await htlcRecipient.withdraw(lockId, preimage);
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;

    const dealerBalAfter = await getBalance(provider, wallets.dealer.address);
    expect(dealerBalAfter - dealerBalBefore + gasUsed).toBe(amount);

    const lockAfter = await genericHtlc.getLock(lockId);
    expect(lockAfter.withdrawn).toBe(true);
  });

  it('locks and withdraws with SHA256 preimage (cross-chain Bitcoin / Lightning compatibility)', async () => {
    const lockId = getLockId('lock-sha256');
    const preimage = toUtf8Bytes('cross-chain-bitcoin-swap-secret');
    const hashLock = sha256(preimage);
    const amount = parseEther('2.5');
    const duration = 1800;

    const htlcSender = genericHtlc.connect(wallets.bob) as Contract;
    const txLock = await htlcSender.lock(lockId, wallets.charlie.address, hashLock, duration, { value: amount });
    await txLock.wait();

    const charlieBalBefore = await getBalance(provider, wallets.charlie.address);

    const htlcRecipient = genericHtlc.connect(wallets.charlie) as Contract;
    const tx = await htlcRecipient.withdraw(lockId, preimage);
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;

    const charlieBalAfter = await getBalance(provider, wallets.charlie.address);
    expect(charlieBalAfter - charlieBalBefore + gasUsed).toBe(amount);

    const lockAfter = await genericHtlc.getLock(lockId);
    expect(lockAfter.withdrawn).toBe(true);
  });

  it('rejects withdrawal with incorrect preimage', async () => {
    const lockId = getLockId('lock-wrong-preimage');
    const preimage = toUtf8Bytes('correct-preimage');
    const hashLock = keccak256(preimage);

    const htlcSender = genericHtlc.connect(wallets.player) as Contract;
    const txLock = await htlcSender.lock(lockId, wallets.dealer.address, hashLock, 1800, { value: parseEther('0.5') });
    await txLock.wait();

    const htlcRecipient = genericHtlc.connect(wallets.dealer) as Contract;
    await expect(
      htlcRecipient.withdraw.staticCall(lockId, toUtf8Bytes('wrong-preimage'))
    ).rejects.toThrow();
  });

  it('supports batch withdrawal across multiple locks', async () => {
    const lock1 = getLockId('batch-1');
    const lock2 = getLockId('batch-2');
    const pre1 = toUtf8Bytes('preimage-one');
    const pre2 = toUtf8Bytes('preimage-two');
    const hash1 = keccak256(pre1);
    const hash2 = sha256(pre2);

    const htlcSender = genericHtlc.connect(wallets.player) as Contract;
    const tx1 = await htlcSender.lock(lock1, wallets.bob.address, hash1, 1800, { value: parseEther('0.5') });
    await tx1.wait();
    const tx2 = await htlcSender.lock(lock2, wallets.bob.address, hash2, 1800, { value: parseEther('0.7') });
    await tx2.wait();

    const bobBalBefore = await getBalance(provider, wallets.bob.address);

    const htlcBob = genericHtlc.connect(wallets.bob) as Contract;
    const tx = await htlcBob.batchWithdraw([lock1, lock2], [pre1, pre2]);
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;

    const bobBalAfter = await getBalance(provider, wallets.bob.address);
    expect(bobBalAfter - bobBalBefore + gasUsed).toBe(parseEther('1.2'));
  });

  it('allows sender to unilaterally refund locked funds after expiration', async () => {
    const lockId = getLockId('lock-refund-timeout');
    const preimage = toUtf8Bytes('unclaimed-secret');
    const hashLock = keccak256(preimage);
    const amount = parseEther('1.0');
    const duration = 600; // 10 minutes

    const htlcSender = genericHtlc.connect(wallets.player) as Contract;
    const txLock = await htlcSender.lock(lockId, wallets.dealer.address, hashLock, duration, { value: amount });
    await txLock.wait();

    // Premature refund fails
    await expect(htlcSender.refund.staticCall(lockId)).rejects.toThrow();

    // Advance time past expiration
    await increaseTime(provider, 3600);

    const playerBalBefore = await getBalance(provider, wallets.player.address);
    const tx = await htlcSender.refund(lockId);
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;

    const playerBalAfter = await getBalance(provider, wallets.player.address);
    expect(playerBalAfter - playerBalBefore + gasUsed).toBe(amount);

    const lockAfter = await genericHtlc.getLock(lockId);
    expect(lockAfter.refunded).toBe(true);

    // After refund, withdrawal fails
    const htlcRecipient = genericHtlc.connect(wallets.dealer) as Contract;
    await expect(htlcRecipient.withdraw.staticCall(lockId, preimage)).rejects.toThrow();
  });
});
