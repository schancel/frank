/**
 * StateChannel, deployed to and executed by a local anvil node.
 */
import { ethers } from 'ethers'
import { StateChannel } from '../index'
import {
  deploy,
  expectRevert,
  mined,
  startAnvil,
  testContract,
  type Anvil,
} from './anvil'

const OPEN_NATIVE = 'openChannel(bytes32,address,uint256)'
const OPEN_TOKEN = 'openChannel(bytes32,address,address,uint256,uint256)'
const JOIN_NATIVE = 'joinChannel(bytes32)'
const JOIN_TOKEN = 'joinChannel(bytes32,uint256)'
const CLOSE = 'closeCooperative(bytes32,uint256,uint256[2],bytes,bytes)'
const CLOSE_TO = 'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)'
const CHALLENGE = 3600
const TEN = ethers.parseEther('10')
type Balances = [bigint, bigint]

describe('StateChannel on a local EVM node', () => {
  let anvil: Anvil
  let channel: ethers.Contract
  let channelAddress: string
  let chainId: bigint
  let alice: ethers.HDNodeWallet
  let bob: ethers.HDNodeWallet
  let stranger: ethers.HDNodeWallet
  let payoutA: ethers.HDNodeWallet
  let payoutB: ethers.HDNodeWallet
  let counter = 0

  const as = (who: ethers.Signer) => channel.connect(who) as ethers.Contract
  const balance = (who: { address: string } | string) =>
    anvil.provider.getBalance(typeof who === 'string' ? who : who.address)

  /** What a party signs off-chain for an intermediate state. */
  function signCheckpoint(who: ethers.HDNodeWallet, id: string, seq: number, balances: Balances) {
    const payload = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'uint256[2]', 'bool', 'address', 'uint256'],
        [id, seq, balances, false, channelAddress, chainId],
      ),
    )
    return who.signMessage(ethers.getBytes(payload))
  }

  /** What a party signs off-chain to close now, naming where each balance is paid. */
  function signClose(
    who: ethers.HDNodeWallet,
    id: string,
    seq: number,
    balances: Balances,
    payout0 = ethers.ZeroAddress,
    payout1 = ethers.ZeroAddress,
  ) {
    const payload = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'uint256[2]', 'address', 'address', 'bool', 'address', 'uint256'],
        [id, seq, balances, payout0, payout1, true, channelAddress, chainId],
      ),
    )
    return who.signMessage(ethers.getBytes(payload))
  }

  async function checkpoint(by: ethers.Signer, id: string, seq: number, balances: Balances) {
    return as(by).checkpoint(
      id,
      seq,
      balances,
      await signCheckpoint(alice, id, seq, balances),
      await signCheckpoint(bob, id, seq, balances),
    )
  }

  /** Alice opens with 10, Bob joins with 10. */
  async function openFunded(): Promise<string> {
    const id = ethers.id(`channel-${counter++}`)
    await mined(as(alice)[OPEN_NATIVE](id, bob.address, CHALLENGE, { value: TEN }))
    await mined(as(bob)[JOIN_NATIVE](id, { value: TEN }))
    return id
  }

  beforeAll(async () => {
    anvil = await startAnvil()
    ;[alice, bob, stranger, payoutA, payoutB] = anvil.accounts
    channel = await deploy(StateChannel, alice)
    channelAddress = await channel.getAddress()
    chainId = (await anvil.provider.getNetwork()).chainId
  }, 60_000)

  afterAll(async () => {
    await anvil?.stop()
  })

  it('runs the checked-in runtime bytecode', async () => {
    expect(await anvil.provider.getCode(channelAddress)).toBe(StateChannel.deployedBytecode)
  })

  describe('open and join', () => {
    it('holds both deposits', async () => {
      const before = await balance(channelAddress)
      const id = await openFunded()
      expect((await balance(channelAddress)) - before).toBe(TEN * 2n)
      const state = await channel.channels(id)
      expect(state.token).toBe(ethers.ZeroAddress)
      expect(state.currentSeq).toBe(0n)
      expect(state.challengeExpiresAt).toBe(0n)
      expect(state.settled).toBe(false)
    })

    it('refuses a taken channel id, a channel with oneself and a zero challenge window', async () => {
      const id = await openFunded()
      const open = as(alice)[OPEN_NATIVE]
      await expectRevert(open(id, bob.address, CHALLENGE, { value: TEN }), 'ChannelAlreadyExists')
      await expectRevert(
        open(ethers.id('self'), alice.address, CHALLENGE, { value: TEN }),
        'InvalidZeroAddress',
      )
      await expectRevert(open(ethers.id('zero'), bob.address, 0, { value: TEN }), 'ZeroDuration')
    })

    it('lets only the named peer join, once, with a deposit', async () => {
      const id = ethers.id(`channel-${counter++}`)
      await mined(as(alice)[OPEN_NATIVE](id, bob.address, CHALLENGE, { value: TEN }))
      await expectRevert(as(stranger)[JOIN_NATIVE](id, { value: TEN }), 'Unauthorized')
      await expectRevert(as(bob)[JOIN_NATIVE](id, { value: 0 }), 'ZeroDeposit')
      await mined(as(bob)[JOIN_NATIVE](id, { value: TEN }))
      await expectRevert(as(bob)[JOIN_NATIVE](id, { value: 1 }), 'AlreadyJoined')
    })

    it('opens, joins and closes an ERC-20 channel', async () => {
      const token = await deploy(testContract('TestToken'), alice)
      const tokenAddress = await token.getAddress()
      for (const who of [alice, bob]) {
        await mined((token.connect(who) as ethers.Contract).mint(who.address, TEN))
        await mined((token.connect(who) as ethers.Contract).approve(channelAddress, TEN))
      }
      const id = ethers.id(`channel-${counter++}`)
      await mined(as(alice)[OPEN_TOKEN](id, bob.address, tokenAddress, TEN, CHALLENGE))
      await mined(as(bob)[JOIN_TOKEN](id, TEN))
      expect(await token.balanceOf(channelAddress)).toBe(TEN * 2n)

      const final: Balances = [TEN * 2n - 1n, 1n]
      await mined(
        as(stranger)[CLOSE](
          id,
          1,
          final,
          await signClose(alice, id, 1, final),
          await signClose(bob, id, 1, final),
        ),
      )
      expect(await token.balanceOf(alice.address)).toBe(final[0])
      expect(await token.balanceOf(bob.address)).toBe(final[1])
      expect(await token.balanceOf(channelAddress)).toBe(0n)
    })
  })

  describe('cooperative close', () => {
    it('pays the agreed balances at once and settles the channel', async () => {
      const id = await openFunded()
      const final: Balances = [ethers.parseEther('14'), ethers.parseEther('6')]
      const aliceBefore = await balance(alice)
      const bobBefore = await balance(bob)

      await mined(
        as(stranger)[CLOSE](
          id,
          5,
          final,
          await signClose(alice, id, 5, final),
          await signClose(bob, id, 5, final),
        ),
      )

      expect((await balance(alice)) - aliceBefore).toBe(final[0])
      expect((await balance(bob)) - bobBefore).toBe(final[1])
      expect((await channel.channels(id)).settled).toBe(true)
    })

    it('pays to the payout addresses both parties signed', async () => {
      const id = await openFunded()
      const final: Balances = [ethers.parseEther('3'), ethers.parseEther('17')]
      const sigs = [
        await signClose(alice, id, 2, final, payoutA.address, payoutB.address),
        await signClose(bob, id, 2, final, payoutA.address, payoutB.address),
      ]
      const aBefore = await balance(payoutA)
      const bBefore = await balance(payoutB)

      // The signatures do not cover other payout addresses.
      await expectRevert(
        as(stranger)[CLOSE_TO](id, 2, final, stranger.address, payoutB.address, ...sigs),
        'InvalidSignature',
      )
      await mined(as(stranger)[CLOSE_TO](id, 2, final, payoutA.address, payoutB.address, ...sigs))

      expect((await balance(payoutA)) - aBefore).toBe(final[0])
      expect((await balance(payoutB)) - bBefore).toBe(final[1])
    })

    it('needs both signatures over exactly this state, and balances that add up', async () => {
      const id = await openFunded()
      const final: Balances = [ethers.parseEther('20'), 0n]
      const good = [await signClose(alice, id, 1, final), await signClose(bob, id, 1, final)]
      const close = as(stranger)[CLOSE]

      await expectRevert(
        close(id, 1, final, good[0], await signClose(stranger, id, 1, final)),
        'InvalidSignature',
      )
      await expectRevert(close(id, 1, final, good[1], good[0]), 'InvalidSignature')
      await expectRevert(close(id, 2, final, good[0], good[1]), 'InvalidSignature')
      // A checkpoint signature is not a close signature.
      await expectRevert(
        close(
          id,
          1,
          final,
          await signCheckpoint(alice, id, 1, final),
          await signCheckpoint(bob, id, 1, final),
        ),
        'InvalidSignature',
      )
      const tooMuch: Balances = [ethers.parseEther('20'), 1n]
      await expectRevert(
        close(id, 1, tooMuch, await signClose(alice, id, 1, tooMuch), await signClose(bob, id, 1, tooMuch)),
        'InvalidBalanceSum',
      )
      expect((await channel.channels(id)).settled).toBe(false)
    })

    it('closes once', async () => {
      const id = await openFunded()
      const final: Balances = [TEN, TEN]
      const sigs = [await signClose(alice, id, 1, final), await signClose(bob, id, 1, final)]
      await mined(as(stranger)[CLOSE](id, 1, final, ...sigs))
      const held = await balance(channelAddress)
      await expectRevert(as(stranger)[CLOSE](id, 1, final, ...sigs), 'ChannelAlreadySettled')
      await expectRevert(as(alice).startChallenge(id), 'ChannelAlreadySettled')
      expect(await balance(channelAddress)).toBe(held)
    })

    it('does not accept a close signed for another channel', async () => {
      const first = await openFunded()
      const second = await openFunded()
      const final: Balances = [ethers.parseEther('20'), 0n]
      await expectRevert(
        as(stranger)[CLOSE](
          second,
          1,
          final,
          await signClose(alice, first, 1, final),
          await signClose(bob, first, 1, final),
        ),
        'InvalidSignature',
      )
    })
  })

  describe('dispute', () => {
    it('pays the checkpointed balances only after the challenge window', async () => {
      const id = await openFunded()
      const state: Balances = [ethers.parseEther('12'), ethers.parseEther('8')]
      await mined(checkpoint(alice, id, 3, state))
      expect((await channel.channels(id)).currentSeq).toBe(3n)

      await expectRevert(as(alice).closeAfterChallenge(id), 'ChallengeNotExpired')
      await anvil.advanceTime(CHALLENGE - 60)
      await expectRevert(as(alice).closeAfterChallenge(id), 'ChallengeNotExpired')
      await anvil.advanceTime(120)

      const aliceBefore = await balance(alice)
      const bobBefore = await balance(bob)
      await mined(as(stranger).closeAfterChallenge(id))
      expect((await balance(alice)) - aliceBefore).toBe(state[0])
      expect((await balance(bob)) - bobBefore).toBe(state[1])
      await expectRevert(as(stranger).closeAfterChallenge(id), 'ChannelAlreadySettled')
    })

    it('lets the other party answer an old state with a newer one, which restarts the window', async () => {
      const id = await openFunded()
      const old: Balances = [ethers.parseEther('15'), ethers.parseEther('5')]
      const latest: Balances = [ethers.parseEther('4'), ethers.parseEther('16')]

      // Alice posts a state from when she was ahead.
      await mined(checkpoint(alice, id, 2, old))
      await anvil.advanceTime(CHALLENGE - 60)
      // Bob answers inside the window with the latest state.
      await mined(checkpoint(bob, id, 9, latest))
      await anvil.advanceTime(120)
      await expectRevert(as(alice).closeAfterChallenge(id), 'ChallengeNotExpired')
      // The old state can no longer be posted.
      await expectRevert(checkpoint(alice, id, 2, old), 'StaleSequence')
      await expectRevert(checkpoint(alice, id, 9, latest), 'StaleSequence')

      await anvil.advanceTime(CHALLENGE)
      const aliceBefore = await balance(alice)
      const bobBefore = await balance(bob)
      await mined(as(stranger).closeAfterChallenge(id))
      expect((await balance(alice)) - aliceBefore).toBe(latest[0])
      expect((await balance(bob)) - bobBefore).toBe(latest[1])
    })

    it('refuses a checkpoint that is not signed by both or does not add up', async () => {
      const id = await openFunded()
      const state: Balances = [ethers.parseEther('19'), ethers.parseEther('1')]
      const mine = await signCheckpoint(alice, id, 1, state)
      await expectRevert(as(alice).checkpoint(id, 1, state, mine, mine), 'InvalidSignature')
      await expectRevert(
        as(alice).checkpoint(id, 1, state, mine, await signCheckpoint(stranger, id, 1, state)),
        'InvalidSignature',
      )
      await expectRevert(checkpoint(alice, id, 1, [ethers.parseEther('19'), ethers.parseEther('2')]), 'InvalidBalanceSum')
      expect((await channel.channels(id)).challengeExpiresAt).toBe(0n)
    })

    it('does not let a deposit after the join invalidate the newer state the other party holds', async () => {
      // Bob lost 8 of his 10. He posts the opening state, then tries to change the channel
      // total by one wei so that Alice's newer state no longer adds up.
      const id = await openFunded()
      const opening: Balances = [TEN, TEN]
      const latest: Balances = [ethers.parseEther('18'), ethers.parseEther('2')]

      await mined(checkpoint(bob, id, 1, opening))
      await expectRevert(as(bob)[JOIN_NATIVE](id, { value: 1 }), 'AlreadyJoined')
      await mined(checkpoint(alice, id, 7, latest))

      await anvil.advanceTime(CHALLENGE + 1)
      const aliceBefore = await balance(alice)
      await mined(as(stranger).closeAfterChallenge(id))
      expect((await balance(alice)) - aliceBefore).toBe(latest[0])
    })

    it('can still close cooperatively during a challenge', async () => {
      const id = await openFunded()
      await mined(checkpoint(alice, id, 4, [TEN, TEN]))
      const final: Balances = [ethers.parseEther('1'), ethers.parseEther('19')]
      await expectRevert(
        as(stranger)[CLOSE](id, 3, final, await signClose(alice, id, 3, final), await signClose(bob, id, 3, final)),
        'StaleSequence',
      )
      const bobBefore = await balance(bob)
      await mined(
        as(stranger)[CLOSE](id, 4, final, await signClose(alice, id, 4, final), await signClose(bob, id, 4, final)),
      )
      expect((await balance(bob)) - bobBefore).toBe(final[1])
    })
  })

  describe('challenge without a checkpoint', () => {
    it('returns the opener\'s deposit after the window when the peer never joins', async () => {
      const id = ethers.id(`channel-${counter++}`)
      await mined(as(alice)[OPEN_NATIVE](id, bob.address, CHALLENGE, { value: TEN }))
      await expectRevert(as(alice).closeAfterChallenge(id), 'ChallengeNotActive')
      await expectRevert(as(stranger).startChallenge(id), 'Unauthorized')

      await mined(as(alice).startChallenge(id))
      await expectRevert(as(alice).startChallenge(id), 'ChallengeAlreadyActive')
      // The peer cannot join a channel that is being closed.
      await expectRevert(as(bob)[JOIN_NATIVE](id, { value: TEN }), 'AlreadyJoined')
      await expectRevert(as(alice).closeAfterChallenge(id), 'ChallengeNotExpired')

      await anvil.advanceTime(CHALLENGE + 1)
      const stillHeld = await balance(channelAddress)
      const strangerSends = as(stranger).closeAfterChallenge(id)
      const aliceBefore = await balance(alice)
      await mined(strangerSends)
      expect((await balance(alice)) - aliceBefore).toBe(TEN)
      expect(stillHeld - (await balance(channelAddress))).toBe(TEN)
    })

    it('returns both deposits when the peer stops signing', async () => {
      const id = await openFunded()
      await mined(as(bob).startChallenge(id))
      await anvil.advanceTime(CHALLENGE + 1)
      const aliceBefore = await balance(alice)
      const bobBefore = await balance(bob)
      await mined(as(stranger).closeAfterChallenge(id))
      expect((await balance(alice)) - aliceBefore).toBe(TEN)
      expect((await balance(bob)) - bobBefore).toBe(TEN)
    })

    it('is answered by a co-signed state, so it cannot undo payments already signed', async () => {
      // Alice paid Bob off-chain, then tries to leave with her opening deposit.
      const id = await openFunded()
      const latest: Balances = [ethers.parseEther('2'), ethers.parseEther('18')]
      await mined(as(alice).startChallenge(id))
      await mined(checkpoint(bob, id, 6, latest))
      await anvil.advanceTime(CHALLENGE + 1)
      const bobBefore = await balance(bob)
      await mined(as(stranger).closeAfterChallenge(id))
      expect((await balance(bob)) - bobBefore).toBe(latest[1])
    })
  })
})
