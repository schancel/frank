/**
 * INTEGRATION: deposits from outside Frank, found by reading a real EVM node (`anvil`).
 *
 * Real: anvil, ethers' JSON-RPC provider talking to it, a Level store on disk. Every request the
 * scanner puts on the wire is recorded, and each must be one the relay's RPC proxy serves
 * (backend/cashweb/cashweb-registry/src/http/evm_rpc.rs `validate_call`): no full-transaction
 * block reads, and `eth_getLogs` only over an explicit range of at most 10 blocks (the default
 * `max_get_logs_range`).
 *
 * The ERC20 is a minimal token compiled from the source in `TOKEN_SOURCE` with solc 0.8.37
 * (optimizer on, 200 runs, evmVersion paris); its creation bytecode is `TOKEN_BYTECODE`.
 *
 * Needs an `anvil` binary: `ANVIL_BIN=/path/to/anvil`, or the `@foundry-rs/anvil` package
 * installed, or `anvil` on PATH. Without one the suite reports itself as NOT RUN.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Contract, JsonRpcProvider, Wallet, parseEther } from 'ethers'
import {
  EVM_EXTERNAL_DEPOSITS_NAMESPACE,
  EvmDepositScanner,
  type EvmDepositRow,
  type EvmDepositToken,
} from './evm-deposit-scan'
import { readCanonicalNativeTransfers } from './evm-native-receipt'
import { LevelRecordStore, MemoryRecordStore } from './storage/evm-coin-store'

/* TOKEN_SOURCE
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract TestToken {
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor() { balanceOf[msg.sender] = 1e24; emit Transfer(address(0), msg.sender, 1e24); }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value; balanceOf[to] += value;
        emit Transfer(msg.sender, to, value); return true;
    }
}
*/
const TOKEN_BYTECODE =
  '0x6080604052348015600f57600080fd5b503360008181526020818152604080832069d3c21bcecceda10000009081905590519081527fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef910160405180910390a36102088061006e6000396000f3fe608060405234801561001057600080fd5b50600436106100365760003560e01c806370a082311461003b578063a9059cbb1461006e575b600080fd5b61005b61004936600461014a565b60006020819052908152604090205481565b6040519081526020015b60405180910390f35b61008161007c36600461016c565b610091565b6040519015158152602001610065565b336000908152602081905260408120805483919083906100b29084906101ac565b90915550506001600160a01b038316600090815260208190526040812080548492906100df9084906101bf565b90915550506040518281526001600160a01b0384169033907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200160405180910390a35060015b92915050565b80356001600160a01b038116811461014557600080fd5b919050565b60006020828403121561015c57600080fd5b6101658261012e565b9392505050565b6000806040838503121561017f57600080fd5b6101888361012e565b946020939093013593505050565b634e487b7160e01b600052601160045260246000fd5b8181038181111561012857610128610196565b808201808211156101285761012861019656fea26469706673582212201d2bc45da716cfad41922279632d9b5066992ec2d8436c2aca827c3bf1d4369164736f6c63430008250033'
const TOKEN_ABI = [
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]

