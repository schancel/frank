/** Ordinary two-custody clock evidence only; never threshold/adaptor or atomic-swap assurance. */
import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  AbiCoder,
  Contract,
  ContractFactory,
  FetchRequest,
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getBytes,
  hashMessage,
  id,
  keccak256,
  type TransactionReceipt,
} from 'ethers'
import artifact from '../../../contracts/artifacts/StateChannel.json'
import {
  earliestEvmRefund,
  validateStateChannelPairTerms,
  type StateChannelPairTerms,
} from '../../../swap-protocol/src/state-channel-pair'
import { Supervisor } from '../supervisor'
import { freePort, isListening, sleep } from './regtest-chain'
import {
  startOwnedTemplateFixture,
  type ReadyTemplateFixture,
} from './owned-template-fixture'
import { ordinaryCltv as c } from './cltv-consensus-fixture'

const M = 10000000000000000n
const X = 10000n,
  X_FEE = 1000n
const GAS_LIMIT = 300000n,
  MAX_PRICE = 2000000000n
const TOTAL_GAS_BUDGET = 100000000000000000n
const ENVELOPE = {
  mtpLagSeconds: 6,
  observationSeconds: 4,
  refundInclusionSeconds: 8,
  finalitySeconds: 12,
  xecConfirmationDepth: 2,
  evmResponseSeconds: 10,
  crossClockSeconds: 5,
  xecFeeSats: Number(X_FEE),
  maxXecFeeSats: 2000,
  deploymentGasLimit: '3000000',
  gasLimit: GAS_LIMIT.toString(),
  maxFeePerGas: MAX_PRICE.toString(),
  aggregateGasBudgetWei: TOTAL_GAS_BUDGET.toString(),
}
const X_BOUND_DELAY =
  ENVELOPE.mtpLagSeconds +
  ENVELOPE.observationSeconds +
  ENVELOPE.refundInclusionSeconds +
  ENVELOPE.finalitySeconds
