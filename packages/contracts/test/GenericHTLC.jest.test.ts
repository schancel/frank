import { ethers } from 'ethers'
import { GenericHTLC, IERC20 } from '../index'

describe('GenericHTLC Contract', () => {
  const abi = GenericHTLC.abi
  const iface = new ethers.Interface(abi)

  it('compiles with all expected functions, events, and errors', () => {
    // Functions - native and ERC-20 overloads
    expect(
      iface.getFunction('lock(bytes32,address,address,bytes32,uint256)'),
    ).toBeDefined()
    expect(
      iface.getFunction('lock(bytes32,address,bytes32,uint256)'),
    ).toBeDefined()
    expect(
      iface.getFunction(
        'lock(bytes32,address,address,address,uint256,bytes32,uint256)',
      ),
    ).toBeDefined()
    expect(
      iface.getFunction(
        'lock(bytes32,address,address,uint256,bytes32,uint256)',
      ),
    ).toBeDefined()
    expect(
      iface.getFunction(
        'lockWithPermit(bytes32,address,address,address,uint256,bytes32,uint256,uint256,uint8,bytes32,bytes32)',
      ),
    ).toBeDefined()
    expect(
      iface.getFunction(
        'lockWithPermit(bytes32,address,address,uint256,bytes32,uint256,uint256,uint8,bytes32,bytes32)',
      ),
    ).toBeDefined()
    expect(iface.getFunction('withdraw')).toBeDefined()
    expect(iface.getFunction('batchWithdraw')).toBeDefined()
    expect(iface.getFunction('batchDistribute')).toBeDefined()
    expect(iface.getFunction('refund')).toBeDefined()

    // Events
    const lockedEvent = iface.getEvent('Locked')
    expect(lockedEvent).toBeDefined()
    expect(lockedEvent?.inputs.some(i => i.name === 'token' && i.indexed)).toBe(
      true,
    )
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
    expect(iface.getError('TokenMismatch')).toBeDefined()
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

  it('encodes ERC-20 lock with token address and amount correctly', () => {
    const lockId = ethers.id('lock.erc20.1')
    const recipient = ethers.Wallet.createRandom().address
    const refundAddress = ethers.Wallet.createRandom().address
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
    const amount = ethers.parseUnits('100.5', 6)
    const hashLock = ethers.keccak256(ethers.toUtf8Bytes('secret-preimage'))
    const duration = 3600

    const calldata = iface.encodeFunctionData(
      'lock(bytes32,address,address,address,uint256,bytes32,uint256)',
      [lockId, recipient, refundAddress, token, amount, hashLock, duration],
    )
    expect(calldata.startsWith('0x')).toBe(true)

    const decoded = iface.decodeFunctionData(
      'lock(bytes32,address,address,address,uint256,bytes32,uint256)',
      calldata,
    )
    expect(decoded[0]).toBe(lockId)
    expect(decoded[1]).toBe(recipient)
    expect(decoded[2]).toBe(refundAddress)
    expect(decoded[3]).toBe(token)
    expect(decoded[4]).toBe(amount)
    expect(decoded[5]).toBe(hashLock)
    expect(decoded[6]).toBe(BigInt(duration))
  })

  it('encodes lockWithPermit calldata with EIP-2612 permit parameters', async () => {
    const ownerWallet = ethers.Wallet.createRandom()
    const recipient = ethers.Wallet.createRandom().address
    const refundAddress = ethers.Wallet.createRandom().address
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
    const htlcContractAddress = '0x391a080Bd6FF21CB4598adF063Dc94018CD186E5'
    const lockId = ethers.id('lock.permit.test')
    const amount = ethers.parseUnits('500', 6)
    const hashLock = ethers.sha256(ethers.toUtf8Bytes('permit-secret'))
    const duration = 1800
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const nonce = 0n
    const chainId = 10143 // Monad testnet

    // EIP-712 Domain and Types for EIP-2612 Permit
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId,
      verifyingContract: token,
    }
    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    }
    const message = {
      owner: ownerWallet.address,
      spender: htlcContractAddress,
      value: amount,
      nonce,
      deadline,
    }

    const rawSig = await ownerWallet.signTypedData(domain, types, message)
    const sig = ethers.Signature.from(rawSig)

    const calldata = iface.encodeFunctionData(
      'lockWithPermit(bytes32,address,address,address,uint256,bytes32,uint256,uint256,uint8,bytes32,bytes32)',
      [
        lockId,
        recipient,
        refundAddress,
        token,
        amount,
        hashLock,
        duration,
        deadline,
        sig.v,
        sig.r,
        sig.s,
      ],
    )

    expect(calldata.startsWith('0x')).toBe(true)
    const decoded = iface.decodeFunctionData(
      'lockWithPermit(bytes32,address,address,address,uint256,bytes32,uint256,uint256,uint8,bytes32,bytes32)',
      calldata,
    )
    expect(decoded[0]).toBe(lockId)
    expect(decoded[1]).toBe(recipient)
    expect(decoded[2]).toBe(refundAddress)
    expect(decoded[3]).toBe(token)
    expect(decoded[4]).toBe(amount)
    expect(decoded[7]).toBe(deadline)
    expect(Number(decoded[8])).toBe(sig.v)
    expect(decoded[9]).toBe(sig.r)
    expect(decoded[10]).toBe(sig.s)
  })

  it('encodes batchDistribute with token addresses for ERC-20 pooled escrows', () => {
    const lockId1 = ethers.id('token.pool.1')
    const lockId2 = ethers.id('token.pool.2')
    const winner1 = ethers.Wallet.createRandom().address
    const winner2 = ethers.Wallet.createRandom().address
    const preimage = ethers.toUtf8Bytes('group-pot-secret')

    const payouts = [
      { recipient: winner1, amount: ethers.parseUnits('750', 6) },
      { recipient: winner2, amount: ethers.parseUnits('250', 6) },
    ]

    const distributeCalldata = iface.encodeFunctionData('batchDistribute', [
      [lockId1, lockId2],
      payouts,
      preimage,
    ])

    expect(distributeCalldata.startsWith('0x')).toBe(true)
    const decoded = iface.decodeFunctionData(
      'batchDistribute',
      distributeCalldata,
    )
    expect(decoded[0]).toEqual([lockId1, lockId2])
    expect(decoded[1].length).toBe(2)
    expect(decoded[1][0].recipient).toBe(winner1)
    expect(decoded[1][0].amount).toBe(ethers.parseUnits('750', 6))
    expect(decoded[2]).toBe(ethers.hexlify(preimage))
  })

  it('exports valid IERC20 interface artifact', () => {
    const erc20Iface = new ethers.Interface(IERC20.abi)
    expect(erc20Iface.getFunction('totalSupply')).toBeDefined()
    expect(erc20Iface.getFunction('balanceOf')).toBeDefined()
    expect(erc20Iface.getFunction('transfer')).toBeDefined()
    expect(erc20Iface.getFunction('transferFrom')).toBeDefined()
    expect(erc20Iface.getFunction('approve')).toBeDefined()
    expect(erc20Iface.getFunction('allowance')).toBeDefined()
    expect(erc20Iface.getFunction('permit')).toBeDefined()
  })
})