function findAnvil(): string | undefined {
  if (process.env.ANVIL_BIN && existsSync(process.env.ANVIL_BIN))
    return process.env.ANVIL_BIN
  try {
    const root = dirname(
      dirname(require.resolve('@foundry-rs/anvil/package.json')),
    )
    const arch = process.arch === 'x64' ? 'amd64' : process.arch
    const packaged = join(root, `anvil-${process.platform}-${arch}`, 'bin', 'anvil')
    if (existsSync(packaged)) return packaged
  } catch {
    // Not installed as a package.
  }
  return spawnSync('anvil', ['--version']).status === 0 ? 'anvil' : undefined
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
/** anvil's first and second well-known development accounts. */
const DEV_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const OTHER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

/** The calls the relay serves, and how (see `validate_call`). */
function relayServes(call: { method: string; params: unknown[] }): boolean {
  if (call.method === 'eth_getBlockByNumber') return call.params[1] === false
  if (call.method === 'eth_getLogs') {
    const filter = call.params[0] as { fromBlock?: unknown; toBlock?: unknown }
    if (typeof filter.fromBlock !== 'string' || typeof filter.toBlock !== 'string')
      return false
    const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n
    return span >= 1n && span <= 10n
  }
  return [
    'eth_chainId',
    'eth_blockNumber',
    'eth_getBalance',
    'eth_getTransactionCount',
    'eth_call',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
  ].includes(call.method)
}

const anvilBin = findAnvil()
if (!anvilBin)
  // eslint-disable-next-line no-console
  console.warn('NOT RUN: evm-deposit-scan.anvil needs an anvil binary (set ANVIL_BIN).')
const suite = anvilBin ? describe : describe.skip

suite('deposits from outside Frank (anvil)', () => {
  jest.setTimeout(120_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  let other: Wallet
  let token: Contract
  let tokens: EvmDepositToken[]
  const dirs: string[] = []
  const requests: { method: string; params: unknown[] }[] = []
  const rpc = {
    send: (method: string, params: unknown[]) => {
      requests.push({ method, params })
      return chain.send(method, params)
    },
  }
  const mine = async (blocks: number) => {
    for (let i = 0; i < blocks; i++) await chain.send('evm_mine', [])
  }
  const scanner = (
    store: LevelRecordStore<EvmDepositRow> | MemoryRecordStore<EvmDepositRow>,
    watched: string[],
    own: string[] = [],
    known: string[] = [],
  ) =>
    new EvmDepositScanner({
      chainIdentifier: 'monad-testnet',
      rpc,
      store,
      watched: () => watched,
      tokens,
      isOwnAccount: address => own.includes(address),
      knownTransactions: () => new Set(known),
    })
  const level = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frank-deposits-'))
    dirs.push(dir)
    return {
      dir,
      store: await LevelRecordStore.open<EvmDepositRow>(dir, EVM_EXTERNAL_DEPOSITS_NAMESPACE),
    }
  }

  beforeAll(async () => {
    const port = await freePort()
    node = spawn(anvilBin!, ['--port', String(port), '--chain-id', '10143'], {
      stdio: 'ignore',
    })
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
    for (let i = 0; ; i++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (i > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    dev = new Wallet(DEV_KEY, chain)
    other = new Wallet(OTHER_KEY, chain)
    const deployed = await (
      await dev.sendTransaction({ data: TOKEN_BYTECODE })
    ).wait()
    token = new Contract(deployed!.contractAddress!, TOKEN_ABI, dev)
    tokens = [
      { contract: deployed!.contractAddress!.toLowerCase(), symbol: 'TT', decimals: 18 },
    ]
  })
  afterAll(() => {
    chain?.destroy()
    node?.kill()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('lists a plain transfer and a token transfer once, with their amounts, hashes and blocks, using only calls the relay serves', async () => {
    const watched = Wallet.createRandom().address.toLowerCase()
    // Deposits made before the wallet first looks are found: the first scan starts in the past.
    const plain = await (
      await dev.sendTransaction({ to: watched, value: parseEther('1.5') })
    ).wait()
    await mine(7)
    const tokenTx = await (await token.transfer!(watched, 42n * 10n ** 18n)).wait()
    await mine(5)
    const { store } = await level()
    requests.length = 0
    const scan = scanner(store, [watched])
    await scan.refresh()

    expect(requests.filter(call => !relayServes(call))).toEqual([])
    const blocks = new Map(
      await Promise.all(
        [plain!.blockNumber, tokenTx!.blockNumber].map(
          async n => [n, (await chain.getBlock(n))!] as const,
        ),
      ),
    )
    expect(scan.deposits()).toEqual([
      {
        id: `${tokenTx!.hash.toLowerCase()}:log:${tokenTx!.logs[0]!.index}`,
        chainIdentifier: 'monad-testnet',
        txHash: tokenTx!.hash.toLowerCase(),
        logIndex: tokenTx!.logs[0]!.index,
        to: watched,
        from: dev.address.toLowerCase(),
        asset: { kind: 'erc20', contract: tokens[0]!.contract, symbol: 'TT', decimals: 18 },
        amount: (42n * 10n ** 18n).toString(),
        blockNumber: tokenTx!.blockNumber,
        blockHash: tokenTx!.blockHash.toLowerCase(),
        blockTimeMs: blocks.get(tokenTx!.blockNumber)!.timestamp * 1000,
      },
      {
        id: `${plain!.hash.toLowerCase()}:native`,
        chainIdentifier: 'monad-testnet',
        txHash: plain!.hash.toLowerCase(),
        to: watched,
        from: dev.address.toLowerCase(),
        asset: { kind: 'native' },
        amount: parseEther('1.5').toString(),
        blockNumber: plain!.blockNumber,
        blockHash: plain!.blockHash.toLowerCase(),
        blockTimeMs: blocks.get(plain!.blockNumber)!.timestamp * 1000,
      },
    ])
    // Only changed blocks are read; native evidence adds two canonical binding reads.
    expect(
      requests
        .filter(call => call.method === 'eth_getBlockByNumber')
        .map(call => Number(BigInt(call.params[0] as string)))
        .sort(),
    ).toEqual([plain!.blockNumber, plain!.blockNumber, plain!.blockNumber, tokenTx!.blockNumber].sort())

    // Nothing new: the next refresh reads no block and lists the same deposits.
    requests.length = 0
    await scan.refresh()
    expect(requests.map(call => call.method)).not.toContain('eth_getBlockByNumber')
    expect(scan.deposits()).toHaveLength(2)
  })

  it('reads own-origin evidence below an explicit canonical maximum, independently of history filters', async () => {
    const watched = Wallet.createRandom().address.toLowerCase()
    const receipt = await (
      await dev.sendTransaction({ to: watched, value: 12345n })
    ).wait()
    const options = {
      rpc,
      chainIdentifier: 'monad-testnet',
      address: watched,
      blockNumber: receipt!.blockNumber,
      maximumBlock: receipt!.blockNumber,
    }
    expect(await readCanonicalNativeTransfers(options)).toEqual([
      expect.objectContaining({
        txHash: receipt!.hash.toLowerCase(),
        from: dev.address.toLowerCase(),
        to: watched,
        amount: '12345',
        blockHash: receipt!.blockHash.toLowerCase(),
      }),
    ])
    await expect(
      readCanonicalNativeTransfers({
        ...options,
        maximumBlock: receipt!.blockNumber - 1,
      }),
    ).rejects.toThrow('maximum head')
    const scan = scanner(
      new MemoryRecordStore<EvmDepositRow>(),
      [watched],
      [dev.address.toLowerCase()],
    )
    await scan.refresh()
    expect(scan.deposits()).toEqual([])
  })

  it('retains canonical unprotected legacy deposits without a transaction chain ID', async () => {
    const watched = Wallet.createRandom().address.toLowerCase()
    const raw = await dev.signTransaction({
      type: 0, chainId: 0, nonce: await chain.getTransactionCount(dev.address, 'pending'),
      to: watched, value: 123n, gasLimit: 21000n,
      gasPrice: (await chain.getFeeData()).gasPrice!,
    })
    const receipt = await (await chain.broadcastTransaction(raw)).wait()
    const facts = await readCanonicalNativeTransfers({ rpc, chainIdentifier: 'monad-testnet',
      address: watched, blockNumber: receipt!.blockNumber, maximumBlock: receipt!.blockNumber })
    expect(facts).toEqual([expect.objectContaining({ txHash: receipt!.hash.toLowerCase(), amount: '123' })])
  })

  it('a restart reads no block again and lists nothing twice; two devices list the same rows', async () => {
    const watched = Wallet.createRandom().address.toLowerCase()
    await (await dev.sendTransaction({ to: watched, value: parseEther('0.25') })).wait()
    await mine(3)
    const first = await level()
    await scanner(first.store, [watched]).refresh()
    expect(scanner(first.store, [watched]).deposits()).toHaveLength(1)
    await first.store.close()

    // The same wallet opened again from disk, after another deposit.
    const second = await (await other.sendTransaction({ to: watched, value: parseEther('0.75') })).wait()
    await mine(2)
    const reopened = await LevelRecordStore.open<EvmDepositRow>(
      first.dir,
      EVM_EXTERNAL_DEPOSITS_NAMESPACE,
    )
    requests.length = 0
    const scan = scanner(reopened, [watched])
    await scan.refresh()
    const read = requests
      .filter(call => call.method === 'eth_getBlockByNumber')
      .map(call => Number(BigInt(call.params[0] as string)))
    expect(read).toEqual([second!.blockNumber, second!.blockNumber, second!.blockNumber])
    const rows = scan.deposits()
    expect(rows.map(row => row.amount)).toEqual([
      parseEther('0.75').toString(),
      parseEther('0.25').toString(),
    ])
    expect(new Set(rows.map(row => row.id)).size).toBe(2)

    // Another device of the account, with its own store, computes the same rows from the chain.
    const device = scanner(new MemoryRecordStore<EvmDepositRow>(), [watched])
    await device.refresh()
    expect(device.deposits()).toEqual(rows)
    await reopened.close()
  })

  it('does not list the wallet moving its own money, a Frank payment it already knows, or a send from the address', async () => {
    const watched = new Wallet(Wallet.createRandom().privateKey, chain)
    const address = watched.address.toLowerCase()
    const own = new Wallet(Wallet.createRandom().privateKey, chain)
    await (await dev.sendTransaction({ to: own.address, value: parseEther('1') })).wait()
    const store = new MemoryRecordStore<EvmDepositRow>()
    const known: string[] = []
    const scan = scanner(store, [address], [own.address.toLowerCase()], known)
    await scan.refresh()

    const fromOwn = await (await own.sendTransaction({ to: address, value: parseEther('0.5') })).wait()
    const frank = await (await dev.sendTransaction({ to: address, value: parseEther('1') })).wait()
    known.push(frank!.hash.toLowerCase())
    await mine(2)
    // The address sends; then an outside deposit after it is still found.
    await (await watched.sendTransaction({ to: dev.address, value: parseEther('0.2') })).wait()
    const outside = await (await other.sendTransaction({ to: address, value: parseEther('0.05') })).wait()
    await mine(2)
    await scan.refresh()
    expect(fromOwn!.status).toBe(1)
    expect(scan.deposits().map(row => [row.txHash, row.amount])).toEqual([
      [outside!.hash.toLowerCase(), parseEther('0.05').toString()],
    ])
  })

  it('an address that holds nothing starts at the head and reads nothing before it', async () => {
    const address = Wallet.createRandom().address.toLowerCase()
    const scan = scanner(new MemoryRecordStore<EvmDepositRow>(), [address])
    requests.length = 0
    await scan.refresh()
    const head = await chain.getBlockNumber()
    expect(scan.cursorOf(address)).toEqual({ block: head, scannedFrom: head, unreadable: [] })
    expect(
      requests.filter(
        call =>
          call.method !== 'eth_blockNumber' &&
          call.params[call.params.length - 1] !== `0x${head.toString(16)}`,
      ),
    ).toEqual([])
    expect(scan.deposits()).toEqual([])
  })
})

suite('deposits on a node that keeps only recent state (anvil --prune-history)', () => {
  jest.setTimeout(120_000)
  let node: ChildProcess
  let chain: JsonRpcProvider
  let dev: Wallet
  const rpc = {
    send: (method: string, params: unknown[]) => chain.send(method, params),
  }
  const mine = async (blocks: number) => {
    for (let i = 0; i < blocks; i++) await chain.send('evm_mine', [])
  }

  beforeAll(async () => {
    const port = await freePort()
    // Like a Monad node, it serves the state of recent blocks only.
    node = spawn(
      anvilBin!,
      ['--port', String(port), '--chain-id', '10143', '--prune-history', '20'],
      { stdio: 'ignore' },
    )
    chain = new JsonRpcProvider(`http://127.0.0.1:${port}`, 10143, {
      staticNetwork: true,
      cacheTimeout: -1,
    })
    for (let i = 0; ; i++) {
      try {
        await chain.getBlockNumber()
        break
      } catch (error) {
        if (i > 100) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    dev = new Wallet(DEV_KEY, chain)
  })
  afterAll(() => {
    chain?.destroy()
    node?.kill()
  })

  it('starts a first scan at the oldest block the node serves, and records blocks it can no longer read', async () => {
    const address = Wallet.createRandom().address.toLowerCase()
    const old = await (await dev.sendTransaction({ to: address, value: 1000n })).wait()
    await mine(40)
    const recent = await (await dev.sendTransaction({ to: address, value: 2000n })).wait()
    await mine(2)
    const scan = new EvmDepositScanner({
      chainIdentifier: 'monad-testnet',
      rpc,
      store: new MemoryRecordStore<EvmDepositRow>(),
      watched: () => [address],
      tokens: [],
      isOwnAccount: () => false,
    })
    await scan.refresh()
    const first = scan.cursorOf(address)!
    // Nothing before the node's oldest served block is listed; what came after it is.
    expect(first.scannedFrom).toBeGreaterThan(old!.blockNumber)
    expect(first.scannedFrom).toBeLessThan(recent!.blockNumber)
    expect(scan.deposits().map(row => row.txHash)).toEqual([recent!.hash.toLowerCase()])

    // The wallet is closed for longer than the node keeps state: the blocks it can no longer
    // read are recorded as passed over, and what arrives after them is still listed.
    await (await dev.sendTransaction({ to: address, value: 3000n })).wait()
    await mine(40)
    const later = await (await dev.sendTransaction({ to: address, value: 4000n })).wait()
    await mine(2)
    await scan.refresh()
    const cursor = scan.cursorOf(address)!
    expect(cursor.unreadable).toHaveLength(1)
    expect(cursor.unreadable[0]![0]).toBe(first.block + 1)
    expect(scan.deposits().map(row => row.txHash)).toEqual([
      later!.hash.toLowerCase(),
      recent!.hash.toLowerCase(),
    ])
  })
})
