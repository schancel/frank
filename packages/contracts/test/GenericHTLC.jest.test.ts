import { ethers } from 'ethers'
import { GenericHTLC } from '../index'

describe('GenericHTLC Contract', () => {
  const abi = GenericHTLC.abi
  const iface = new ethers.Interface(abi)

  it('compiles with all expected functions, events, and errors', () => {
    // Functions
    expect(iface.getFunction('lock')).toBeDefined()
    expect(iface.getFunction('withdraw')).toBeDefined()
    expect(iface.getFunction('batchWithdraw')).toBeDefined()
    expect(iface.getFunction('refund')).toBeDefined()

    // Events
    expect(iface.getEvent('Locked')).toBeDefined()
    expect(iface.getEvent('Withdrawn')).toBeDefined()
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

  it('encodes lock, withdraw, batchWithdraw, and refund correctly', () => {
    const lockId1 = ethers.id('lock.test.1')
    const lockId2 = ethers.id('lock.test.2')
    const recipient = ethers.Wallet.createRandom().address
    const hashLock = ethers.sha256(ethers.toUtf8Bytes('secret'))
    const duration = 7200

    const lockCalldata = iface.encodeFunctionData('lock', [
      lockId1,
      recipient,
      hashLock,
      duration,
    ])
    expect(lockCalldata.startsWith('0x')).toBe(true)

    const preimage = ethers.toUtf8Bytes('secret')
    const withdrawCalldata = iface.encodeFunctionData('withdraw', [
      lockId1,
      preimage,
    ])
    expect(withdrawCalldata.startsWith('0x')).toBe(true)

    const batchCalldata = iface.encodeFunctionData('batchWithdraw', [
      [lockId1, lockId2],
      preimage,
    ])
    expect(batchCalldata.startsWith('0x')).toBe(true)

    const refundCalldata = iface.encodeFunctionData('refund', [lockId1])
    expect(refundCalldata.startsWith('0x')).toBe(true)
  })
})
