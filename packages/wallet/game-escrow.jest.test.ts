import { ethers, Wallet } from 'ethers'
import {
  deriveEscrowStealthPayout,
  buildChannelSettlementDigest,
  buildTableSettlementDigest,
  prepareTableStealthSettlement,
  buildStateChannelCloseDigest,
  encodeStateChannelCloseCall,
  encodeBatchDistributeCall,
  registerEscrowStealthPayout,
} from './game-escrow'
import { MonadIdentity } from './monad-identity'
import { stealthCoinFromItem } from './monad-stealth'
import type { StealthItem } from '@frank/cashweb/types/messages'
import type { EvmChainWalletHandle } from "./evm-wallet-handle";
describe('Game Escrow DKSAP Stealth Payouts (GAME-3)', () => {
  const dummyVault = '0xB0ae4A94A7616029CD99Cf3Ab9Bf417be1DfD9E9'
  const chainId = 10143n // Monad testnet

  it('derives valid DKSAP stealth addresses from recipient spend public key', () => {
    const recipientIdentity = MonadIdentity.generate()
    const spendPubKey = recipientIdentity.compressedPubKey

    const payoutA = deriveEscrowStealthPayout({ recipientSpendPubKey: spendPubKey })
    const payoutB = deriveEscrowStealthPayout({ recipientSpendPubKey: spendPubKey })

    expect(payoutA.stealthAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
    expect(payoutB.stealthAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
    // Distinct ephemeral keys produce distinct one-time stealth addresses
    expect(payoutA.stealthAddress.toLowerCase()).not.toBe(payoutB.stealthAddress.toLowerCase())
  })

  it('computes ChannelVault settlement digest matching EIP-191 personal_sign recover format', async () => {
    const jointSigner = Wallet.createRandom()
    const winnerWallet = Wallet.createRandom()
    const sessionId = ethers.id('session.blackjack.42')
    const payoutWei = ethers.parseEther('2.5')

    const { messageHash, digestBytes } = buildChannelSettlementDigest({
      sessionId,
      winnerAddress: winnerWallet.address,
      payoutWei,
      vaultAddress: dummyVault,
      chainId,
    })

    // Sign digestBytes with jointSigner
    const sig = await jointSigner.signMessage(digestBytes)

    // Verify recovered address matches jointSigner
    const recovered = ethers.recoverAddress(messageHash, sig)
    expect(recovered.toLowerCase()).toBe(jointSigner.address.toLowerCase())
  })

  it('prepares multi-winner TablePotVault settlement with unique DKSAP stealth addresses', async () => {
    const hostWallet = Wallet.createRandom()
    const player1 = MonadIdentity.generate()
    const player2 = MonadIdentity.generate()
    const tableId = ethers.id('table.poker.table_1')

    const plan = prepareTableStealthSettlement({
      tableId,
      winners: [
        { recipientSpendPubKey: player1.compressedPubKey, amountWei: ethers.parseEther('10.0') },
        { recipientSpendPubKey: player2.compressedPubKey, amountWei: ethers.parseEther('5.0') },
      ],
      vaultAddress: dummyVault,
      chainId,
    })

    expect(plan.payouts).toHaveLength(2)
    expect(plan.stealthPlans).toHaveLength(2)
    expect(plan.payouts[0].recipient).toBe(plan.stealthPlans[0].stealthAddress)
    expect(plan.payouts[1].recipient).toBe(plan.stealthPlans[1].stealthAddress)
    expect(plan.payouts[0].amount).toBe(ethers.parseEther('10.0'))
    expect(plan.payouts[1].amount).toBe(ethers.parseEther('5.0'))

    // Verify host signature recovery
    const sig = await hostWallet.signMessage(plan.digest.digestBytes)
    const recovered = ethers.recoverAddress(plan.digest.messageHash, sig)
    expect(recovered.toLowerCase()).toBe(hostWallet.address.toLowerCase())
  })

  it('records a game escrow stealth payout as a coin of the winner wallet', async () => {
    const winnerIdentity = MonadIdentity.generate()
    const recorded: StealthItem[] = []
    const mockWallet = {
      family: 'evm',
      chainIdentifier: 'monad-testnet',
      networkId: 'monad-testnet',
      identity: winnerIdentity,
      recordStealthPayment: async (item: StealthItem) => {
        recorded.push(item)
      },
    } as unknown as EvmChainWalletHandle

    // Escrow payout derived by counterparty or host
    const payout = deriveEscrowStealthPayout({
      recipientSpendPubKey: winnerIdentity.compressedPubKey,
    })
    const payoutAmountWei = ethers.parseEther('5.0')
    const txHash = '0x' + '99'.repeat(32)

    const record = await registerEscrowStealthPayout({
      wallet: mockWallet,
      ephemeralPubKey: payout.ephemeralPubKey,
      stealthAddress: payout.stealthAddress,
      payoutWei: payoutAmountWei,
      txHash,
      networkTag: 'MONT',
    })

    expect(record.address.toLowerCase()).toBe(payout.stealthAddress.toLowerCase())
    expect(recorded).toHaveLength(1)
    // What the wallet is handed is enough to derive the same one-time account and its key.
    const coin = stealthCoinFromItem({
      item: recorded[0],
      recipientSpendSecret: winnerIdentity.toPrivateKeyHex(),
      discoveredAtMs: 1,
    })
    expect(coin?.address).toBe(payout.stealthAddress.toLowerCase())
    expect(new Wallet(coin!.privateKey).address.toLowerCase()).toBe(coin!.address)
    // The stated amount is only a claim: the coin is pending and holds nothing until read.
    expect(coin?.state).toBe('pending')
    expect(coin?.amountWei).toBe('0')
    expect(coin?.claimedAmountWei).toBe(payoutAmountWei.toString())
  })

  it('computes StateChannel cooperative close digest with DKSAP stealth address and encodes calldata', async () => {
    const alice = Wallet.createRandom()
    const bob = Wallet.createRandom()
    const stealthWinner = Wallet.createRandom().address
    const channelId = ethers.id('channel.symmetric.101')
    const seq = 10n
    const balances = [ethers.parseEther('1.25'), ethers.parseEther('0.75')] as [bigint, bigint]

    const { messageHash, digestBytes } = buildStateChannelCloseDigest({
      channelId,
      seq,
      balances,
      payout0: stealthWinner,
      payout1: bob.address,
      contractAddress: dummyVault,
      chainId,
    })

    const sig0 = await alice.signMessage(digestBytes)
    const sig1 = await bob.signMessage(digestBytes)

    expect(ethers.recoverAddress(messageHash, sig0).toLowerCase()).toBe(alice.address.toLowerCase())
    expect(ethers.recoverAddress(messageHash, sig1).toLowerCase()).toBe(bob.address.toLowerCase())

    const calldata = encodeStateChannelCloseCall({
      channelId,
      seq,
      balances,
      payout0: stealthWinner,
      payout1: bob.address,
      sig0,
      sig1,
    })
    expect(calldata.startsWith('0x')).toBe(true)
  })

  it('encodes GenericHTLC batchDistribute calldata for multi-winner table settlements', () => {
    const lock1 = ethers.id('lock.p1')
    const lock2 = ethers.id('lock.p2')
    const payouts = [
      { recipient: ethers.Wallet.createRandom().address, amount: ethers.parseEther('7.0') },
      { recipient: ethers.Wallet.createRandom().address, amount: ethers.parseEther('3.0') },
    ]
    const preimage = 'secret-preimage-data'

    const calldata = encodeBatchDistributeCall({
      lockIds: [lock1, lock2],
      payouts,
      preimage,
    })
    expect(calldata.startsWith('0x')).toBe(true)
  })

  it('rejects registration if expected stealth address does not match derived', async () => {
    const winnerIdentity = MonadIdentity.generate()
    const mockWallet = {
      identity: winnerIdentity,
      recordStealthPayment: async () => undefined,
    } as unknown as EvmChainWalletHandle

    const payout = deriveEscrowStealthPayout({
      recipientSpendPubKey: winnerIdentity.compressedPubKey,
    })

    await expect(
      registerEscrowStealthPayout({
        wallet: mockWallet,
        ephemeralPubKey: payout.ephemeralPubKey,
        stealthAddress: '0x0000000000000000000000000000000000000001', // mismatched
        payoutWei: 100n,
      }),
    ).rejects.toThrow(/does not match expected/)
  })
})
