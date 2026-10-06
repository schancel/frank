import { ethers } from 'ethers'
import { StateChannel } from '../index'

describe('StateChannel Contract', () => {
  const abi = StateChannel.abi
  const iface = new ethers.Interface(abi)

  it('compiles with all expected functions, events, and errors', () => {
    // Functions
    expect(iface.getFunction('openChannel')).toBeDefined()
    expect(iface.getFunction('joinChannel')).toBeDefined()
    expect(iface.getFunction('checkpoint')).toBeDefined()
    expect(iface.getFunction('closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)')).toBeDefined()
    expect(iface.getFunction('closeCooperative(bytes32,uint256,uint256[2],bytes,bytes)')).toBeDefined()
    expect(iface.getFunction('closeAfterChallenge')).toBeDefined()
    expect(iface.getFunction('refundTimeout')).toBeDefined()
    expect(iface.getFunction('getCheckpointDigest')).toBeDefined()
    expect(iface.getFunction('getCloseDigest')).toBeDefined()

    // Events
    expect(iface.getEvent('ChannelOpened')).toBeDefined()
    expect(iface.getEvent('ChannelJoined')).toBeDefined()
    expect(iface.getEvent('Checkpointed')).toBeDefined()
    expect(iface.getEvent('ChannelSettled')).toBeDefined()
    expect(iface.getEvent('ChannelRefunded')).toBeDefined()

    // Errors
    expect(iface.getError('ChannelAlreadyExists')).toBeDefined()
    expect(iface.getError('ChannelNotFound')).toBeDefined()
    expect(iface.getError('ChannelAlreadySettled')).toBeDefined()
    expect(iface.getError('StaleSequence')).toBeDefined()
    expect(iface.getError('InvalidBalanceSum')).toBeDefined()
    expect(iface.getError('InvalidSignature')).toBeDefined()
    expect(iface.getError('ChallengeNotExpired')).toBeDefined()
    expect(iface.getError('ChallengeNotActive')).toBeDefined()
  })

  it('contains valid EVM deployment bytecode', () => {
    expect(StateChannel.bytecode).toMatch(/^0x60806040/)
    expect(StateChannel.deployedBytecode).toMatch(/^0x60806040/)
    expect(StateChannel.bytecode.length).toBeGreaterThan(100)
  })

  it('verifies off-chain mutual signature digests match contract verification for checkpoints and cooperative closes', async () => {
    const aliceWallet = ethers.Wallet.createRandom()
    const bobWallet = ethers.Wallet.createRandom()
    const stealthWinner = ethers.Wallet.createRandom().address
    const contractAddress = '0x1111111111111111111111111111111111111111'
    const chainId = 10143n // Monad testnet

    const channelId = ethers.id('channel.test.123')
    const seq = 5n
    const balances = [ethers.parseEther('1.25'), ethers.parseEther('0.75')] as const

    // --- Checkpoint Digest Verification ---
    // innerPayload = keccak256(abi.encode(channelId, seq, balances, isFinal=false, contractAddress, chainId))
    const abiCoder = ethers.AbiCoder.defaultAbiCoder()
    const checkpointInner = ethers.keccak256(
      abiCoder.encode(
        ['bytes32', 'uint256', 'uint256[2]', 'bool', 'address', 'uint256'],
        [channelId, seq, balances, false, contractAddress, chainId],
      ),
    )
    const checkpointDigest = ethers.keccak256(
      ethers.concat([
        ethers.toUtf8Bytes('\x19Ethereum Signed Message:\n32'),
        ethers.getBytes(checkpointInner),
      ]),
    )

    // Alice and Bob co-sign the checkpoint state
    const sig0 = await aliceWallet.signMessage(ethers.getBytes(checkpointInner))
    const sig1 = await bobWallet.signMessage(ethers.getBytes(checkpointInner))

    expect(ethers.recoverAddress(checkpointDigest, sig0)).toBe(aliceWallet.address)
    expect(ethers.recoverAddress(checkpointDigest, sig1)).toBe(bobWallet.address)

    // --- Close Cooperative with Stealth Payout Verification ---
    const closeInner = ethers.keccak256(
      abiCoder.encode(
        ['bytes32', 'uint256', 'uint256[2]', 'address', 'address', 'bool', 'address', 'uint256'],
        [channelId, seq, balances, stealthWinner, bobWallet.address, true, contractAddress, chainId],
      ),
    )
    const closeDigest = ethers.keccak256(
      ethers.concat([
        ethers.toUtf8Bytes('\x19Ethereum Signed Message:\n32'),
        ethers.getBytes(closeInner),
      ]),
    )

    const closeSig0 = await aliceWallet.signMessage(ethers.getBytes(closeInner))
    const closeSig1 = await bobWallet.signMessage(ethers.getBytes(closeInner))

    expect(ethers.recoverAddress(closeDigest, closeSig0)).toBe(aliceWallet.address)
    expect(ethers.recoverAddress(closeDigest, closeSig1)).toBe(bobWallet.address)
  })
})