interface Header {
  hash: string
  height: number
  time: number
  mediantime: number
  previousblockhash?: string
  confirmations: number
}
interface Output {
  n: number
  value: number
  scriptPubKey: { hex: string }
  confirmations?: number
}
interface Block {
  hash: string
  height: number
  tx: Array<{ txid: string; hex: string; vout: Output[] }>
}
export interface OwnedEvm {
  provider: JsonRpcProvider
  accounts: HDNodeWallet[]
  version: string
  stop(): Promise<void>
}
interface Case {
  name: string
  openAt: number
  duration: number
  refundAt: number
  channelId: string
  publicKey: Uint8Array
  address: string
  key?: Uint8Array
  redeem: Uint8Array
  index: number
}
export interface PairClockEvidence {
  scope: string
  envelope: typeof ENVELOPE
  identities: Record<string, unknown>
  schedules: Array<Record<string, unknown>>
  funding: Record<string, unknown>
  xecHeaders: Header[]
  observations: Array<Record<string, unknown>>
}
export async function startOwnedEvm(timestamp: number): Promise<OwnedEvm> {
  const binary = resolve(
    __dirname,
    '../../../contracts/node_modules/.bin/anvil',
  )
  const version = execFileSync(binary, ['--version'], {
    encoding: 'utf8',
  }).trim()
  assert.match(version, /anvil/i)
  const port = await freePort()
  const root = mkdtempSync(join(tmpdir(), 'frank-pair-clock-anvil-'))
  const supervisor = new Supervisor(process.env, () => {})
  const request = new FetchRequest(`http://127.0.0.1:${port}`)
  request.timeout = 2000
  const provider = new JsonRpcProvider(request, 20143, {
    staticNetwork: true,
    cacheTimeout: -1,
    batchMaxCount: 1,
  })
  provider.pollingInterval = 20
  let stopped: Promise<void> | undefined
  const kill = () => {
    supervisor.killAllNow()
    rmSync(root, { recursive: true, force: true })
  }
  const stop = () =>
    (stopped ??= (async () => {
      provider.destroy()
      await supervisor.stopAll(3000)
      rmSync(root, { recursive: true, force: true })
      process.off('exit', kill)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', interrupt)
      assert.equal(await isListening(port), false)
    })())
  const interrupt = () => {
    void stop().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('exit', kill)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    const child = supervisor.start({
      name: 'pair-clock-anvil',
      command: binary,
      args: [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--chain-id',
        '20143',
        '--timestamp',
        String(timestamp),
        '--threads',
        '1',
        '--accounts',
        '4',
        '--silent',
      ],
      cwd: root,
      logPath: join(root, 'anvil.log'),
      env: {},
    })
    const deadline = Date.now() + 30000
    for (;;) {
      if (child.hasExited())
        throw new Error('owned Anvil exited before readiness')
      try {
        assert.equal(await provider.send('eth_chainId', []), '0x4eaf')
        break
      } catch {
        if (Date.now() > deadline)
          throw new Error('owned Anvil readiness timeout')
        await sleep(50)
      }
    }
    assert.match(await provider.send('web3_clientVersion', []), /anvil/i)
    const accounts = Array.from({ length: 4 }, (_, i) =>
      HDNodeWallet.fromPhrase(
        'test test test test test test test test test test test junk',
        undefined,
        `m/44'/60'/0'/0/${i}`,
      ).connect(provider),
    )
    return { provider, accounts, version, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
export async function runPairRecoveryClockFixture(
  options: Parameters<typeof startOwnedTemplateFixture>[0],
): Promise<PairClockEvidence> {
  const abc = await startOwnedTemplateFixture(options)
  let evm: OwnedEvm | undefined
  try {
    const header = await abc.rpc<Header>('getblockheader', [
      await abc.rpc<string>('getbestblockhash'),
    ])
    evm = await startOwnedEvm(header.time + 1990)
    return await exercise(abc, evm, header)
  } finally {
    const results = await Promise.allSettled([
      abc.stop(),
      evm?.stop() ?? Promise.resolve(),
    ])
    for (const result of results)
      if (result.status === 'rejected') throw result.reason
  }
}
async function exercise(
  abc: ReadyTemplateFixture,
  evm: OwnedEvm,
  initial: Header,
): Promise<PairClockEvidence> {
  const rpc = abc.rpc,
    provider = evm.provider
  const [b, relayer, a] = evm.accounts as [
    HDNodeWallet,
    HDNodeWallet,
    HDNodeWallet,
    HDNodeWallet,
  ]
  const base = initial.time + 2000
  const aRefund = new Uint8Array(randomBytes(32)),
    aRefundPub = secp256k1.getPublicKey(aRefund, true)
  const bXec = c.p2pkh(secp256k1.getPublicKey(getBytes(b.privateKey), true))
  const aXec = c.p2pkh(aRefundPub)
  const plans = [
    ['safe independent refunds', 0, 200, 100],
    ['delayed challenge equal-bound rejection', 210, 145, 310],
    ['cooperative close first', 500, 200, 600],
    ['fallback first', 800, 200, 900],
    ['cooperative close after expiry', 1100, 100, 1150],
    ['unsafe bypass negative control', 1300, 40, 1400],
  ] as const
  const cases: Case[] = plans.map(([name, open, duration, refund], index) => {
    const key = new Uint8Array(randomBytes(32)),
      publicKey = secp256k1.getPublicKey(key, true)
    const address = new Wallet(`0x${c.hex(key)}`).address
    const refundAt = base + refund
    return {
      name,
      openAt: base + open,
      duration,
      refundAt,
      channelId: id(`ordinary-pair-clock-${name}-${initial.hash}`),
      publicKey,
      address,
      key,
      redeem: c.redeemScript(publicKey, aRefundPub, refundAt),
      index,
    }
  })
  const evidence: PairClockEvidence = {
    scope:
      'ordinary K only; no threshold, adaptor, joint-J, secret extraction, atomic swap or production recovery assurance',
    envelope: ENVELOPE,
    identities: {},
    schedules: cases.map(item => ({
      name: item.name,
      openingTimestamp: item.openAt,
      duration: item.duration,
      earliestEvmFallback: item.openAt + item.duration,
      xecRefundTimestamp: item.refundAt,
      xecRefundFinalBound: item.refundAt + X_BOUND_DELAY,
      responseSeconds: 10,
      crossClockSeconds: 5,
    })),
    funding: {},
    xecHeaders: [initial],
    observations: [],
  }
  const tip = async () => {
    const { hash, height, time, mediantime, previousblockhash, confirmations } =
      await rpc<Header>('getblockheader', [
        await rpc<string>('getbestblockhash'),
      ])
    return { hash, height, time, mediantime, previousblockhash, confirmations }
  }
  const recordTip = async () => {
    const header = await tip()
    assert.equal(header.previousblockhash, evidence.xecHeaders.at(-1)!.hash)
    evidence.xecHeaders.push(header)
    if (evidence.xecHeaders.length >= 11)
      assert.equal(
        header.mediantime,
        evidence.xecHeaders
          .slice(-11)
          .map(h => h.time)
          .sort((x, y) => x - y)[5],
      )
    return header
  }
  const mine = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await rpc('generatetodescriptor', [1, 'raw(6a)'])
      await recordTip()
    }
  }
  const mtp = async (target: number) => {
    assert.ok((await tip()).mediantime <= target)
    await rpc('setmocktime', [target])
    for (let i = 0; (await tip()).mediantime < target; i++) {
      assert.ok(i < 12)
      await mine(1)
    }
    assert.equal((await tip()).mediantime, target)
  }
  await rpc('setmocktime', [initial.time + 100])
  const coinbaseHash = (
    await rpc<string[]>('generatetodescriptor', [1, `raw(${c.hex(aXec)})`])
  )[0]!
  const coinbaseBlock = await rpc<Block>('getblock', [coinbaseHash, 2])
  await recordTip()
  await mine(1350)
  const source = coinbaseBlock.tx[0]!,
    sourceOutput = source.vout.find(
      output => output.scriptPubKey.hex === c.hex(aXec),
    )!
  const inputValue = BigInt(Math.round(sourceOutput.value * 100))
  const utxo = await rpc<Output>('gettxout', [
    source.txid,
    sourceOutput.n,
    false,
  ])
  assert.ok((utxo.confirmations ?? 0) >= 1351)
  const lockValue = X + X_FEE
  const change = inputValue - BigInt(cases.length) * lockValue - X_FEE
  const transaction = c.transaction(
    source.txid,
    sourceOutput.n,
    lockValue,
    c.p2sh(cases[0]!.redeem),
  )
  const planned = {
    ...transaction,
    outputs: [
      ...cases.map(item => ({
        value: lockValue,
        scriptPubKey: c.p2sh(item.redeem),
      })),
      { value: change, scriptPubKey: aXec },
    ],
  }
  const fundingDigest = c.digest(planned, aXec, inputValue)
  const signature = secp256k1
    .sign(fundingDigest, aRefund, { prehash: false, lowS: true })
    .toDERRawBytes()
  const funded = {
    ...planned,
    inputs: [
      {
        ...planned.inputs[0]!,
        scriptSig: c.concat(
          c.push(c.concat(signature, c.bytes('41'))),
          c.push(aRefundPub),
        ),
      },
    ],
  }
  const fundingRaw = c.raw(funded),
    fundingId = c.txid(funded)
  assert.ok(fundingRaw.length / 2 <= Number(X_FEE))
  const fundingBlock = await rpc<{ hash: string }>('generateblock', [
    'raw(6a)',
    [fundingRaw],
  ])
  assert.equal(
    (await rpc<Block>('getblock', [fundingBlock.hash, 2])).tx.find(
      tx => tx.txid === fundingId,
    )!.hex,
    fundingRaw,
  )
  await recordTip()
  evidence.funding = {
    coinbase: {
      blockhash: coinbaseHash,
      raw: source.hex,
      txid: source.txid,
      vout: sourceOutput.n,
      inputSats: inputValue.toString(),
      confirmations: utxo.confirmations,
    },
    raw: fundingRaw,
    txid: fundingId,
    blockhash: fundingBlock.hash,
    lockedSatsPerCase: lockValue.toString(),
    changeSats: change.toString(),
    feeSats: X_FEE.toString(),
    aRefundPublicKey: c.hex(aRefundPub),
    bDestinationScript: c.hex(bXec),
    scripts: cases.map(item => ({
      name: item.name,
      publicKey: c.hex(item.publicKey),
      redeemScript: c.hex(item.redeem),
      vout: item.index,
    })),
  }
  const initialBalances = {
    A: await provider.getBalance(a.address),
    B: await provider.getBalance(b.address),
    relayer: await provider.getBalance(relayer.address),
  }
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, b)
  const deployment = await factory.deploy({
    gasLimit: 3000000n,
    maxFeePerGas: MAX_PRICE,
    maxPriorityFeePerGas: 1n,
  })
  await deployment.waitForDeployment()
  const contractAddress = await deployment.getAddress()
  const contract = new Contract(contractAddress, artifact.abi, provider)
  const code = await provider.getCode(contractAddress)
  assert.equal(code, artifact.deployedBytecode)
  const runtimeHash = keccak256(code),
    genesis = await provider.getBlock(0)
  assert.ok(genesis && genesis.hash)
  assert.equal(BigInt(await provider.send('eth_chainId', [])), 20143n)
  evidence.identities = {
    xec: {
      chainIdentifier: 'xec-regtest',
      version: (await rpc<{ subversion: string }>('getnetworkinfo')).subversion,
      checkpoint: { height: initial.height, hash: initial.hash },
    },
    evm: {
      chainIdentifier: 'monad-regtest',
      simulator: evm.version,
      clientVersion: await provider.send('web3_clientVersion', []),
      nativeChainId: '20143',
      checkpoint: {
        height: 0,
        hash: genesis.hash,
        timestamp: genesis.timestamp,
      },
      contractAddress,
      runtimeHash,
    },
    participants: { A: a.address, B: b.address, relayer: relayer.address },
  }
  const balance = (address: string) => provider.getBalance(address)
  const deploymentReceipt = (await deployment.deploymentTransaction()!.wait())!
  assert.ok(
    deploymentReceipt.gasUsed <= 3000000n &&
      deploymentReceipt.gasPrice <= MAX_PRICE,
  )
  evidence.identities.deployment = {
    hash: deploymentReceipt.hash,
    blockhash: deploymentReceipt.blockHash,
    blockNumber: deploymentReceipt.blockNumber,
    feeWei: deploymentReceipt.fee.toString(),
    gasUsed: deploymentReceipt.gasUsed.toString(),
    gasPrice: deploymentReceipt.gasPrice.toString(),
  }
  let totalFees = deploymentReceipt.fee
  const observeTx = async (
    label: string,
    signer: HDNodeWallet,
    method: string,
    args: unknown[],
    at: number,
    expectedError?: string,
    value = 0n,
  ) => {
    const addresses = [
      a.address,
      b.address,
      relayer.address,
      contractAddress,
      ...cases.map(item => item.address),
    ]
    const before = await Promise.all(addresses.map(balance))
    const data = contract.interface.encodeFunctionData(method, args)
    await provider.send('evm_setNextBlockTimestamp', [at])
    const sent = await signer.sendTransaction({
      to: contractAddress,
      data,
      value,
      gasLimit: GAS_LIMIT,
      maxFeePerGas: MAX_PRICE,
      maxPriorityFeePerGas: 1n,
    })
    let receipt: TransactionReceipt | null
    try {
      receipt = await sent.wait()
    } catch {
      receipt = await provider.getTransactionReceipt(sent.hash)
    }
    assert.ok(receipt)
    const block = await provider.getBlock(receipt.blockNumber)
    assert.ok(block)
    assert.equal(block.timestamp, at)
    assert.ok(receipt.gasUsed <= GAS_LIMIT && receipt.gasPrice <= MAX_PRICE)
    totalFees += receipt.fee
    assert.ok(totalFees <= TOTAL_GAS_BUDGET)
    let revertData: string | undefined
    if (expectedError) {
      assert.equal(receipt.status, 0)
      try {
        await provider.call({
          to: contractAddress,
          from: signer.address,
          data,
          value,
        })
      } catch (error) {
        assert.ok(error instanceof Error && 'data' in error)
        revertData = String(error.data)
      }
      assert.equal(revertData, id(`${expectedError}()`).slice(0, 10))
    } else assert.equal(receipt.status, 1)
    const after = await Promise.all(addresses.map(balance))
    const deltas = Object.fromEntries(
      addresses.map((address, i) => [
        address,
        (after[i]! - before[i]!).toString(),
      ]),
    )
    if (expectedError)
      for (const address of addresses)
        assert.equal(
          deltas[address],
          address === signer.address ? (-receipt.fee).toString() : '0',
          'reverted call changes only gas payer balance',
        )
    evidence.observations.push({
      label,
      chainIdentifier: 'monad-regtest',
      method,
      at,
      receipt: {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        blockhash: receipt.blockHash,
        timestamp: block.timestamp,
        status: receipt.status,
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.gasPrice.toString(),
        feeWei: receipt.fee.toString(),
      },
      expectedError,
      revertData,
      deltas,
      logs: receipt.logs.map(log => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
      transaction: {
        from: signer.address,
        to: contractAddress,
        data,
        valueWei: value.toString(),
      },
    })
    return { receipt, deltas, timestamp: at }
  }
  const openMethod = 'openChannel(bytes32,address,uint256)'
  const closeMethod =
    'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)'
  const terms = (item: Case): StateChannelPairTerms => ({
    termsHash: id(`ordinary-terms-${item.channelId}`),
    channelId: item.channelId,
    xecChainIdentifier: 'xec-regtest',
    evmChainIdentifier: 'monad-regtest',
    evmNativeChainId: 20143n,
    xecCheckpoint: {
      height: BigInt(initial.height),
      hash: `0x${initial.hash}`,
    },
    evmCheckpoint: { height: 0n, hash: genesis.hash! },
    contractAddress,
    runtimeHash,
    jointPublicKey: `0x${c.hex(item.publicKey)}`,
    jointAddress: item.address,
    adaptorPoint: `0x${c.hex(
      secp256k1.getPublicKey(new Uint8Array([...new Uint8Array(31), 1]), true),
    )}`,
    lockOwner: 'B',
    initiator: 'A',
    participants: [b.address, item.address],
    balances: [M, 0n],
    xecPrincipal: X,
    xecClaimFee: X_FEE,
    evmFeeBudget: TOTAL_GAS_BUDGET,
    aPayout: a.address,
    aRefundPublicKey: `0x${c.hex(aRefundPub)}`,
    bXecDestination: c.hex(bXec),
    evmOpeningTimestamp: BigInt(item.openAt),
    challengeDuration: BigInt(item.duration),
    xecRefundTimestamp: BigInt(item.refundAt),
    xecRefundFinalBound: BigInt(item.refundAt + X_BOUND_DELAY),
    evmClaimResponseMargin: 10n,
    crossClockMargin: 5n,
    bClaimInclusionMargin: 8n,
    maxObserverAge: 4n,
    maxReorgDepth: 1n,
  })
  const identity: Parameters<typeof validateStateChannelPairTerms>[1] = (
    chain,
    checkpoint,
    custody,
  ) =>
    chain === 'xec-regtest'
      ? checkpoint.hash === `0x${initial.hash}` &&
        checkpoint.height === BigInt(initial.height)
      : chain === 'monad-regtest' &&
        checkpoint.hash === genesis.hash &&
        checkpoint.height === 0n &&
        custody?.address === contractAddress &&
        custody.runtimeHash === runtimeHash &&
        custody.nativeChainId === 20143n
  const open = async (item: Case) => {
    const result = await observeTx(
      `${item.name}: actual deposit`,
      b,
      openMethod,
      [item.channelId, item.address, item.duration],
      item.openAt,
      undefined,
      M,
    )
    assert.equal(result.deltas[contractAddress], M.toString())
    assert.equal(result.deltas[b.address], (-M - result.receipt.fee).toString())
    assert.equal(await balance(item.address), 0n)
    const channel = await contract
      .getFunction('channels')
      .staticCall(item.channelId)
    const opened = result.receipt.logs
      .map(log =>
        contract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        }),
      )
      .find(log => log?.name === 'ChannelOpened')
    assert.ok(opened)
    assert.equal(opened.args.channelId, item.channelId)
    assert.equal(opened.args.partyA, b.address)
    assert.equal(opened.args.partyB, item.address)
    assert.equal(opened.args.depositA, M)
    assert.equal(opened.args.challengeDuration, BigInt(item.duration))
    assert.equal(channel.token, ZeroAddress)
    assert.equal(channel.currentSeq, 0n)
    assert.equal(channel.challengeExpiresAt, 0n)
    assert.equal(channel.challengeDuration, BigInt(item.duration))
    assert.equal(channel.settled, false)
    return result
  }
  const challenge = async (item: Case, at: number) => {
    await observeTx(
      `${item.name}: B alone starts challenge`,
      b,
      'startChallenge',
      [item.channelId],
      at,
    )
    const channel = await contract
      .getFunction('channels')
      .staticCall(item.channelId)
    const expiry = Number(channel.challengeExpiresAt)
    assert.equal(expiry, at + item.duration)
    evidence.observations.push({
      label: `${item.name}: opening anchored fallback bound`,
      earliest: earliestEvmRefund(terms(item)).toString(),
      observedExpiry: expiry,
      openingTimestamp: item.openAt,
      challengeTimestamp: at,
    })
    return expiry
  }
  const fallback = async (item: Case, at: number) => {
    const result = await observeTx(
      `${item.name}: independent relayer fallback`,
      relayer,
      'closeAfterChallenge',
      [item.channelId],
      at,
    )
    assert.equal(result.deltas[b.address], M.toString())
    assert.equal(result.deltas[item.address], '0')
    assert.equal(result.deltas[contractAddress], (-M).toString())
    assert.equal(result.deltas[a.address], '0')
    assert.equal(
      result.deltas[relayer.address],
      (-result.receipt.fee).toString(),
    )
    return result
  }
  const closeArgs = async (item: Case) => {
    assert.ok(
      item.key,
      'ordinary K intentionally unavailable after abandonment',
    )
    const payload = keccak256(
      AbiCoder.defaultAbiCoder().encode(
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
          item.channelId,
          1,
          [M, 0n],
          a.address,
          ZeroAddress,
          true,
          contractAddress,
          20143n,
        ],
      ),
    )
    const digest = hashMessage(getBytes(payload))
    assert.equal(
      await contract
        .getFunction('getCloseDigest')
        .staticCall(item.channelId, 1, [M, 0n], a.address, ZeroAddress, true),
      digest,
    )
    const k = new Wallet(`0x${c.hex(item.key)}`)
    const sigB = b.signingKey.sign(digest).serialized,
      sigK = k.signingKey.sign(digest).serialized
    evidence.observations.push({
      label: `${item.name}: ordinary dual authorization`,
      digest,
      sigB,
      sigK,
      participants: [b.address, item.address],
      seq: 1,
      balancesWei: [M.toString(), '0'],
      payout0: a.address,
      payout1: ZeroAddress,
      ordinaryOnly: true,
    })
    return [item.channelId, 1, [M, 0n], a.address, ZeroAddress, sigB, sigK]
  }
  const xecSpend = (item: Case, branch: 'claim' | 'refund') => {
    const key = branch === 'refund' ? aRefund : item.key
    assert.ok(key, 'abandoned ordinary claim key unavailable')
    const tx = c.transaction(
      fundingId,
      item.index,
      X,
      branch === 'refund' ? aXec : bXec,
      branch === 'refund' ? item.refundAt : 0,
      branch === 'refund' ? 0xfffffffe : 0xffffffff,
    )
    const signed = c.sign(tx, item.redeem, lockValue, key, branch)
    assert.ok(signed.raw.length / 2 <= Number(X_FEE))
    return { ...signed, txid: c.txid(signed.tx) }
  }
  const nativeSpend = async (
    item: Case,
    branch: 'claim' | 'refund',
    reject = false,
  ) => {
    const spend = xecSpend(item, branch),
      before = await tip()
    const old = await rpc<Output>('gettxout', [fundingId, item.index, false])
    assert.ok(old)
    assert.equal(Math.round(old.value * 100), Number(lockValue))
    assert.equal(old.scriptPubKey.hex, c.hex(c.p2sh(item.redeem)))
    const policy = await rpc('testmempoolaccept', [[spend.raw]])
    let result: { hash: string } | undefined,
      failure: { code: number; message: string } | undefined
    try {
      result = await rpc<{ hash: string }>('generateblock', [
        'raw(6a)',
        [spend.raw],
      ])
    } catch (error) {
      assert.ok(error instanceof Error && 'code' in error)
      failure = { code: Number(error.code), message: error.message }
    }
    const { tx: _tx, ...publicSpend } = spend
    if (reject) {
      assert.ok(failure)
      assert.equal(failure.code, -25)
      assert.match(failure.message, /bad-txns-nonfinal/)
      assert.equal((await tip()).hash, before.hash)
      assert.deepEqual(
        await rpc('gettxout', [fundingId, item.index, false]),
        old,
      )
      evidence.observations.push({
        label: `${item.name}: native refund before maturity rejected`,
        previousTip: before,
        publicSpend,
        policy,
        nativeError: failure,
        tipAndOutpointUnchanged: true,
      })
      return undefined
    }
    assert.ok(result, failure?.message)
    const block = await rpc<Block>('getblock', [result.hash, 2]),
      observed = block.tx.find(tx => tx.txid === spend.txid)!
    assert.ok(observed)
    assert.equal(observed.hex, spend.raw)
    assert.equal(
      observed.vout[0]!.scriptPubKey.hex,
      c.hex(branch === 'refund' ? aXec : bXec),
    )
    assert.equal(Math.round(observed.vout[0]!.value * 100), Number(X))
    assert.equal(await rpc('gettxout', [fundingId, item.index, false]), null)
    await recordTip()
    await mine(1)
    const confirmed = await rpc<Header>('getblockheader', [result.hash])
    assert.ok(confirmed.confirmations >= ENVELOPE.xecConfirmationDepth)
    evidence.observations.push({
      label: `${item.name}: native ${branch} canonical`,
      previousTip: before,
      publicSpend,
      policy,
      inclusion: { hash: result.hash, height: block.height },
      confirmations: confirmed.confirmations,
      canonicalObservedAt: (await tip()).time,
      recipientSats: Number(X),
      feeSats: Number(X_FEE),
      recipientScript: observed.vout[0]!.scriptPubKey.hex,
    })
    return { confirmed, previousTip: before, finalTip: await tip() }
  }
  const safe = cases[0]!
  await open(safe)
  assert.deepEqual(validateStateChannelPairTerms(terms(safe), identity), [])
  const boundary = { ...terms(safe), challengeDuration: 145n },
    short = { ...terms(safe), challengeDuration: 144n }
  for (const probe of [boundary, short])
    assert.ok(
      validateStateChannelPairTerms(probe, identity).includes('unsafe-horizon'),
    )
  evidence.observations.push({
    label:
      'pure B0 horizon rejects equality and short before ordinary completion authorization',
    safeErrors: [],
    boundaryErrors: validateStateChannelPairTerms(boundary, identity),
    shortErrors: validateStateChannelPairTerms(short, identity),
    ordinaryCompletionReleasedForRejectedTerms: false,
    thresholdCompletionReleased: false,
    adaptorPointMeaning:
      'unused ordinary public generator placeholder for validator shape only',
  })
  const safeExpiry = await challenge(safe, safe.openAt + 1)
  safe.key!.fill(0)
  safe.key = undefined
  evidence.observations.push({
    label: 'safe ordinary K abandoned before recovery',
    claimKeyAvailable: false,
    model: 'reference removal and byte overwrite only; no threshold burn claim',
  })
  await mtp(safe.refundAt)
  await nativeSpend(safe, 'refund', true)
  await mtp(safe.refundAt + 1)
  const recovered = await nativeSpend(safe, 'refund')
  assert.ok(recovered)
  assert.ok(
    recovered.previousTip.time - safe.refundAt <= ENVELOPE.mtpLagSeconds,
  )
  assert.ok(
    recovered.confirmed.time - recovered.previousTip.time <=
      ENVELOPE.refundInclusionSeconds,
  )
  assert.ok(
    recovered.finalTip.time - recovered.confirmed.time <=
      ENVELOPE.finalitySeconds,
  )
  assert.ok(recovered.finalTip.time <= safe.refundAt + X_BOUND_DELAY)
  assert.ok(
    safe.openAt + safe.duration >
      recovered.finalTip.time +
        ENVELOPE.evmResponseSeconds +
        ENVELOPE.crossClockSeconds,
  )
  await provider.send('evm_setNextBlockTimestamp', [
    recovered.finalTip.time + ENVELOPE.crossClockSeconds,
  ])
  await provider.send('evm_mine', [])
  const observedClock = await provider.getBlock('latest')
  assert.ok(
    observedClock && observedClock.timestamp < safe.openAt + safe.duration,
  )
  evidence.observations.push({
    label: 'safe XEC refund canonical before earliest EVM fallback',
    eligiblePreviousTip: recovered.previousTip,
    inclusionHeader: recovered.confirmed,
    xecFinalHeader: recovered.finalTip,
    actualMtpLagSeconds: recovered.previousTip.time - safe.refundAt,
    evmObservation: {
      number: observedClock.number,
      hash: observedClock.hash,
      timestamp: observedClock.timestamp,
    },
    earliest: safe.openAt + safe.duration,
    bound: safe.refundAt + X_BOUND_DELAY,
    responseSeconds: 10,
    crossClockSeconds: 5,
  })
  await observeTx(
    'safe fallback before expiry rejects',
    relayer,
    'closeAfterChallenge',
    [safe.channelId],
    safeExpiry - 1,
    'ChallengeNotExpired',
  )
  await fallback(safe, safeExpiry)
  await observeTx(
    'safe fallback after settlement rejects',
    relayer,
    'closeAfterChallenge',
    [safe.channelId],
    safeExpiry + 1,
    'ChannelAlreadySettled',
  )
  const delayed = cases[1]!
  await open(delayed)
  const delayedErrors = validateStateChannelPairTerms(terms(delayed), identity)
  assert.ok(delayedErrors.includes('unsafe-horizon'))
  const delayedExpiry = await challenge(delayed, delayed.openAt + 30)
  assert.equal(
    Number(earliestEvmRefund(terms(delayed))),
    delayed.openAt + delayed.duration,
  )
  assert.ok(delayedExpiry > Number(earliestEvmRefund(terms(delayed))))
  evidence.observations.push({
    label: 'delayed challenge never widens admission horizon',
    errors: delayedErrors,
    earliest: delayed.openAt + delayed.duration,
    observedExpiry: delayedExpiry,
    ordinaryCompletionReleased: false,
  })
  delayed.key!.fill(0)
  delayed.key = undefined
  await fallback(delayed, delayedExpiry)
  const closeFirst = cases[2]!
  await open(closeFirst)
  assert.deepEqual(
    validateStateChannelPairTerms(terms(closeFirst), identity),
    [],
  )
  const firstExpiry = await challenge(closeFirst, closeFirst.openAt + 1)
  const firstArgs = await closeArgs(closeFirst),
    tampered = [...firstArgs]
  tampered[3] = relayer.address
  await observeTx(
    'independent fee payer cannot redirect fixed cooperative payout',
    relayer,
    closeMethod,
    tampered,
    closeFirst.openAt + 9,
    'InvalidSignature',
  )
  const paidA = await observeTx(
    'cooperative close first pays fixed A',
    relayer,
    closeMethod,
    firstArgs,
    closeFirst.openAt + 10,
  )
  assert.equal(paidA.deltas[a.address], M.toString())
  assert.equal(paidA.deltas[b.address], '0')
  assert.equal(paidA.deltas[closeFirst.address], '0')
  assert.equal(paidA.deltas[contractAddress], (-M).toString())
  assert.equal(paidA.deltas[relayer.address], (-paidA.receipt.fee).toString())
  await observeTx(
    'fallback after cooperative close rejects',
    relayer,
    'closeAfterChallenge',
    [closeFirst.channelId],
    firstExpiry,
    'ChannelAlreadySettled',
  )
  const refundFirst = cases[3]!
  await open(refundFirst)
  assert.deepEqual(
    validateStateChannelPairTerms(terms(refundFirst), identity),
    [],
  )
  const secondExpiry = await challenge(refundFirst, refundFirst.openAt + 1)
  const secondArgs = await closeArgs(refundFirst)
  await fallback(refundFirst, secondExpiry)
  await observeTx(
    'cooperative close after fallback rejects',
    relayer,
    closeMethod,
    secondArgs,
    secondExpiry + 1,
    'ChannelAlreadySettled',
  )
  const late = cases[4]!
  await open(late)
  assert.deepEqual(validateStateChannelPairTerms(terms(late), identity), [])
  const lateExpiry = await challenge(late, late.openAt + 1)
  const lateResult = await observeTx(
    'cooperative close remains valid after expiry if fallback unset',
    relayer,
    closeMethod,
    await closeArgs(late),
    lateExpiry + 1,
  )
  assert.equal(lateResult.deltas[a.address], M.toString())
  assert.equal(lateResult.deltas[late.address], '0')
  assert.equal(lateResult.deltas[b.address], '0')
  assert.equal(lateResult.deltas[contractAddress], (-M).toString())
  assert.equal(
    lateResult.deltas[relayer.address],
    (-lateResult.receipt.fee).toString(),
  )
  const unsafe = cases[5]!
  await open(unsafe)
  const unsafeErrors = validateStateChannelPairTerms(terms(unsafe), identity)
  assert.ok(unsafeErrors.includes('unsafe-horizon'))
  const unsafeExpiry = await challenge(unsafe, unsafe.openAt + 1)
  await fallback(unsafe, unsafeExpiry)
  await mtp(unsafe.refundAt + 1)
  const theft = await nativeSpend(unsafe, 'claim')
  assert.ok(theft)
  evidence.observations.push({
    label: 'unsafe guard bypass trace only: inactive A loses both principals',
    admissionErrors: unsafeErrors,
    intentionallyBypassed: true,
    earliestEvmFallback: unsafe.openAt + unsafe.duration,
    declaredRequiredStrictLowerBound: unsafe.refundAt + X_BOUND_DELAY + 10 + 5,
    violatedHorizonSeconds:
      unsafe.refundAt +
      X_BOUND_DELAY +
      ENVELOPE.evmResponseSeconds +
      ENVELOPE.crossClockSeconds -
      (unsafe.openAt + unsafe.duration),
    evmFallbackReceiptAt: unsafeExpiry,
    lateXecClaimFinalAt: theft.finalTip.time,
    bReceivesEvmPrincipalWei: M.toString(),
    bReceivesXecPrincipalSats: Number(X),
    aRefundReceivedSats: 0,
    secretExtraction: false,
    admissible: false,
  })
  assert.equal(await balance(contractAddress), 0n)
  for (const item of cases) {
    assert.equal(await balance(item.address), 0n)
    assert.equal(
      (await contract.getFunction('channels').staticCall(item.channelId))
        .settled,
      true,
    )
  }
  const bFees = evidence.observations
    .filter(
      item =>
        item.receipt &&
        (item.transaction as { from: string }).from === b.address,
    )
    .reduce(
      (sum, item) => sum + BigInt((item.receipt as { feeWei: string }).feeWei),
      deploymentReceipt.fee,
    )
  const relayerFees = totalFees - bFees
  const aNet = (await balance(a.address)) - initialBalances.A
  const bNet = (await balance(b.address)) - initialBalances.B
  const relayerNet = (await balance(relayer.address)) - initialBalances.relayer
  assert.equal(aNet, 2n * M)
  assert.equal(bNet, -2n * M - bFees)
  assert.equal(relayerNet, -relayerFees)
  evidence.observations.push({
    label: 'all EVM principal and independent payer fees reconcile',
    fundedPrincipalWei: (6n * M).toString(),
    cooperativeAPrincipalWei: (2n * M).toString(),
    fallbackBPrincipalWei: (4n * M).toString(),
    aNetWei: aNet.toString(),
    bNetWei: bNet.toString(),
    bGasWei: bFees.toString(),
    relayerNetWei: relayerNet.toString(),
    relayerGasWei: relayerFees.toString(),
    contractFinalWei: '0',
    allOrdinaryKFinalWei: '0',
  })
  evidence.observations.push({
    label: 'aggregate actual gas within declared test budget',
    totalFeeWei: totalFees.toString(),
    budgetWei: TOTAL_GAS_BUDGET.toString(),
    xecPrincipalSats: Number(X),
    evmPrincipalWei: M.toString(),
    unsettledSyntheticOutputs: cases
      .filter(item => ![0, 5].includes(item.index))
      .map(item => ({ case: item.name, vout: item.index, testOnly: true })),
  })
  return evidence
}
if (require.main === module) {
  ;(async () => {
    const archive = process.env.ADAPTOR_ABC_ARCHIVE,
      binaryDir = process.env.FRANK_BITCOIN_ABC_BIN_DIR
    if (!archive || !binaryDir)
      throw new Error('verified ABC archive and binary directory required')
    console.log(
      JSON.stringify(
        await runPairRecoveryClockFixture({ archive, binaryDir }),
        null,
        2,
      ),
    )
  })().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
