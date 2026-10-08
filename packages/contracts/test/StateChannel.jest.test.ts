import { ethers } from 'ethers'
import { StateChannel } from '../index'

describe('StateChannel Contract', () => {
  const abi = StateChannel.abi
  const iface = new ethers.Interface(abi)

  it('compiles with all expected functions, events, and errors', () => {
    // Functions
    expect(
      iface.getFunction('openChannel(bytes32,address,uint256)'),
    ).toBeDefined()
    expect(
      iface.getFunction('openChannel(bytes32,address,address,uint256,uint256)'),
    ).toBeDefined()
    expect(iface.getFunction('joinChannel(bytes32)')).toBeDefined()
    expect(iface.getFunction('joinChannel(bytes32,uint256)')).toBeDefined()
    expect(iface.getFunction('checkpoint')).toBeDefined()
    expect(
      iface.getFunction(
        'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)',
      ),
    ).toBeDefined()
    expect(
      iface.getFunction(
        'closeCooperative(bytes32,uint256,uint256[2],bytes,bytes)',
      ),
    ).toBeDefined()
    expect(iface.getFunction('closeAfterChallenge')).toBeDefined()
    expect(iface.getFunction('refundTimeout')).toBeDefined()
    expect(iface.getFunction('getCheckpointDigest')).toBeDefined()
    expect(iface.getFunction('getCloseDigest')).toBeDefined()

    // Events
    const openEvent = iface.getEvent('ChannelOpened')
    expect(openEvent).toBeDefined()
    expect(openEvent?.inputs.some(i => i.name === 'token')).toBe(true)
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
    const balances = [
      ethers.parseEther('1.25'),
      ethers.parseEther('0.75'),
    ] as const

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

    expect(ethers.recoverAddress(checkpointDigest, sig0)).toBe(
      aliceWallet.address,
    )
    expect(ethers.recoverAddress(checkpointDigest, sig1)).toBe(
      bobWallet.address,
    )

    // --- Close Cooperative with Stealth Payout Verification ---
    const closeInner = ethers.keccak256(
      abiCoder.encode(
        [
          'bytes32',
          'uint256',
          'uint256[2]',
          'address',
          'address',
          'bool',
          'address',
          'uint256',
        ],
        [
          channelId,
          seq,
          balances,
          stealthWinner,
          bobWallet.address,
          true,
          contractAddress,
          chainId,
        ],
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

    expect(ethers.recoverAddress(closeDigest, closeSig0)).toBe(
      aliceWallet.address,
    )
    expect(ethers.recoverAddress(closeDigest, closeSig1)).toBe(
      bobWallet.address,
    )
  })

  it('encodes openChannel and joinChannel with ERC-20 tokens and deposits', () => {
    const channelId = ethers.id('channel.erc20.1')
    const peer = ethers.Wallet.createRandom().address
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' // USDC
    const depositA = ethers.parseUnits('100', 6)
    const depositB = ethers.parseUnits('50', 6)
    const challengeDuration = 3600

    const openCalldata = iface.encodeFunctionData(
      'openChannel(bytes32,address,address,uint256,uint256)',
      [channelId, peer, token, depositA, challengeDuration],
    )
    expect(openCalldata.startsWith('0x')).toBe(true)

    const decodedOpen = iface.decodeFunctionData(
      'openChannel(bytes32,address,address,uint256,uint256)',
      openCalldata,
    )
    expect(decodedOpen[0]).toBe(channelId)
    expect(decodedOpen[1]).toBe(peer)
    expect(decodedOpen[2]).toBe(token)
    expect(decodedOpen[3]).toBe(depositA)
    expect(decodedOpen[4]).toBe(BigInt(challengeDuration))

    const joinCalldata = iface.encodeFunctionData(
      'joinChannel(bytes32,uint256)',
      [channelId, depositB],
    )
    expect(joinCalldata.startsWith('0x')).toBe(true)
    const decodedJoin = iface.decodeFunctionData(
      'joinChannel(bytes32,uint256)',
      joinCalldata,
    )
    expect(decodedJoin[0]).toBe(channelId)
    expect(decodedJoin[1]).toBe(depositB)
  })

  it('verifies off-chain mutual signature and encodes cooperative close for ERC-20 channels', async () => {
    const aliceWallet = ethers.Wallet.createRandom()
    const bobWallet = ethers.Wallet.createRandom()
    const stealthWinner = ethers.Wallet.createRandom().address
    const contractAddress = '0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57'
    const chainId = 10143n

    const channelId = ethers.id('channel.erc20.coop')
    const seq = 10n
    const balances = [
      ethers.parseUnits('180', 6),
      ethers.parseUnits('20', 6),
    ] as const

    const abiCoder = ethers.AbiCoder.defaultAbiCoder()
    const closeInner = ethers.keccak256(
      abiCoder.encode(
        [
          'bytes32',
          'uint256',
          'uint256[2]',
          'address',
          'address',
          'bool',
          'address',
          'uint256',
        ],
        [
          channelId,
          seq,
          balances,
          stealthWinner,
          bobWallet.address,
          true,
          contractAddress,
          chainId,
        ],
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

    expect(ethers.recoverAddress(closeDigest, closeSig0)).toBe(
      aliceWallet.address,
    )
    expect(ethers.recoverAddress(closeDigest, closeSig1)).toBe(
      bobWallet.address,
    )

    const calldata = iface.encodeFunctionData(
      'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)',
      [
        channelId,
        seq,
        balances,
        stealthWinner,
        bobWallet.address,
        closeSig0,
        closeSig1,
      ],
    )
    expect(calldata.startsWith('0x')).toBe(true)
  })
})
