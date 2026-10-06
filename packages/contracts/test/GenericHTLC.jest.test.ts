import { ethers } from 'ethers'
import { GenericHTLC } from '../index'

describe('GenericHTLC Contract', () => {
  const abi = GenericHTLC.abi
  const iface = new ethers.Interface(abi)

  it('compiles with all expected functions, events, and errors', () => {
    // Functions
    expect(iface.getFunction('lock(bytes32,address,address,bytes32,uint256)')).toBeDefined()
    expect(iface.getFunction('lock(bytes32,address,bytes32,uint256)')).toBeDefined()
    expect(iface.getFunction('withdraw')).toBeDefined()
    expect(iface.getFunction('batchWithdraw')).toBeDefined()
    expect(iface.getFunction('batchDistribute')).toBeDefined()
    expect(iface.getFunction('refund')).toBeDefined()

    // Events
    expect(iface.getEvent('Locked')).toBeDefined()
    expect(iface.getEvent('Withdrawn')).toBeDefined()
    expect(iface.getEvent('BatchDistributed')).toBeDefined()
    expect(iface.getEvent('Refunded')).toBeDefined()

    // Errors
    expect(iface.getError('LockAlreadyExists')).toBeDefined()
    expect(iface.getError('LockNotFound')).toBeDefined()
    expect(iface.getError('AlreadyWithdrawn')).toBeDefined()
    expect(iface.getError('AlreadyRefunded')).toBeDefined()
    expect(iface.getError('LockExpired')).toBeDefined()
    expect(iface.getError('LockNotExpired')).toBeDefined()
    expect(iface.getError('InvalidPreimage')).toBeDefined()
    expect(iface.getError('InvalidZeroAddress')).toBeDefined()
    expect(iface.getError('TransferFailed')).toBeDefined()
    expect(iface.getError('ZeroAmount')).toBeDefined()
    expect(iface.getError('InvalidPayoutSum')).toBeDefined()
    expect(iface.getError('EmptyBatch')).toBeDefined()
  })

  it('contains valid EVM deployment bytecode', () => {
    expect(GenericHTLC.bytecode).toMatch(/^0x60806040/)
    expect(GenericHTLC.deployedBytecode).toMatch(/^0x60806040/)
    expect(GenericHTLC.bytecode.length).toBeGreaterThan(100)
  })

  it('correctly hashes preimages using both sha256 and keccak256', () => {
    const preimage = ethers.toUtf8Bytes('secret-swap-preimage-12345')

    // sha256 (for Bitcoin / eCash cross-chain HTLCs)
    const sha256Hash = ethers.sha256(preimage)
    expect(sha256Hash.length).toBe(66)

    // keccak256 (for native EVM HTLCs)
    const keccak256Hash = ethers.keccak256(preimage)
    expect(keccak256Hash.length).toBe(66)
    expect(sha256Hash).not.toBe(keccak256Hash)
  })

  it('encodes lock with explicit refundAddress and batchDistribute correctly', () => {
    const lockId1 = ethers.id('lock.test.1')
    const lockId2 = ethers.id('lock.test.2')
    const recipient1 = ethers.Wallet.createRandom().address
    const recipient2 = ethers.Wallet.createRandom().address
    const refundAddress = ethers.Wallet.createRandom().address
    const hashLock = ethers.keccak256(ethers.toUtf8Bytes('table-secret'))
    const duration = 7200

    // Explicit refundAddress lock
    const lockCalldata = iface.encodeFunctionData(
      'lock(bytes32,address,address,bytes32,uint256)',
      [lockId1, recipient1, refundAddress, hashLock, duration],
    )
    expect(lockCalldata.startsWith('0x')).toBe(true)

    // Multi-winner batchDistribute
    const preimage = ethers.toUtf8Bytes('table-secret')
    const payouts = [
      { recipient: recipient1, amount: ethers.parseEther('1.4') },
      { recipient: recipient2, amount: ethers.parseEther('0.6') },
    ]

    const distributeCalldata = iface.encodeFunctionData('batchDistribute', [
      [lockId1, lockId2],
      payouts,
      preimage,
    ])
    expect(distributeCalldata.startsWith('0x')).toBe(true)
  })
})
