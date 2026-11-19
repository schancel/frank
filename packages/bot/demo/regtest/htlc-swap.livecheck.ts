/**
 * The HTLC swap runner (`@frank/swap-protocol/src/htlc-swap-runner`) between two accounts on
 * real nodes: a Bitcoin ABC xec-regtest node with Chronik, and anvil as `monad-regtest` running
 * GenericHTLC v2 deployed from its compiled artifact. Every device is a process of its own
 * (htlc-swap.device.ts): a real `EcashWallet` and a real EVM wallet handle (native journal,
 * Level stores) composed with the wallet's swap capabilities
 * (packages/wallet/swap/htlc-swap-capabilities.ts), its own negotiation journal and its own swap
 * record store. The negotiation is signed by the accounts' identity keys and admitted into each
 * device's `NegotiationJournal`; nothing passes between the parties after the accept but the
 * chains.
 *
 *   yarn --cwd packages/bot regtest:htlc-swap
 *
 * Needs a Chronik-enabled `bitcoind` (FRANK_BITCOIN_ABC_BIN_DIR or `yarn --cwd packages/bot
 * regtest:fetch`) and an `anvil` (ANVIL_BIN, the `@foundry-rs/anvil` package, or PATH). The Jest
 * wrapper `htlc-swap.regtest.jest.test.ts` runs this and reports NOT RUN without them.
 *
 * Regtest-proof policy (margins in seconds). Time moves with setmocktime (eCash MTP) and
 * evm_setNextBlockTimestamp (EVM), and the runners' clock with them. Only the EVM RPC URL is
 * redirected (anvil-rpc-redirect.ts), as in the wallet's anvil suites. No relay is involved.
 *
 * Scenarios, each a fresh swap:
 *   1. happy path with both wallets reopened and a fresh runner before every tick, and a stop
 *      after A's authorization is written and after B's claim is written: one funding, one lock,
 *      one withdraw, one claim;
 *   2. B never locks: B abandons at its cutoff, A refunds after MTP > T_A;
 *   3. A never claims: B refunds MON after T_B, A refunds XEC after T_A;
 *   4. B offline past T_A: honest A never refunds after its withdraw; a refund by A's own keys
 *      outside the runner leaves B `lostToRefund`;
 *   5. two devices of A's account: only the active one funds; the other, with no record of the
 *      swap, takes over and withdraws from the journal and the chains alone;
 *   6. a second exact funding output at the script, B online: B claims exactly one, A
 *      refunds the extra after T_A;
 *   7. a second exact funding output, B offline past T_A: A (withdrawn) refunds one and leaves
 *      the other for B, which B claims when it is back.
 */
