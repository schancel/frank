/** Ordinary refund/fallback native observation only; no threshold security claim. */
import assert from 'assert/strict'
import {
  mkdtempSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Transaction,
  id,
  keccak256,
  recoverAddress,
  type TransactionReceipt,
} from 'ethers'
import { XEC_REGTEST, parseTransaction } from '@frank/nakamoto'
import artifact from '../../../../contracts/artifacts/StateChannel.json'
import { ordinaryCltv as c } from '../cltv-consensus-fixture'
import { runPairRecoveryClockFixture } from '../pair-recovery-clock-fixture'
import type { ReadyTemplateFixture } from '../owned-template-fixture'
type Rpc = ReadyTemplateFixture['rpc']
interface Anchor {
  hash: string
  height: number
}
interface Header extends Anchor {
  time: number
  mediantime: number
  previousblockhash?: string
  confirmations: number
}
interface Block extends Anchor {
  tx: Array<{
    txid: string
    hex: string
    vin: Array<{ txid?: string; vout?: number }>
    vout: Array<{ n: number; value: number; scriptPubKey: { hex: string } }>
  }>
}
export interface RefundRecord {
  version: 1
  chainIdentifier: string
  checkpoint: Anchor
  funding: Anchor
  inclusion: Anchor
  fundingTxid: string
  vout: number
  inputSats: string
  principalSats: string
  feeSats: string
  recipientScript: string
  redeemScript: string
  refundTimestamp: number
  claimPublicKey: string
  refundPublicKey: string
  raw: string
  signatureDer: string
}
export interface FallbackRecord {
  version: number
  chainIdentifier: string
  nativeChainId: string
  checkpoint: Anchor
  contract: string
  channelId: string
  runtimeHash: string
  recipient: string
  relayer: string
  principalWei: string
  signedRaw: string
  inclusion: Anchor
  opening: Anchor & { transactionHash: string }
  challenge: Anchor & { transactionHash: string }
  cooperativeData?: string
  rejectedReceipt?: unknown
}
function persist(path: string, record: unknown) {
  const bytes = Buffer.from(JSON.stringify(record)),
    fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const parent = openSync(join(path, '..'), 'r')
  try {
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
  assert.deepEqual(readFileSync(path), bytes)
}
async function withPublic<T>(
  record: unknown,
  use: (path: string) => Promise<T>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'frank-refund-observer-'))
  try {
    const path = join(directory, 'public.json')
    persist(path, record)
    return await use(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
function endpoint(value: string) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
  return value
}
/** Fixture-only observation transport. Neither cookies nor signing/mutation RPC reach the child. */
export async function withReadOnlyRpc<T>(
  rpc: Rpc,
  use: (url: string) => Promise<T>,
) {
  const allowed = new Set([
    'getblockchaininfo',
    'getblockhash',
    'getblockheader',
    'getblock',
    'gettxout',
  ])
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST')
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        bytes += chunk.length
        assert.ok(bytes <= 4096, 'bounded observation request')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        method: string
        params: unknown[]
      }
      assert.ok(
        body && typeof body.method === 'string' && allowed.has(body.method),
        'read method required',
      )
      assert.ok(Array.isArray(body.params) && body.params.length <= 3)
      const result = await rpc(body.method, body.params)
      response.setHeader('connection', 'close')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ result }))
    } catch {
      response.statusCode = 400
      response.end(
        JSON.stringify({ error: 'invalid read-only observation request' }),
      )
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return await use(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    )
  }
}
function rpcAt(url: string): Rpc {
  endpoint(url)
  return async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(3000),
    })
    assert.equal(response.status, 200)
    return ((await response.json()) as { result: T }).result
  }
}
async function child(mode: string, path: string, url: string) {
  // Async spawn is required: the parent serves read-only ABC observations while the child runs.
  const { spawn } = await import('child_process')
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const processChild = spawn(
      process.execPath,
      ['--import', 'tsx', __filename, mode, path, endpoint(url)],
      {
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = '',
      error = ''
    const timer = setTimeout(() => {
      processChild.kill('SIGKILL')
      error = 'public observer timeout'
    }, 20000)
    processChild.stdout.on('data', value => {
      output += value
      if (output.length > 1024 * 1024) processChild.kill('SIGKILL')
    })
    processChild.stderr.on('data', value => {
      error += value
    })
    processChild.once('error', value => {
      clearTimeout(timer)
      reject(value)
    })
    processChild.once('close', code => {
      clearTimeout(timer)
      try {
        assert.equal(code, 0, error)
        resolve(JSON.parse(output))
      } catch (value) {
        reject(value)
      }
    })
  })
}
export function validateRefund(record: RefundRecord) {
  assert.equal(record.version, 1)
  assert.equal(record.chainIdentifier, 'xec-regtest')
  for (const anchor of [record.checkpoint, record.funding, record.inclusion]) {
    assert.match(anchor.hash, /^[0-9a-f]{64}$/)
    assert.ok(Number.isSafeInteger(anchor.height) && anchor.height >= 0)
  }
  assert.ok(
    record.inclusion.height > record.funding.height &&
      record.funding.height > record.checkpoint.height,
  )
  assert.equal(
    BigInt(record.inputSats),
    BigInt(record.principalSats) + BigInt(record.feeSats),
  )
  assert.equal(
    c.hex(
      c.redeemScript(
        c.bytes(record.claimPublicKey),
        c.bytes(record.refundPublicKey),
        record.refundTimestamp,
      ),
    ),
    record.redeemScript,
  )
  assert.equal(
    c.hex(c.p2pkh(c.bytes(record.refundPublicKey))),
    record.recipientScript,
  )
  const decoded = parseTransaction(c.bytes(record.raw), XEC_REGTEST)
  assert.ok(decoded.ok)
  const tx = decoded.value,
    planned = c.transaction(
      record.fundingTxid,
      record.vout,
      BigInt(record.principalSats),
      c.bytes(record.recipientScript),
      record.refundTimestamp,
      0xfffffffe,
    )
  assert.equal(tx.version, planned.version)
  assert.equal(tx.locktime, planned.locktime)
  assert.equal(tx.inputs.length, 1)
  assert.deepEqual(tx.inputs[0]!.prevout, planned.inputs[0]!.prevout)
  assert.equal(tx.inputs[0]!.sequence, planned.inputs[0]!.sequence)
  assert.deepEqual(tx.outputs, planned.outputs)
  assert.deepEqual(
    tx.inputs[0]!.scriptSig,
    c.concat(
      c.push(c.concat(c.bytes(record.signatureDer), c.bytes('41'))),
      c.bytes('00'),
      c.push(c.bytes(record.redeemScript)),
    ),
  )
  const signature = secp256k1.Signature.fromDER(c.bytes(record.signatureDer))
  assert.ok(
    secp256k1.verify(
      signature.toCompactRawBytes(),
      c.digest(tx, c.bytes(record.redeemScript), BigInt(record.inputSats)),
      c.bytes(record.refundPublicKey),
      { prehash: false, lowS: true },
    ),
  )
  return c.txid(tx)
}
async function headers(rpc: Rpc, funding: Anchor) {
  assert.equal(await rpc('getblockhash', [funding.height]), funding.hash)
  const best = await rpc<Header>('getblockheader', [
    await rpc('getblockhash', [
      (await rpc<{ blocks: number }>('getblockchaininfo')).blocks,
    ]),
  ])
  assert.ok(best.height - funding.height <= 32)
  const result: Header[] = []
  for (let height = funding.height; height <= best.height; height++) {
    const header = await rpc<Header>('getblockheader', [
      await rpc('getblockhash', [height]),
    ])
    assert.equal(header.height, height)
    if (result.length)
      assert.equal(header.previousblockhash, result.at(-1)!.hash)
    result.push(header)
  }
  return result
}
async function observeRefund(record: RefundRecord, rpc: Rpc) {
  const txid = validateRefund(record)
  assert.equal(
    (await rpc<{ chain: string }>('getblockchaininfo')).chain,
    'regtest',
  )
  assert.equal(
    await rpc('getblockhash', [record.checkpoint.height]),
    record.checkpoint.hash,
  )
  const chain = await headers(rpc, record.funding)
  const fundingBlock = await rpc<Block>('getblock', [record.funding.hash, 2])
  const source = fundingBlock.tx.find(tx => tx.txid === record.fundingTxid)
    ?.vout[record.vout]
  assert.ok(source)
  assert.equal(Math.round(source.value * 100), Number(record.inputSats))
  assert.equal(
    source.scriptPubKey.hex,
    c.hex(c.p2sh(c.bytes(record.redeemScript))),
  )
  const inclusion = chain.find(
    header => header.height === record.inclusion.height,
  )
  const canonical = inclusion?.hash === record.inclusion.hash
  const depth = canonical
    ? chain.at(-1)!.height - record.inclusion.height + 1
    : 0
  if (canonical) {
    const block = await rpc<Block>('getblock', [record.inclusion.hash, 2])
    assert.ok(block.tx.some(tx => tx.txid === txid && tx.hex === record.raw))
  }
  const unspent = await rpc('gettxout', [
    record.fundingTxid,
    record.vout,
    false,
  ])
  return {
    state: canonical && depth >= 2 ? 'canonical' : 'observed/noncanonical',
    terminalRefund: canonical && depth >= 2,
    artifactRetained: true,
    txid,
    depth,
    canonicalFundingUnspent: unspent !== null,
    headers: chain,
  }
}
export async function reorgRefund(rpc: Rpc, record: RefundRecord) {
  validateRefund(record)
  return withReadOnlyRpc(rpc, url =>
    withPublic(record, async path => {
      const wrongChain = { ...record, chainIdentifier: 'btc-mainnet' }
      await assert.rejects(
        withPublic(wrongChain, wrong => child('--xec', wrong, url)),
      )
      const wrongBinding = { ...record, fundingTxid: '00'.repeat(32) }
      await assert.rejects(
        withPublic(wrongBinding, wrong => child('--xec', wrong, url)),
      )
      const before = await child('--xec', path, url)
      assert.equal(before.terminalRefund, true)
      await rpc('invalidateblock', [record.inclusion.hash])
      assert.equal(
        (await rpc<Header>('getblockheader', [record.inclusion.hash]))
          .confirmations,
        -1,
      )
      const disconnected = await child('--xec', path, url)
      assert.equal(disconnected.state, 'observed/noncanonical')
      assert.equal(disconnected.terminalRefund, false)
      assert.equal(disconnected.canonicalFundingUnspent, true)
      const mempool = await rpc('getrawmempool')
      const original = await rpc<Header>('getblockheader', [
        record.inclusion.hash,
      ])
      await rpc('setmocktime', [original.time + 1])
      await rpc('generateblock', ['raw(6a)', []])
      const included = await rpc<Anchor>('generateblock', [
        'raw(6a)',
        [record.raw],
      ])
      await rpc('generateblock', ['raw(6a)', []])
      const block = await rpc<Block>('getblock', [included.hash, 2])
      assert.notEqual(block.hash, record.inclusion.hash)
      const current = {
        ...record,
        inclusion: { hash: block.hash, height: block.height },
      }
      const after = await withPublic(current, p => child('--xec', p, url))
      assert.equal(after.terminalRefund, true)
      assert.equal(after.canonicalFundingUnspent, false)
      return {
        block,
        headers: after.headers as Header[],
        observation: {
          label:
            'S2b XEC refund disconnected and exact signed bytes reincluded',
          publicRecord: record,
          before,
          disconnected,
          mempoolTransactionIds: mempool,
          reincluded: current.inclusion,
          current: after,
          exactOriginalSignedRawReused: true,
          privateKeysPassed: false,
          wrongChainAndMismatchedBindingsRejected: true,
        },
      }
    }),
  )
}
function validateFallback(record: FallbackRecord) {
  assert.equal(record.version, 1)
  assert.equal(record.chainIdentifier, 'monad-regtest')
  assert.equal(record.nativeChainId, '20143')
  const tx = Transaction.from(record.signedRaw)
  assert.equal(tx.chainId, 20143n)
  assert.equal(tx.to, record.contract)
  assert.equal(tx.from, record.relayer)
  assert.equal(tx.value, 0n)
  assert.equal(
    tx.data,
    new Interface(artifact.abi).encodeFunctionData('closeAfterChallenge', [
      record.channelId,
    ]),
  )
  return tx
}
async function observeFallback(record: FallbackRecord, url: string) {
  const tx = validateFallback(record),
    provider = new JsonRpcProvider(endpoint(url), 20143, {
      cacheTimeout: -1,
      batchMaxCount: 1,
    })
  try {
    assert.equal(BigInt(await provider.send('eth_chainId', [])), 20143n)
    assert.equal(
      (await provider.getBlock(record.checkpoint.height))?.hash,
      record.checkpoint.hash,
    )
    assert.equal(
      keccak256(await provider.getCode(record.contract)),
      record.runtimeHash,
    )
    const contract = new Contract(record.contract, artifact.abi, provider),
      channel = await contract
        .getFunction('channels')
        .staticCall(record.channelId)
    const openingReceipt = await provider.getTransactionReceipt(
      record.opening.transactionHash,
    )
    const challengeReceipt = await provider.getTransactionReceipt(
      record.challenge.transactionHash,
    )
    assert.ok(openingReceipt && challengeReceipt)
    for (const [anchor, receipt] of [
      [record.opening, openingReceipt],
      [record.challenge, challengeReceipt],
    ] as const) {
      assert.equal(receipt.status, 1)
      assert.equal(receipt.blockHash, anchor.hash)
      assert.equal(receipt.blockNumber, anchor.height)
      assert.equal((await provider.getBlock(anchor.height))?.hash, anchor.hash)
    }
    const opening = openingReceipt.logs
      .filter(log => log.address === record.contract)
      .map(log =>
        contract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        }),
      )
      .find(log => log?.name === 'ChannelOpened')
    assert.ok(opening)
    assert.equal(opening.args.channelId, record.channelId)
    assert.equal(opening.args.partyA, record.recipient)
    assert.equal(opening.args.depositA.toString(), record.principalWei)
    const challengeBlock = await provider.getBlock(record.challenge.height)
    assert.equal(
      Number(channel.challengeExpiresAt),
      challengeBlock!.timestamp + Number(channel.challengeDuration),
    )
    const receipt = await provider.getTransactionReceipt(tx.hash!)
    const block = receipt ? await provider.getBlock(receipt.blockNumber) : null
    const canonical =
      receipt !== null &&
      receipt.status === 1 &&
      block?.hash === receipt.blockHash
    const ancestry: Anchor[] = []
    const end =
      receipt?.blockNumber ?? (await provider.getBlock('latest'))!.number
    assert.ok(end - record.opening.height <= 32)
    for (let height = record.opening.height; height <= end; height++) {
      const header = await provider.getBlock(height)
      assert.ok(header?.hash)
      if (ancestry.length)
        assert.equal(header.parentHash, ancestry.at(-1)!.hash)
      ancestry.push({ hash: header.hash, height })
    }
    assert.equal(ancestry[0]!.hash, record.opening.hash)
    if (canonical) {
      assert.ok(block!.timestamp >= Number(channel.challengeExpiresAt))
      assert.equal(channel.settled, true)
    }
    let cooperativeExecutable: boolean | undefined
    if (record.cooperativeData) {
      const decoded = new Interface(artifact.abi).decodeFunctionData(
        'closeCooperative(bytes32,uint256,uint256[2],address,address,bytes,bytes)',
        record.cooperativeData,
      )
      assert.equal(decoded[0], record.channelId)
      assert.equal(decoded[2][0].toString(), record.principalWei)
      assert.equal(decoded[2][1], 0n)
      const digest = await contract
        .getFunction('getCloseDigest')
        .staticCall(
          decoded[0],
          decoded[1],
          [decoded[2][0], decoded[2][1]],
          decoded[3],
          decoded[4],
          true,
        )
      assert.equal(recoverAddress(digest, decoded[5]), opening.args.partyA)
      assert.equal(recoverAddress(digest, decoded[6]), opening.args.partyB)
      await assert.rejects(
        provider.call({
          from: record.relayer,
          to: record.contract,
          data: record.cooperativeData,
        }),
        error =>
          error instanceof Error &&
          'data' in error &&
          error.data === id('ChannelAlreadySettled()').slice(0, 10),
      )
      cooperativeExecutable = false
    }
    return {
      state: canonical ? 'canonical' : 'observed/noncanonical',
      canonicalAncestry: ancestry,
      terminalRefund: canonical && channel.settled,
      artifactRetained: true,
      channelSettled: channel.settled,
      contractBalanceWei: (
        await provider.getBalance(record.contract)
      ).toString(),
      challengeExpiresAt: channel.challengeExpiresAt.toString(),
      cooperativeKnowledgeRetained: !!record.cooperativeData,
      cooperativeExecutable,
      receipt: receipt
        ? {
            hash: receipt.hash,
            blockHash: receipt.blockHash,
            height: receipt.blockNumber,
            status: receipt.status,
            feeWei: receipt.fee.toString(),
          }
        : null,
    }
  } finally {
    provider.destroy()
  }
}
export async function reorgFallback(input: {
  provider: JsonRpcProvider
  snapshot: string
  receipt: TransactionReceipt
  signedRaw: string
  contract: string
  channelId: string
  checkpoint: Anchor
  runtimeHash: string
  principalWei: string
  recipient: string
  relayer: string
  balanceRecipient: string
  balanceRelayer: string
  opening: FallbackRecord['opening']
  challenge: FallbackRecord['challenge']
}) {
  const { provider } = input,
    old = input.receipt,
    tx = Transaction.from(input.signedRaw)
  const record: FallbackRecord = {
    version: 1,
    chainIdentifier: 'monad-regtest',
    nativeChainId: '20143',
    checkpoint: input.checkpoint,
    contract: input.contract,
    channelId: input.channelId,
    runtimeHash: input.runtimeHash,
    principalWei: input.principalWei,
    recipient: input.recipient,
    relayer: input.relayer,
    signedRaw: input.signedRaw,
    inclusion: { hash: old.blockHash, height: old.blockNumber },
    opening: input.opening,
    challenge: input.challenge,
  }
  validateFallback(record)
  return withPublic(record, async path => {
    const url = provider._getConnection().url
    await assert.rejects(
      withPublic({ ...record, nativeChainId: '1' }, wrong =>
        child('--evm', wrong, url),
      ),
    )
    await assert.rejects(
      withPublic({ ...record, channelId: '0x' + '00'.repeat(32) }, wrong =>
        child('--evm', wrong, url),
      ),
    )
    const before = await child('--evm', path, url)
    assert.equal(before.terminalRefund, true)
    const originalBlock = await provider.getBlock(old.blockNumber)
    assert.equal(await provider.send('evm_revert', [input.snapshot]), true)
    const disconnected = await child('--evm', path, url)
    assert.equal(disconnected.state, 'observed/noncanonical')
    assert.equal(disconnected.receipt, null)
    assert.equal(disconnected.channelSettled, false)
    assert.equal(disconnected.contractBalanceWei, input.principalWei)
    assert.equal(
      await provider.getBalance(input.recipient),
      BigInt(input.balanceRecipient),
    )
    assert.equal(
      await provider.getBalance(input.relayer),
      BigInt(input.balanceRelayer),
    )
    assert.equal(
      await provider.getTransactionCount(input.relayer, 'pending'),
      tx.nonce,
    )
    await provider.send('evm_setNextBlockTimestamp', [
      originalBlock!.timestamp + 1,
    ])
    const repeated = await provider.broadcastTransaction(input.signedRaw)
    assert.equal(repeated.hash, old.hash)
    const receipt = await repeated.wait()
    assert.ok(receipt && receipt.status === 1)
    assert.notEqual(receipt.blockHash, old.blockHash)
    assert.equal(
      (await provider.getBalance(input.recipient)) -
        BigInt(input.balanceRecipient),
      BigInt(input.principalWei),
    )
    assert.equal(
      (await provider.getBalance(input.relayer)) - BigInt(input.balanceRelayer),
      -receipt.fee,
    )
    const current = await child('--evm', path, url)
    assert.equal(current.terminalRefund, true)
    assert.equal(current.contractBalanceWei, '0')
    return {
      receipt,
      timestamp: originalBlock!.timestamp + 1,
      observation: {
        label:
          'S2b EVM fallback disconnected and exact signed transaction reincluded',
        publicRecord: record,
        before,
        disconnected,
        current,
        originalReceipt: {
          hash: old.hash,
          blockHash: old.blockHash,
          feeWei: old.fee.toString(),
        },
        currentReceipt: {
          hash: receipt.hash,
          blockHash: receipt.blockHash,
          feeWei: receipt.fee.toString(),
        },
        orphanedFeeWeiExcludedFromCurrentTotals: old.fee.toString(),
        canonicalPrincipalWei: input.principalWei,
        exactOriginalSignedRawReused: true,
        originalNonceRestored: true,
        wrongChainAndMismatchedBindingsRejected: true,
        privateKeysPassed: false,
      },
    }
  })
}
export async function observeTerminalFallback(
  provider: JsonRpcProvider,
  record: FallbackRecord,
) {
  return withPublic(record, async path => {
    const observer = await child('--evm', path, provider._getConnection().url)
    assert.equal(observer.terminalRefund, true)
    assert.equal(observer.contractBalanceWei, '0')
    assert.equal(observer.cooperativeExecutable, false)
    return {
      label:
        'S2b fresh terminal fallback observer rejects valid cooperative completion',
      publicRecord: record,
      observer,
      privateKeysPassed: false,
    }
  })
}
export async function runRefundReorgProof(
  options: Parameters<typeof runPairRecoveryClockFixture>[0],
) {
  return runPairRecoveryClockFixture({ ...options, scenario: 'refund-reorg' })
}
if (require.main === module) {
  ;(async () => {
    const [mode, path, url] = process.argv.slice(2)
    assert.ok(path && url)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    const result =
      mode === '--xec'
        ? await observeRefund(record, rpcAt(url))
        : mode === '--evm'
        ? await observeFallback(record, url)
        : assert.fail('explicit public observer mode required')
    process.stdout.write(JSON.stringify(result))
  })().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
