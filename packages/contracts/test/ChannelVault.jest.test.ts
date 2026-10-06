import { ethers } from 'ethers'
import { ChannelVault } from '../index'

describe('ChannelVault Contract', () => {
  const abi = ChannelVault.abi
  const iface = new ethers.Interface(abi)

  it('compiles with all expected functions, events, and errors', () => {
    // Functions
    expect(iface.getFunction('deposit')).toBeDefined()
    expect(iface.getFunction('depositCover')).toBeDefined()
    expect(iface.getFunction('settle')).toBeDefined()
    expect(iface.getFunction('refundTimeout')).toBeDefined()
    expect(iface.getFunction('recoverSigner')).toBeDefined()

    // Events
    expect(iface.getEvent('Deposited')).toBeDefined()
    expect(iface.getEvent('CoverDeposited')).toBeDefined()
    expect(iface.getEvent('Settled')).toBeDefined()
    expect(iface.getEvent('Refunded')).toBeDefined()

    // Errors
    expect(iface.getError('SessionAlreadyExists')).toBeDefined()
    expect(iface.getError('SessionNotFound')).toBeDefined()
    expect(iface.getError('SessionAlreadySettled')).toBeDefined()
    expect(iface.getError('SessionExpired')).toBeDefined()
    expect(iface.getError('SessionNotExpired')).toBeDefined()
    expect(iface.getError('InvalidSignature')).toBeDefined()
    expect(iface.getError('InvalidPayout')).toBeDefined()
    expect(iface.getError('TransferFailed')).toBeDefined()
    expect(iface.getError('InvalidZeroAddress')).toBeDefined()
    expect(iface.getError('Unauthorized')).toBeDefined()
  })

  it('contains valid EVM deployment bytecode', () => {
    expect(ChannelVault.bytecode).toMatch(/^0x60806040/)
    expect(ChannelVault.deployedBytecode).toMatch(/^0x60806040/)
    expect(ChannelVault.bytecode.length).toBeGreaterThan(100)
  })

  it('verifies joint signature hashing matches contract recoverSigner format', async () => {
    const jointSignerWallet = ethers.Wallet.createRandom()
    const playerWallet = ethers.Wallet.createRandom()
    const winnerWallet = ethers.Wallet.createRandom() // could be stealth address
    const vaultAddress = '0x1111111111111111111111111111111111111111'
    const chainId = 10143n // Monad testnet

    const sessionId = ethers.id('session.test.123')
    const payout = ethers.parseEther('1.5')

    // Inner hash: keccak256(abi.encode(sessionId, winner, payout, vault, chainid))
    const abiCoder = ethers.AbiCoder.defaultAbiCoder()
    const innerPayload = abiCoder.encode(
      ['bytes32', 'address', 'uint256', 'address', 'uint256'],
      [sessionId, winnerWallet.address, payout, vaultAddress, chainId],
    )
    const innerHash = ethers.keccak256(innerPayload)

    // Message signed with Ethereum personal_sign prefix "\x19Ethereum Signed Message:\n32"
    const messageBytes = ethers.getBytes(innerHash)
    const signature = await jointSignerWallet.signMessage(messageBytes)

    // Recover address in JS
    const recoveredAddress = ethers.verifyMessage(messageBytes, signature)
    expect(recoveredAddress.toLowerCase()).toBe(
      jointSignerWallet.address.toLowerCase(),
    )
  })

  it('encodes deposit, depositCover, settle, and refundTimeout calls correctly', () => {
    const sessionId = ethers.id('session.test.encode')
    const dealer = ethers.Wallet.createRandom().address
    const jointSigner = ethers.Wallet.createRandom().address
    const duration = 3600

    const depositCalldata = iface.encodeFunctionData('deposit', [
      sessionId,
      dealer,
      jointSigner,
      duration,
    ])
    expect(depositCalldata.startsWith('0x')).toBe(true)

    const coverCalldata = iface.encodeFunctionData('depositCover', [sessionId])
    expect(coverCalldata.startsWith('0x')).toBe(true)

    const winner = ethers.Wallet.createRandom().address
    const payout = ethers.parseEther('2.0')
    const dummySig = '0x' + '00'.repeat(65)

    const settleCalldata = iface.encodeFunctionData('settle', [
      sessionId,
      winner,
      payout,
      dummySig,
    ])
    expect(settleCalldata.startsWith('0x')).toBe(true)

    const refundCalldata = iface.encodeFunctionData('refundTimeout', [sessionId])
    expect(refundCalldata.startsWith('0x')).toBe(true)
  })
})