import assert from 'assert/strict'
import { fork, spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { sha256 } from '@noble/hashes/sha256'
import { ChronikClient } from 'chronik-client'
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers'
import GenericHTLCArtifact from '@frank/contracts/artifacts/GenericHTLC.json'
import { xecHtlcAddress, xecHtlcFundingValue, xecHtlcOutputScript, type XecHtlcTerms } from '@frank/wallet/ecash-htlc'
import { evmHtlcInterface, htlcLockId, readHtlcLock } from '@frank/wallet/swap-escrow'
import {
  REGTEST_PROOF_NEGOTIATION_POLICY as POLICY,
  buildNegotiationOffer,
  buildNegotiationResponse,
  defaultNegotiationDeadlines,
  offerSwapIdTranscript,
  type NegotiationContext,
  type OfferFields,
} from '@frank/swap-protocol/src/negotiation'
import { encodeSignedSwapEvent } from '@frank/swap-protocol/src/index'
import { htlcLockIdOf } from '@frank/swap-protocol/src/htlc-swap'
import type { HtlcSwapView } from '@frank/swap-protocol/src/htlc-swap-runner'

import type { DeviceConfig, DeviceInfo } from './htlc-swap.device'
import { startEcashRegtest, type EcashRegtest } from './ecash-regtest'
import { freePort, sleep } from './regtest-chain'
import { findAnvil } from '@frank/wallet/node-binaries.testutil'

const EVM_CHAIN_ID = 20143
/** monad-regtest's registry minimum gas price (docs/protocol/chains/v1.json). */
const GAS_PRICE = 100n * 10n ** 9n
/** anvil's first well-known development key: holds the node's test ether. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** Default ABC regtest activates BIP65 (CHECKLOCKTIMEVERIFY) at this height. */
const CLTV_HEIGHT = 1351
const XEC_PRINCIPAL = 20_000n
const EVM_PRINCIPAL = 10n ** 16n
const ETHER = 10n ** 18n

const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const fromHex = (value: string) => new Uint8Array(Buffer.from(value.replace(/^0x/, ''), 'hex'))

interface Device extends DeviceInfo {
  readonly name: string
  call<T>(op: string, args?: Record<string, unknown>): Promise<T>
  readonly child: ChildProcess
}
function openDevice(config: DeviceConfig): Promise<Device> {
  const child = fork(join(__dirname, 'htlc-swap.device.ts'), [JSON.stringify(config)], {
    execArgv: ['--import', 'tsx'],
    serialization: 'advanced',
  })
  let next = 0
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  return new Promise((resolve, reject) => {
    child.once('exit', code => {
      reject(new Error(`device ${config.name} exited (${code})`))
      for (const call of waiting.values()) call.reject(new Error(`device ${config.name} exited (${code})`))
    })
    child.on('message', (message: { ready?: DeviceInfo; id?: number; ok?: boolean; result?: unknown; error?: string }) => {
      if (message.ready)
        return resolve({
          ...message.ready,
          name: config.name,
          child,
          call: <T>(op: string, args: Record<string, unknown> = {}) =>
            new Promise<T>((resolveCall, rejectCall) => {
              const id = next++
              waiting.set(id, { resolve: resolveCall as (value: unknown) => void, reject: rejectCall })
              child.send({ ...args, op, id })
            }),
        })
      const call = waiting.get(message.id!)
      waiting.delete(message.id!)
      if (message.ok) call?.resolve(message.result)
      else call?.reject(new Error(`${config.name}: ${message.error}`))
    })
  })
}

interface Party {
  readonly devices: Device[]
  active: Device
}

export async function htlcSwapCheck(xec: EcashRegtest, anvilBin: string): Promise<string[]> {
  const steps: string[] = []
  const step = (line: string) => {
    steps.push(line)
    console.log(`ok - ${line}`)
  }
  const chronik = new ChronikClient([xec.chronikUrl])
  const directory = mkdtempSync(join(tmpdir(), 'frank-htlc-swap-'))
  const port = await freePort()
  const anvilUrl = `http://127.0.0.1:${port}`
  const node: ChildProcess = spawn(
    anvilBin,
    ['--port', String(port), '--chain-id', String(EVM_CHAIN_ID), '--base-fee', '0', '--gas-price', String(GAS_PRICE), '--silent'],
    { stdio: 'ignore' },
  )
  const chain = new JsonRpcProvider(anvilUrl, EVM_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  const devices: Device[] = []
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (attempt > 100) throw error
        await sleep(100)
      }
    }
    const dev = new Wallet(DEV_KEY, chain)
    const deployed = await new ContractFactory(GenericHTLCArtifact.abi, GenericHTLCArtifact.bytecode, dev).deploy()
    await deployed.waitForDeployment()
    const htlc = (await deployed.getAddress()).toLowerCase()
    step(`GenericHTLC v2 deployed on anvil (monad-regtest) at ${htlc}`)

    const tip = async () =>
      xec.rpc<{ height: number; mediantime: number; time: number }>('getblockheader', [await xec.rpc<string>('getbestblockhash')])
    const height = (await tip()).height
    if (height <= CLTV_HEIGHT) await xec.mine(CLTV_HEIGHT + 1 - height)

    // ---- clocks ---------------------------------------------------------------------------
    let now = Math.max((await chain.getBlock('latest'))!.timestamp, (await tip()).time) + 5
    /** Moves every clock to `t`: the runners', the EVM chain's next block, and eCash MTP. */
    const advanceTo = async (t: number, options: { xecMtp?: boolean } = {}) => {
      if (t > now) now = t
      if (t > (await chain.getBlock('latest'))!.timestamp) {
        await chain.send('evm_setNextBlockTimestamp', [t])
        await chain.send('evm_mine', [])
      }
      await xec.rpc('setmocktime', [t])
      if (options.xecMtp)
        for (let i = 0; (await tip()).mediantime < t; i++) {
          assert.ok(i < 20, 'MTP did not reach the target')
          await xec.mine(1)
        }
    }
    const evmMine = () => chain.send('evm_mine', [])

    // ---- accounts: every device a process of its own --------------------------------------
    const open = async (name: string, account: string, vector: number) => {
      const device = await openDevice({
        name,
        account,
        vector,
        storageDir: join(directory, name),
        htlc,
        anvilUrl,
        chronikUrl: xec.chronikUrl,
        checkpoint: xec.checkpoint,
      })
      devices.push(device)
      return device
    }
    const aliceDevices = [await open('alice-1', 'alice', 0), await open('alice-2', 'alice', 0)]
    const alice: Party = { devices: aliceDevices, active: aliceDevices[0]! }
    const bobDevice = await open('bob-1', 'bob', 1)
    const bob: Party = { devices: [bobDevice], active: bobDevice }
    const [one, two] = aliceDevices as [Device, Device]
    assert.equal(two.mainAccount, one.mainAccount)
    assert.equal(hex(two.publicKey), hex(one.publicKey))
    const aliceMain = one.mainAccount
    const bobMain = bobDevice.mainAccount
    for (const main of [aliceMain, bobMain]) await (await dev.sendTransaction({ to: main, value: 10n * ETHER })).wait()
    await xec.fund(one.xecAddress, 2_000_000n)
    step(`alice and bob funded: XEC at ${one.xecAddress}, MON at ${aliceMain} / ${bobMain}`)

    // ---- negotiation ----------------------------------------------------------------------
    let messages = 0
    const deliver = async (context: NegotiationContext, bytes: Uint8Array, from: Party, to: Party) => {
      messages++
      const messageId = new Uint8Array(randomBytes(16))
      const digest = sha256(Uint8Array.of(messages, ...messageId))
      for (const device of [...from.devices, ...to.devices])
        await device.call('admit', {
          context,
          bytes,
          sender: from.active.publicKey,
          recipient: to.active.publicKey,
          messageId,
          digest,
        })
    }
    /** A signs an offer (its own derived swapId, hash lock and refund key), B accepts. */
    const negotiate = async () => {
      const conversationId = new Uint8Array(randomBytes(16))
      const parties = [one.publicKey, bobDevice.publicKey] as const
      const deadlines = defaultNegotiationDeadlines(POLICY, BigInt(now))
      assert.ok(deadlines.ok)
      const facts = {
        xecPrincipal: XEC_PRINCIPAL,
        evmPrincipal: EVM_PRINCIPAL,
        ...deadlines.value,
        evmRecipient: fromHex(aliceMain),
        evmHtlcContract: fromHex(htlc),
      }
      const transcript = offerSwapIdTranscript({ policy: POLICY, conversationId, parties, ...facts })
      assert.ok(transcript.ok)
      const swapId = await alice.active.call<Uint8Array>('offerSwapId', { transcript: transcript.value })
      const swapIdHex = hex(swapId)
      const fields: OfferFields = {
        ...facts,
        hashLock: await alice.active.call<Uint8Array>('hashLock', { policyName: POLICY.name, swapId }),
        xecRefundPublicKey: await alice.active.call<Uint8Array>('htlcKey', { swapId: swapIdHex, role: 'refund' }),
      }
      const context: NegotiationContext = { swapId, conversationId, parties, policy: POLICY }
      const signer = (device: Device) => (digest: Uint8Array) => device.call<Uint8Array>('sign', { digest })
      const offer = await buildNegotiationOffer(context, fields, signer(alice.active))
      assert.ok(offer.ok, JSON.stringify(!offer.ok && offer.error))
      const offerBytes = encodeSignedSwapEvent(offer.value)
      assert.ok(offerBytes.ok)
      await deliver(context, offerBytes.value, alice, bob)
      const claimPublicKey = await bobDevice.call<Uint8Array>('htlcKey', { swapId: swapIdHex, role: 'claim' })
      const accept = await buildNegotiationResponse(
        context,
        offerBytes.value,
        { kind: 'accept', fields: { xecClaimPublicKey: claimPublicKey, evmSender: fromHex(bobMain) } },
        signer(bobDevice),
      )
      assert.ok(accept.ok, JSON.stringify(!accept.ok && accept.error))
      const acceptBytes = encodeSignedSwapEvent(accept.value)
      assert.ok(acceptBytes.ok)
      await deliver(context, acceptBytes.value, bob, alice)
      const evmTerms = {
        recipient: aliceMain,
        refundAddress: bobMain,
        amount: EVM_PRINCIPAL,
        hashLock: '0x' + hex(fields.hashLock),
        expiresAt: Number(fields.evmExpiry),
      }
      const lockId = htlcLockIdOf(bobMain, evmTerms)
      // The runner's lock id and the wallet's agree.
      assert.equal(
        lockId,
        htlcLockId(bobMain, { ...evmTerms, token: '0x' + '00'.repeat(20), expiresAt: fields.evmExpiry }).toLowerCase(),
      )
      const xecTerms: XecHtlcTerms = {
        hashLock: fields.hashLock,
        claimPublicKey,
        refundPublicKey: fields.xecRefundPublicKey,
        refundTime: Number(fields.xecRefundTime),
      }
      return { swapId: swapIdHex, T_B: Number(fields.evmExpiry), T_A: Number(fields.xecRefundTime), lockId, xecTerms }
    }
    type Swap = Awaited<ReturnType<typeof negotiate>>

    // ---- helpers --------------------------------------------------------------------------
    /** One tick of a fresh runner on `device` (`reopen`: its wallets are closed and reopened
     * first, as a restarted process would). */
    const tick = (
      p: Party,
      s: Swap,
      device: Device = p.active,
      options: { reopen?: boolean; failNext?: 'xec-fund' | 'xec-broadcast' } = {},
    ) => device.call<HtlcSwapView>('tick', { swapId: s.swapId, now, active: p.active === device, ...options })
    const show = (view: HtlcSwapView) => JSON.stringify(view, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    const expectPhase = (view: HtlcSwapView, phase: string, action: string) => {
      assert.equal(view.error, undefined, show(view))
      assert.equal(view.phase, phase, show(view))
      assert.equal(view.lastAction ?? 'none', action, show(view))
    }
    const scriptOutputs = async (s: Swap) => {
      const script = hex(xecHtlcOutputScript(s.xecTerms))
      const history = await chronik.script('p2sh', script.slice(4, 44)).history(0, 200)
      return history.txs.flatMap(tx =>
        tx.outputs.map((o, vout) => ({ txid: tx.txid, vout, ...o })).filter(o => o.outputScript === script),
      )
    }
    const evmEvents = async (name: 'Locked' | 'Withdrawn' | 'Refunded', lockId: string) =>
      (
        await chain.getLogs({
          address: htlc,
          topics: [evmHtlcInterface.getEvent(name)!.topicHash, lockId],
          fromBlock: 0,
          toBlock: 'latest',
        })
      ).length
    const xecBalanceOf = async (address: string) =>
      (await chronik.address(address).utxos()).utxos.reduce((sum, u) => sum + u.sats, 0n)

    // ======================= 1. happy path, a restart before every tick =======================
    {
      const s = await negotiate()
      const bobXecBefore = await xecBalanceOf(bobDevice.xecPrimary)
      const aliceMonBefore = await chain.getBalance(aliceMain)
      // Offer and accept are in A's journal: A funds with no further action. The first attempt
      // stops after the authorization is durable and before the wallet funds anything.
      const a = await tick(alice, s, one, { failNext: 'xec-fund' })
      assert.match(a.error ?? '', /stopped before funding/)
      const authorized = JSON.parse((await one.call<string>('record', { swapId: s.swapId }))!)
      assert.equal(authorized.fundingAuthorizedAt, now)
      assert.equal(authorized.xecLockOperationId, `swap:${s.swapId}:xec-lock`)
      assert.equal((await scriptOutputs(s)).length, 0)
      expectPhase(await tick(alice, s, one, { reopen: true }), 'xecLockPending', 'fund-xec')
      expectPhase(await tick(alice, s, one, { reopen: true }), 'xecLockPending', 'none')
      assert.equal((await scriptOutputs(s)).length, 1)
      step('A funds the XEC HTLC automatically once the accept arrives; a stop after the authorization resumes the same operation')
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'awaitXecLock', 'none')
      await xec.mine(1)
      expectPhase(await tick(alice, s, one, { reopen: true }), 'xecLocked', 'none')
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'locking', 'lock-evm')
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'evmLocked', 'none')
      assert.equal(await evmEvents('Locked', s.lockId), 1)
      step('B locks MON once the XEC output is final; a restart does not lock again')
      // B's lock is not final yet (final depth 1): A waits.
      expectPhase(await tick(alice, s, one, { reopen: true }), 'xecLocked', 'none')
      await evmMine()
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claiming', 'withdraw-evm')
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'none')
      assert.equal(await evmEvents('Withdrawn', s.lockId), 1)
      assert.ok((await chain.getBalance(aliceMain)) > aliceMonBefore)
      step('A withdraws MON with its derived preimage once B’s lock is final, once')
      const b = await tick(bob, s, bobDevice, { reopen: true, failNext: 'xec-broadcast' })
      assert.match(b.error ?? '', /stopped before broadcasting/)
      const claims = JSON.parse((await bobDevice.call<string>('record', { swapId: s.swapId }))!).xecSpends
      assert.equal(claims.length, 1)
      const [claim] = claims
      assert.equal(claim.branch, 'claim')
      assert.equal((await scriptOutputs(s))[0]!.spentBy, undefined)
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'claimingXec', 'broadcast-xec-spend')
      await xec.mine(1)
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'complete', 'none')
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'none')
      const outputs = await scriptOutputs(s)
      assert.equal(outputs.length, 1)
      assert.equal(outputs[0]!.spentBy?.txid, claim.txid)
      assert.equal((await xecBalanceOf(bobDevice.xecPrimary)) - bobXecBefore, XEC_PRINCIPAL)
      step(
        `B claims exactly ${XEC_PRINCIPAL} sats with the preimage read from the EVM lock; the claim written before a stop is re-broadcast as the same txid ${claim.txid}`,
      )
      step('happy path: one funding, one lock, one withdraw, one claim, across a restart before every tick')
    }

    // ======================= 2. B never locks: A refunds =======================
    {
      const s = await negotiate()
      expectPhase(await tick(alice, s), 'accepted', 'fund-xec')
      await xec.mine(1)
      expectPhase(await tick(alice, s), 'xecLocked', 'none')
      await advanceTo(s.T_B + 1)
      expectPhase(await tick(alice, s), 'awaitRefund', 'none')
      expectPhase(await tick(bob, s), 'abandoned', 'none')
      await advanceTo(s.T_A, { xecMtp: true })
      // MTP = T_A is not enough.
      expectPhase(await tick(alice, s), 'awaitRefund', 'none')
      const before = await xecBalanceOf(one.xecPrimary)
      await advanceTo(s.T_A + 1, { xecMtp: true })
      expectPhase(await tick(alice, s, one, { reopen: true }), 'refunding', 'sign-xec-spend')
      await xec.mine(1)
      expectPhase(await tick(alice, s, one, { reopen: true }), 'refunded', 'none')
      assert.equal((await xecBalanceOf(one.xecPrimary)) - before, XEC_PRINCIPAL)
      assert.equal(await evmEvents('Locked', s.lockId), 0)
      step('B never locks: B abandons at its cutoff, A refunds exactly the principal once MTP > T_A')
    }

    // ======================= 3. A never claims: both refund =======================
    {
      const s = await negotiate()
      expectPhase(await tick(alice, s), 'accepted', 'fund-xec')
      await xec.mine(1)
      expectPhase(await tick(bob, s), 'locking', 'lock-evm')
      await evmMine()
      // A is away until after its withdraw cutoff.
      await advanceTo(s.T_B - 4)
      expectPhase(await tick(alice, s), 'awaitRefund', 'none')
      expectPhase(await tick(bob, s), 'evmLocked', 'none')
      await advanceTo(s.T_B)
      expectPhase(await tick(bob, s), 'refunding', 'refund-evm')
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'refunded', 'none')
      assert.equal(await evmEvents('Refunded', s.lockId), 1)
      assert.equal((await readHtlcLock(chain, htlc, s.lockId))?.state, 'refunded')
      await advanceTo(s.T_A + 1, { xecMtp: true })
      expectPhase(await tick(alice, s), 'refunding', 'sign-xec-spend')
      await xec.mine(1)
      expectPhase(await tick(alice, s), 'refunded', 'none')
      assert.equal(await evmEvents('Withdrawn', s.lockId), 0)
      step('A never claims: B refunds MON once block.timestamp ≥ T_B, A refunds XEC once MTP > T_A')
    }

    // ======================= 4. B offline past T_A: lostToRefund =======================
    {
      const s = await negotiate()
      expectPhase(await tick(alice, s), 'accepted', 'fund-xec')
      await xec.mine(1)
      expectPhase(await tick(bob, s), 'locking', 'lock-evm')
      await evmMine()
      expectPhase(await tick(alice, s), 'claiming', 'withdraw-evm')
      expectPhase(await tick(alice, s), 'claimed', 'none')
      // B goes offline; T_A passes. Honest A never refunds after its withdraw landed.
      await advanceTo(s.T_A + 1, { xecMtp: true })
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'none')
      const [funding] = await scriptOutputs(s)
      assert.ok(funding && funding.spentBy === undefined)
      step('B offline past T_A: A’s runner never refunds after its MON withdraw landed')
      await one.call('refundOutsideRunner', {
        swapId: s.swapId,
        terms: s.xecTerms,
        funding: { txid: funding.txid, vout: funding.vout },
        principalSats: XEC_PRINCIPAL,
      })
      await xec.mine(1)
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'lostToRefund', 'none')
      step('B back online after A refunded first (outside the runner): lostToRefund')
    }

    // ======================= 5. two devices of A's account =======================
    {
      const s = await negotiate()
      alice.active = one
      expectPhase(await tick(alice, s, one), 'accepted', 'fund-xec')
      expectPhase(await tick(alice, s, two), 'xecLockPending', 'none')
      await xec.mine(1)
      expectPhase(await tick(alice, s, two), 'xecLocked', 'none')
      expectPhase(await tick(alice, s, one), 'xecLocked', 'none')
      assert.equal((await scriptOutputs(s)).length, 1)
      assert.equal(await two.call('record', { swapId: s.swapId }), undefined)
      step('two devices of A: only the active device funds; the other observes the same lock')
      expectPhase(await tick(bob, s), 'locking', 'lock-evm')
      await evmMine()
      // The user moves to device two, which holds no record of the swap: it continues from its
      // journal and the chains, with the same derived preimage.
      alice.active = two
      expectPhase(await tick(alice, s, one), 'claiming', 'none')
      expectPhase(await tick(alice, s, two), 'claiming', 'withdraw-evm')
      expectPhase(await tick(alice, s, one), 'claimed', 'none')
      expectPhase(await tick(alice, s, two), 'claimed', 'none')
      assert.equal(await evmEvents('Withdrawn', s.lockId), 1)
      expectPhase(await tick(bob, s), 'claimingXec', 'sign-xec-spend')
      await xec.mine(1)
      expectPhase(await tick(bob, s), 'complete', 'none')
      step('two devices of A: the device taking over withdraws from the chain state alone, once')
    }
    // A second exact-value output at the swap's script (paid by the node's wallet, as a mistaken
    // second funding would be): every exact output is a separate fund.
    const fundAgain = async (s: Swap) => {
      await xec.fund(xecHtlcAddress('xec-regtest', s.xecTerms), xecHtlcFundingValue(XEC_PRINCIPAL))
      // Chronik indexes the node's block a moment later.
      for (let i = 0; (await scriptOutputs(s)).length < 2; i++) {
        assert.ok(i < 100, 'the second funding output did not show in Chronik')
        await sleep(100)
      }
    }

    alice.active = one
    // ============ 6. double funding, B online: B claims one, A refunds the extra ============
    {
      const s = await negotiate()
      expectPhase(await tick(alice, s), 'accepted', 'fund-xec')
      await fundAgain(s)
      expectPhase(await tick(bob, s), 'locking', 'lock-evm')
      await evmMine()
      expectPhase(await tick(alice, s), 'claiming', 'withdraw-evm')
      expectPhase(await tick(alice, s), 'claimed', 'none')
      const bobBefore = await xecBalanceOf(bobDevice.xecPrimary)
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'claimingXec', 'sign-xec-spend')
      // B is owed one principal: its claim in the mempool, it claims nothing more.
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'claimingXec', 'none')
      await xec.mine(1)
      expectPhase(await tick(bob, s), 'complete', 'none')
      const record = JSON.parse((await bobDevice.call<string>('record', { swapId: s.swapId }))!)
      assert.equal(record.xecSpends.length, 1)
      assert.equal((await xecBalanceOf(bobDevice.xecPrimary)) - bobBefore, XEC_PRINCIPAL)
      assert.equal((await scriptOutputs(s)).filter(o => o.spentBy === undefined).length, 1)
      step('a double-funded script: B claims exactly one output')
      // Before T_A the extra output stays; after it, A refunds it (B's claim is final).
      expectPhase(await tick(alice, s), 'claimed', 'none')
      await advanceTo(s.T_A + 1, { xecMtp: true })
      const aliceBefore = await xecBalanceOf(one.xecPrimary)
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'sign-xec-spend')
      await xec.mine(1)
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'none')
      expectPhase(await tick(bob, s), 'complete', 'none')
      assert.equal((await scriptOutputs(s)).filter(o => o.spentBy === undefined).length, 0)
      assert.equal((await xecBalanceOf(one.xecPrimary)) - aliceBefore, XEC_PRINCIPAL)
      step('the extra output: A refunds it after T_A')
    }

    // ============ 7. double funding, B offline past T_A: A refunds only the extra ============
    {
      const s = await negotiate()
      expectPhase(await tick(alice, s), 'accepted', 'fund-xec')
      await fundAgain(s)
      expectPhase(await tick(bob, s), 'locking', 'lock-evm')
      await evmMine()
      expectPhase(await tick(alice, s), 'claiming', 'withdraw-evm')
      expectPhase(await tick(alice, s), 'claimed', 'none')
      await advanceTo(s.T_A + 1, { xecMtp: true })
      const aliceBefore = await xecBalanceOf(one.xecPrimary)
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'sign-xec-spend')
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'none')
      await xec.mine(1)
      expectPhase(await tick(alice, s, one, { reopen: true }), 'claimed', 'none')
      const outputs = await scriptOutputs(s)
      assert.equal(outputs.filter(o => o.spentBy === undefined).length, 1)
      assert.equal((await xecBalanceOf(one.xecPrimary)) - aliceBefore, XEC_PRINCIPAL)
      step('a double-funded script, B offline past T_A: withdrawn A refunds only the extra output')
      const bobBefore = await xecBalanceOf(bobDevice.xecPrimary)
      expectPhase(await tick(bob, s, bobDevice, { reopen: true }), 'claimingXec', 'sign-xec-spend')
      await xec.mine(1)
      expectPhase(await tick(bob, s), 'complete', 'none')
      expectPhase(await tick(alice, s), 'claimed', 'none')
      assert.equal((await xecBalanceOf(bobDevice.xecPrimary)) - bobBefore, XEC_PRINCIPAL)
      step('B back online: claims the output A left for it')
    }
    await xec.rpc('setmocktime', [0])
    return steps
  } finally {
    for (const device of devices) await device.call('close').catch(() => undefined)
    for (const device of devices) device.child.kill()
    chain.destroy()
    node.kill()
    rmSync(directory, { recursive: true, force: true })
  }
}

async function main() {
  const anvil = findAnvil()
  if (!anvil) throw new Error('htlc-swap needs an anvil binary (ANVIL_BIN)')
  const stateDir = mkdtempSync(join(tmpdir(), 'frank-htlc-swap-xec-'))
  // Blocks only when the check asks: MTP must follow setmocktime, not a timer.
  const xec = await startEcashRegtest({ stateDir, blockIntervalMs: 24 * 3600_000 })
  try {
    const steps = await htlcSwapCheck(xec, anvil)
    console.log(`HTLC swap runner regtest: OK (${steps.length} checks)`)
  } finally {
    await xec.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
