import { parseEther, keccak256, AbiCoder, getBytes, Wallet, Contract } from 'ethers';
import {
  getTestProvider,
  getTestWallets,
  getBalance,
  increaseTime,
  deployAll
} from './evm-test-env.js';

describe('ChannelVault Contract', () => {
  let provider: any;
  let wallets: any;
  let channelVault: Contract;

  beforeAll(async () => {
    provider = await getTestProvider();
    wallets = await getTestWallets(provider);
    const deployed = await deployAll(wallets.deployer);
    channelVault = deployed.channelVault;
  }, 30000);

  const getSessionId = (label: string) => keccak256(Buffer.from(label));

  it('allows player to open a channel and dealer to deposit cover', async () => {
    const sessionId = getSessionId('session-1');
    const playerDeposit = parseEther('1.0');
    const dealerCover = parseEther('2.0');
    const duration = 3600; // 1 hour

    // Player opens channel
    const cvPlayer = channelVault.connect(wallets.player) as Contract;
    const txOpen = await cvPlayer.openChannel(sessionId, wallets.dealer.address, wallets.jointSigner.address, duration, {
      value: playerDeposit
    });
    await txOpen.wait();

    let s = await channelVault.getSession(sessionId);
    expect(s.player).toBe(wallets.player.address);
    expect(s.dealer).toBe(wallets.dealer.address);
    expect(s.playerDeposit).toBe(playerDeposit);
    expect(s.dealerCover).toBe(0n);
    expect(s.jointSigner).toBe(wallets.jointSigner.address);
    expect(s.settled).toBe(false);

    // Dealer deposits cover
    const cvDealer = channelVault.connect(wallets.dealer) as Contract;
    const txCover = await cvDealer.depositCover(sessionId, { value: dealerCover });
    await txCover.wait();

    s = await channelVault.getSession(sessionId);
    expect(s.dealerCover).toBe(dealerCover);
    expect(await channelVault.totalBalance(sessionId)).toBe(parseEther('3.0'));
  });

  it('settles a channel with valid joint signature to winner (and remainder to dealer)', async () => {
    const sessionId = getSessionId('session-settle-win');
    const playerDeposit = parseEther('1.0');
    const dealerCover = parseEther('1.0');
    const duration = 3600;

    const cvPlayer = channelVault.connect(wallets.player) as Contract;
    const txOpen = await cvPlayer.openChannel(sessionId, wallets.dealer.address, wallets.jointSigner.address, duration, {
      value: playerDeposit
    });
    await txOpen.wait();

    const cvDealer = channelVault.connect(wallets.dealer) as Contract;
    const txCover = await cvDealer.depositCover(sessionId, { value: dealerCover });
    await txCover.wait();

    // Player wins 1.5 ETH payout (total pot is 2.0 ETH)
    const payout = parseEther('1.5');
    const winner = wallets.player.address;
    const chainId = (await provider.getNetwork()).chainId;
    const contractAddr = await channelVault.getAddress();

    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'bytes32', 'address', 'uint256'],
      [chainId, contractAddr, sessionId, winner, payout]
    );
    const digest = keccak256(encoded);
    const jointSig = await wallets.jointSigner.signMessage(getBytes(digest));

    const playerBalBefore = await getBalance(provider, wallets.player.address);
    const dealerBalBefore = await getBalance(provider, wallets.dealer.address);

    const tx = await cvPlayer.settle(sessionId, winner, payout, jointSig);
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;

    const playerBalAfter = await getBalance(provider, wallets.player.address);
    const dealerBalAfter = await getBalance(provider, wallets.dealer.address);

    // Player received payout minus gas
    expect(playerBalAfter - playerBalBefore + gasUsed).toBe(payout);
    // Dealer received remainder (0.5 ETH)
    expect(dealerBalAfter - dealerBalBefore).toBe(parseEther('0.5'));

    const s = await channelVault.getSession(sessionId);
    expect(s.settled).toBe(true);
  });

  it('supports one-time DKSAP stealth address payouts', async () => {
    const sessionId = getSessionId('session-stealth');
    const playerDeposit = parseEther('2.0');
    const duration = 3600;

    const stealthWallet = Wallet.createRandom(provider);

    const cvPlayer = channelVault.connect(wallets.player) as Contract;
    const txOpen = await cvPlayer.openChannel(sessionId, wallets.dealer.address, wallets.jointSigner.address, duration, {
      value: playerDeposit
    });
    await txOpen.wait();

    const payout = parseEther('2.0');
    const chainId = (await provider.getNetwork()).chainId;
    const contractAddr = await channelVault.getAddress();

    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'bytes32', 'address', 'uint256'],
      [chainId, contractAddr, sessionId, stealthWallet.address, payout]
    );
    const digest = keccak256(encoded);
    const jointSig = await wallets.jointSigner.signMessage(getBytes(digest));

    const txSettle = await cvPlayer.settle(sessionId, stealthWallet.address, payout, jointSig);
    await txSettle.wait();

    const stealthBal = await getBalance(provider, stealthWallet.address);
    expect(stealthBal).toBe(payout);
  });

  it('supports settleSplits for arbitrary two-way distribution', async () => {
    const sessionId = getSessionId('session-splits');
    const playerDeposit = parseEther('2.0');
    const dealerCover = parseEther('2.0');
    const duration = 3600;

    const cvPlayer = channelVault.connect(wallets.player) as Contract;
    const txOpen = await cvPlayer.openChannel(sessionId, wallets.dealer.address, wallets.jointSigner.address, duration, {
      value: playerDeposit
    });
    await txOpen.wait();

    const cvDealer = channelVault.connect(wallets.dealer) as Contract;
    const txCover = await cvDealer.depositCover(sessionId, { value: dealerCover });
    await txCover.wait();

    // Split: Bob gets 1.2 ETH, Charlie gets 2.8 ETH
    const recipientA = wallets.bob.address;
    const amountA = parseEther('1.2');
    const recipientB = wallets.charlie.address;
    const amountB = parseEther('2.8');

    const chainId = (await provider.getNetwork()).chainId;
    const contractAddr = await channelVault.getAddress();

    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'bytes32', 'address', 'uint256', 'address', 'uint256'],
      [chainId, contractAddr, sessionId, recipientA, amountA, recipientB, amountB]
    );
    const digest = keccak256(encoded);
    const jointSig = await wallets.jointSigner.signMessage(getBytes(digest));

    const bobBalBefore = await getBalance(provider, recipientA);
    const charlieBalBefore = await getBalance(provider, recipientB);

    const txSettle = await cvDealer.settleSplits(sessionId, recipientA, amountA, recipientB, amountB, jointSig);
    await txSettle.wait();

    const bobBalAfter = await getBalance(provider, recipientA);
    const charlieBalAfter = await getBalance(provider, recipientB);

    expect(bobBalAfter - bobBalBefore).toBe(amountA);
    expect(charlieBalAfter - charlieBalBefore).toBe(amountB);
  });

  it('rejects settlement with invalid or forged joint signature', async () => {
    const sessionId = getSessionId('session-forgery');
    const cvPlayer = channelVault.connect(wallets.player) as Contract;
    const txOpen = await cvPlayer.openChannel(sessionId, wallets.dealer.address, wallets.jointSigner.address, 3600, {
      value: parseEther('1.0')
    });
    await txOpen.wait();

    const chainId = (await provider.getNetwork()).chainId;
    const contractAddr = await channelVault.getAddress();

    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'bytes32', 'address', 'uint256'],
      [chainId, contractAddr, sessionId, wallets.player.address, parseEther('1.0')]
    );
    const digest = keccak256(encoded);
    // Rogue signature by bob instead of jointSigner
    const forgedSig = await wallets.bob.signMessage(getBytes(digest));

    await expect(
      cvPlayer.settle(sessionId, wallets.player.address, parseEther('1.0'), forgedSig)
    ).rejects.toThrow();
  });

  it('enforces the anti-hostage timelock escape hatch (refundTimeout)', async () => {
    const sessionId = getSessionId('session-timeout-escape');
    const playerDeposit = parseEther('1.5');
    const dealerCover = parseEther('2.5');
    const duration = 1800; // 30 minutes

    const cvPlayer = channelVault.connect(wallets.player) as Contract;
    const txOpen = await cvPlayer.openChannel(sessionId, wallets.dealer.address, wallets.jointSigner.address, duration, {
      value: playerDeposit
    });
    await txOpen.wait();

    const cvDealer = channelVault.connect(wallets.dealer) as Contract;
    const txCover = await cvDealer.depositCover(sessionId, { value: dealerCover });
    await txCover.wait();

    // Calling refundTimeout prematurely must revert
    await expect(channelVault.refundTimeout(sessionId)).rejects.toThrow();

    // Advance time past expiration
    await increaseTime(provider, duration + 10);

    const playerBalBefore = await getBalance(provider, wallets.player.address);
    const dealerBalBefore = await getBalance(provider, wallets.dealer.address);

    // Player triggers the anti-hostage escape hatch unilaterally
    const tx = await cvPlayer.refundTimeout(sessionId);
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;

    const playerBalAfter = await getBalance(provider, wallets.player.address);
    const dealerBalAfter = await getBalance(provider, wallets.dealer.address);

    // Player gets exactly 100% of their deposit back
    expect(playerBalAfter - playerBalBefore + gasUsed).toBe(playerDeposit);
    // Dealer gets exactly 100% of their cover back
    expect(dealerBalAfter - dealerBalBefore).toBe(dealerCover);

    const s = await channelVault.getSession(sessionId);
    expect(s.settled).toBe(true);

    // Further calls fail because it is settled
    await expect(cvPlayer.refundTimeout(sessionId)).rejects.toThrow();
  });
});
