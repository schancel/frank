import { parseEther, keccak256, AbiCoder, getBytes, Wallet, Contract } from 'ethers';
import {
  getTestProvider,
  getTestWallets,
  getBalance,
  increaseTime,
  deployAll
} from './evm-test-env.js';

describe('TablePotVault Contract', () => {
  let provider: any;
  let wallets: any;
  let tablePotVault: Contract;

  beforeAll(async () => {
    provider = await getTestProvider();
    wallets = await getTestWallets(provider);
    const deployed = await deployAll(wallets.deployer);
    tablePotVault = deployed.tablePotVault;
  }, 30000);

  const getTableId = (label: string) => keccak256(Buffer.from(label));

  it('allows host to create a table with seed pot and players to buy in', async () => {
    const tableId = getTableId('table-1');
    const buyInAmount = parseEther('0.5');
    const seedPot = parseEther('1.0');
    const duration = 1800; // 30 mins

    const tpvHost = tablePotVault.connect(wallets.dealer) as Contract;
    const txCreate = await tpvHost.createTable(tableId, buyInAmount, duration, { value: seedPot });
    await txCreate.wait();

    let t = await tablePotVault.getTable(tableId);
    expect(t.host).toBe(wallets.dealer.address);
    expect(t.buyInAmount).toBe(buyInAmount);
    expect(t.totalPot).toBe(seedPot);
    expect(t.isSettled).toBe(false);

    // Player 1 (player) buys in
    const tpvPlayer1 = tablePotVault.connect(wallets.player) as Contract;
    const txBuy1 = await tpvPlayer1.buyIn(tableId, { value: buyInAmount });
    await txBuy1.wait();

    // Player 2 (bob) buys in
    const tpvPlayer2 = tablePotVault.connect(wallets.bob) as Contract;
    const txBuy2 = await tpvPlayer2.buyIn(tableId, { value: buyInAmount });
    await txBuy2.wait();

    t = await tablePotVault.getTable(tableId);
    expect(t.totalPot).toBe(parseEther('2.0')); // 1.0 seed + 0.5 + 0.5
    expect(t.playerCount).toBe(2n);

    const players = await tablePotVault.getPlayers(tableId);
    expect(players).toEqual([wallets.player.address, wallets.bob.address]);
  });

  it('settles table pot with multi-recipient payout (including stealth addresses)', async () => {
    const tableId = getTableId('table-settle-stealth');
    const buyInAmount = parseEther('1.0');
    const seedPot = parseEther('0.5');
    const duration = 1800;

    const tpvHost = tablePotVault.connect(wallets.dealer) as Contract;
    const txCreate = await tpvHost.createTable(tableId, buyInAmount, duration, { value: seedPot });
    await txCreate.wait();

    // Player and Bob buy in
    const tpvPlayer = tablePotVault.connect(wallets.player) as Contract;
    const txBuy1 = await tpvPlayer.buyIn(tableId, { value: buyInAmount });
    await txBuy1.wait();

    const tpvBob = tablePotVault.connect(wallets.bob) as Contract;
    const txBuy2 = await tpvBob.buyIn(tableId, { value: buyInAmount });
    await txBuy2.wait();

    // Total pot = 2.5 ETH.
    // 1st place: Stealth winner gets 1.8 ETH
    // 2nd place: Charlie gets 0.5 ETH
    // Remainder: 0.2 ETH returns to Host
    const stealthWinner = Wallet.createRandom(provider);
    const payouts = [
      { recipient: stealthWinner.address, amount: parseEther('1.8') },
      { recipient: wallets.charlie.address, amount: parseEther('0.5') }
    ];

    const hostBalBefore = await getBalance(provider, wallets.dealer.address);
    const charlieBalBefore = await getBalance(provider, wallets.charlie.address);

    // Host settles directly (hostSig can be empty when caller is host)
    const tx = await tpvHost.settleTable(tableId, payouts, '0x');
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;

    const stealthBal = await getBalance(provider, stealthWinner.address);
    const charlieBalAfter = await getBalance(provider, wallets.charlie.address);
    const hostBalAfter = await getBalance(provider, wallets.dealer.address);

    expect(stealthBal).toBe(parseEther('1.8'));
    expect(charlieBalAfter - charlieBalBefore).toBe(parseEther('0.5'));
    // Host received remainder (0.2 ETH) minus gas
    expect(hostBalAfter - hostBalBefore + gasUsed).toBe(parseEther('0.2'));

    const t = await tablePotVault.getTable(tableId);
    expect(t.isSettled).toBe(true);
  });

  it('allows settlement triggered by player with signed host manifest', async () => {
    const tableId = getTableId('table-settle-by-player');
    const buyInAmount = parseEther('1.0');
    const duration = 1800;

    const tpvHost = tablePotVault.connect(wallets.dealer) as Contract;
    const txCreate = await tpvHost.createTable(tableId, buyInAmount, duration);
    await txCreate.wait();

    const tpvPlayer = tablePotVault.connect(wallets.player) as Contract;
    const txBuy = await tpvPlayer.buyIn(tableId, { value: buyInAmount });
    await txBuy.wait();

    const payouts = [
      { recipient: wallets.player.address, amount: parseEther('1.0') }
    ];

    const chainId = (await provider.getNetwork()).chainId;
    const contractAddr = await tablePotVault.getAddress();

    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'bytes32', 'tuple(address recipient, uint256 amount)[]'],
      [chainId, contractAddr, tableId, payouts]
    );
    const digest = keccak256(encoded);
    const hostSig = await wallets.dealer.signMessage(getBytes(digest));

    // Player submits the settlement with host's signature
    const txSettle = await tpvPlayer.settleTable(tableId, payouts, hostSig);
    await txSettle.wait();

    const t = await tablePotVault.getTable(tableId);
    expect(t.isSettled).toBe(true);
  });

  it('allows seated player to claim refund if table expires unsettled (anti-hostage)', async () => {
    const tableId = getTableId('table-claim-refund');
    const buyInAmount = parseEther('1.0');
    const duration = 600; // 10 minutes

    const tpvHost = tablePotVault.connect(wallets.dealer) as Contract;
    const txCreate = await tpvHost.createTable(tableId, buyInAmount, duration);
    await txCreate.wait();

    const tpvPlayer = tablePotVault.connect(wallets.player) as Contract;
    const txBuy = await tpvPlayer.buyIn(tableId, { value: buyInAmount });
    await txBuy.wait();

    // Premature refund fails
    await expect(tpvPlayer.claimRefund.staticCall(tableId)).rejects.toThrow();

    // Advance time past expiration
    await increaseTime(provider, 3600);

    const playerBalBefore = await getBalance(provider, wallets.player.address);
    const tx = await tpvPlayer.claimRefund(tableId);
    const receipt = await tx.wait();
    const gasUsed = receipt.fee;
    const playerBalAfter = await getBalance(provider, wallets.player.address);

    expect(playerBalAfter - playerBalBefore + gasUsed).toBe(buyInAmount);

    // Double claim fails
    await expect(tpvPlayer.claimRefund(tableId)).rejects.toThrow();
  });

  it('allows emergencyRefund batch to refund all players and host seed if host crashes', async () => {
    const tableId = getTableId('table-emergency-batch');
    const buyInAmount = parseEther('0.5');
    const hostSeed = parseEther('1.0');
    const duration = 600;

    const tpvHost = tablePotVault.connect(wallets.dealer) as Contract;
    const txCreate = await tpvHost.createTable(tableId, buyInAmount, duration, { value: hostSeed });
    await txCreate.wait();

    const tpvPlayer = tablePotVault.connect(wallets.player) as Contract;
    const txBuy1 = await tpvPlayer.buyIn(tableId, { value: buyInAmount });
    await txBuy1.wait();

    const tpvBob = tablePotVault.connect(wallets.bob) as Contract;
    const txBuy2 = await tpvBob.buyIn(tableId, { value: buyInAmount });
    await txBuy2.wait();

    // Advance time
    await increaseTime(provider, duration + 10);

    const playerBalBefore = await getBalance(provider, wallets.player.address);
    const bobBalBefore = await getBalance(provider, wallets.bob.address);
    const hostBalBefore = await getBalance(provider, wallets.dealer.address);

    // Anyone (e.g. Charlie or a watchdog) triggers emergency batch refund
    const tpvCharlie = tablePotVault.connect(wallets.charlie) as Contract;
    const txRefund = await tpvCharlie.emergencyRefund(tableId);
    await txRefund.wait();

    const playerBalAfter = await getBalance(provider, wallets.player.address);
    const bobBalAfter = await getBalance(provider, wallets.bob.address);
    const hostBalAfter = await getBalance(provider, wallets.dealer.address);

    expect(playerBalAfter - playerBalBefore).toBe(buyInAmount);
    expect(bobBalAfter - bobBalBefore).toBe(buyInAmount);
    expect(hostBalAfter - hostBalBefore).toBe(hostSeed);

    const t = await tablePotVault.getTable(tableId);
    expect(t.isSettled).toBe(true);
  });
});
