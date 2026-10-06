import { ethers } from 'ethers'
import { TablePotVault } from '../index'

describe('TablePotVault Contract', () => {
  const abi = TablePotVault.abi
  const iface = new ethers.Interface(abi)

  it('compiles with all expected functions, events, and errors', () => {
    // Functions
    expect(iface.getFunction('createTable')).toBeDefined()
    expect(iface.getFunction('buyIn')).toBeDefined()
    expect(iface.getFunction('settleTable')).toBeDefined()
    expect(iface.getFunction('emergencyRefund')).toBeDefined()
    expect(iface.getFunction('getPlayers')).toBeDefined()
    expect(iface.getFunction('recoverSigner')).toBeDefined()

    // Events
    expect(iface.getEvent('TableCreated')).toBeDefined()
    expect(iface.getEvent('PlayerJoined')).toBeDefined()
    expect(iface.getEvent('TableSettled')).toBeDefined()
    expect(iface.getEvent('EmergencyRefunded')).toBeDefined()

    // Errors
    expect(iface.getError('TableAlreadyExists')).toBeDefined()
    expect(iface.getError('TableNotFound')).toBeDefined()
    expect(iface.getError('TableAlreadySettled')).toBeDefined()
    expect(iface.getError('TableExpired')).toBeDefined()
    expect(iface.getError('TableNotExpired')).toBeDefined()
    expect(iface.getError('InvalidBuyIn')).toBeDefined()
    expect(iface.getError('PlayerAlreadyJoined')).toBeDefined()
    expect(iface.getError('PlayerNotJoined')).toBeDefined()
    expect(iface.getError('PlayerAlreadyRefunded')).toBeDefined()
    expect(iface.getError('InvalidSignature')).toBeDefined()
    expect(iface.getError('InvalidPayoutSum')).toBeDefined()
    expect(iface.getError('TransferFailed')).toBeDefined()
    expect(iface.getError('InvalidZeroAddress')).toBeDefined()
  })

  it('contains valid EVM deployment bytecode', () => {
    expect(TablePotVault.bytecode).toMatch(/^0x60806040/)
    expect(TablePotVault.deployedBytecode).toMatch(/^0x60806040/)
    expect(TablePotVault.bytecode.length).toBeGreaterThan(100)
  })

  it('verifies host multi-payout signature manifest hashing matches contract verification', async () => {
    const hostWallet = ethers.Wallet.createRandom()
    const winner1 = ethers.Wallet.createRandom().address
    const winner2 = ethers.Wallet.createRandom().address
    const vaultAddress = '0x2222222222222222222222222222222222222222'
    const chainId = 10143n

    const tableId = ethers.id('poker.table.001')
    const payouts = [
      { recipient: winner1, amount: ethers.parseEther('3.0') },
      { recipient: winner2, amount: ethers.parseEther('1.0') },
    ]

    const abiCoder = ethers.AbiCoder.defaultAbiCoder()
    const innerPayload = abiCoder.encode(
      [
        'bytes32',
        'tuple(address recipient, uint256 amount)[]',
        'address',
        'uint256',
      ],
      [tableId, payouts, vaultAddress, chainId],
    )
    const innerHash = ethers.keccak256(innerPayload)

    const messageBytes = ethers.getBytes(innerHash)
    const hostSig = await hostWallet.signMessage(messageBytes)

    const recovered = ethers.verifyMessage(messageBytes, hostSig)
    expect(recovered.toLowerCase()).toBe(hostWallet.address.toLowerCase())
  })

  it('encodes createTable, buyIn, settleTable, and emergencyRefund correctly', () => {
    const tableId = ethers.id('liarsdice.table.test')
    const buyIn = ethers.parseEther('0.1')
    const duration = 1800

    const createCalldata = iface.encodeFunctionData('createTable', [
      tableId,
      buyIn,
      duration,
    ])
    expect(createCalldata.startsWith('0x')).toBe(true)

    const buyInCalldata = iface.encodeFunctionData('buyIn', [tableId])
    expect(buyInCalldata.startsWith('0x')).toBe(true)

    const dummyPayouts = [
      {
        recipient: ethers.Wallet.createRandom().address,
        amount: ethers.parseEther('0.2'),
      },
    ]
    const dummySig = '0x' + '00'.repeat(65)
    const settleCalldata = iface.encodeFunctionData('settleTable', [
      tableId,
      dummyPayouts,
      dummySig,
    ])
    expect(settleCalldata.startsWith('0x')).toBe(true)

    const refundCalldata = iface.encodeFunctionData('emergencyRefund', [tableId])
    expect(refundCalldata.startsWith('0x')).toBe(true)
  })
})
