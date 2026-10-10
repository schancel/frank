/**
 * The deploy script, run against a local anvil node: the address it reports is the address
 * that holds the code.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ethers } from 'ethers'
import { GenericHTLC, StateChannel } from '../index'
import { compileSolidity } from '../scripts/compile'
import {
  DEPLOY_SALT,
  DETERMINISTIC_DEPLOYMENT_PROXY,
  createProvider,
  deployContracts,
  planDeployment,
  predictCreate2Address,
  registryChainId,
  resolveCliTarget,
} from '../scripts/deploy'
import { htlcRound } from '../scripts/htlc-round'
import { startAnvil, type Anvil } from './anvil'

describe('deploying to a local EVM node', () => {
  let anvil: Anvil
  let outDir: string

  beforeEach(async () => {
    anvil = await startAnvil()
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-deployments-'))
  }, 60_000)

  afterEach(async () => {
    await anvil.stop()
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('checked-in artifacts are what the sources compile to', () => {
    const compiled = compileSolidity([path.resolve(__dirname, '../contracts')])
    expect(compiled.GenericHTLC).toEqual(GenericHTLC)
    expect(compiled.StateChannel).toEqual(StateChannel)
  })

  it('deploys through the deterministic deployment proxy to the predicted addresses', async () => {
    // The provider the command line uses.
    const cliProvider = createProvider(anvil.url)
    const deployer = anvil.accounts[0].connect(cliProvider)
    expect(await anvil.provider.getCode(DETERMINISTIC_DEPLOYMENT_PROXY)).not.toBe('0x')
    const predicted = {
      GenericHTLC: predictCreate2Address(GenericHTLC.bytecode),
      StateChannel: predictCreate2Address(StateChannel.bytecode),
    }
    expect(await anvil.provider.getCode(predicted.GenericHTLC)).toBe('0x')

    const record = await deployContracts({
      signer: deployer,
      chainIdentifier: 'local-31337',
      outDir,
    })

    expect(record.contracts.GenericHTLC.address).toBe(predicted.GenericHTLC)
    expect(record.contracts.StateChannel.address).toBe(predicted.StateChannel)
    expect(await anvil.provider.getCode(predicted.GenericHTLC)).toBe(GenericHTLC.deployedBytecode)
    expect(await anvil.provider.getCode(predicted.StateChannel)).toBe(StateChannel.deployedBytecode)

    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'local-31337.json'), 'utf8'))
    expect(written).toEqual(record)
    expect(written).toMatchObject({
      chainIdentifier: 'local-31337',
      chainId: '31337',
      create2: { proxy: DETERMINISTIC_DEPLOYMENT_PROXY, salt: DEPLOY_SALT },
    })
    for (const [name, artifact] of [
      ['GenericHTLC', GenericHTLC],
      ['StateChannel', StateChannel],
    ] as const) {
      const entry = written.contracts[name]
      const receipt = await anvil.provider.getTransactionReceipt(entry.transactionHash)
      expect(receipt?.status).toBe(1)
      expect(receipt?.to).toBe(DETERMINISTIC_DEPLOYMENT_PROXY)
      expect(entry).toMatchObject({
        deployer: deployer.address,
        deployedVia: 'create2-proxy',
        blockNumber: receipt?.blockNumber,
        initCodeHash: ethers.keccak256(artifact.bytecode),
        runtimeCodeHash: ethers.keccak256(artifact.deployedBytecode),
        compiler: artifact.compiler,
      })
    }

    // The deployed HTLC works: lock and withdraw, then lock and refund after the timelock.
    const round = await htlcRound({
      signer: deployer,
      htlcAddress: record.contracts.GenericHTLC.address,
      refundAfterSeconds: 2,
    })
    for (const hash of Object.values(round)) {
      expect((await anvil.provider.getTransactionReceipt(hash))?.status).toBe(1)
    }
    expect(await anvil.provider.getBalance(record.contracts.GenericHTLC.address)).toBe(0n)

    // A second run sends nothing and keeps the record.
    const nonce = await anvil.provider.getTransactionCount(deployer.address)
    const again = await deployContracts({ signer: deployer, chainIdentifier: 'local-31337', outDir })
    expect(again).toEqual(record)
    expect(await anvil.provider.getTransactionCount(deployer.address)).toBe(nonce)
    cliProvider.destroy()
  }, 60_000)

  it('finishes a deployment that stopped after the first contract when run again', async () => {
    const deployer = ethers.Wallet.createRandom().connect(anvil.provider)
    const setBalance = (ether: string) =>
      anvil.provider.send('anvil_setBalance', [
        deployer.address,
        ethers.toBeHex(ethers.parseEther(ether)),
      ])
    const options = { signer: deployer, chainIdentifier: 'local-31337', outDir }
    const recordFile = path.join(outDir, 'local-31337.json')
    const partialFile = path.join(outDir, 'local-31337.partial.json')

    // Enough for one contract, not for two.
    await setBalance('0.006')
    await expect(deployContracts(options)).rejects.toThrow()
    expect(fs.existsSync(recordFile)).toBe(false)
    const partial = JSON.parse(fs.readFileSync(partialFile, 'utf8'))
    expect(Object.keys(partial.contracts)).toEqual(['GenericHTLC'])
    expect(await anvil.provider.getCode(partial.contracts.GenericHTLC.address)).toBe(
      GenericHTLC.deployedBytecode,
    )
    expect(await anvil.provider.getTransactionCount(deployer.address)).toBe(1)

    await setBalance('1')
    const record = await deployContracts(options)
    expect(await anvil.provider.getTransactionCount(deployer.address)).toBe(2)
    expect(record.contracts.GenericHTLC).toEqual(partial.contracts.GenericHTLC)
    expect(await anvil.provider.getCode(record.contracts.StateChannel.address)).toBe(
      StateChannel.deployedBytecode,
    )
    expect(JSON.parse(fs.readFileSync(recordFile, 'utf8'))).toEqual(record)
    expect(fs.existsSync(partialFile)).toBe(false)
  }, 60_000)

  it('refuses to record code it finds at the predicted address without a deployment record', async () => {
    const [deployer] = anvil.accounts
    await deployContracts({ signer: deployer, chainIdentifier: 'local-31337', outDir })
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-deployments-'))
    await expect(
      deployContracts({ signer: deployer, chainIdentifier: 'local-31337', outDir: otherDir }),
    ).rejects.toThrow(/does not record that deployment/)
    expect(fs.readdirSync(otherDir)).toEqual([])
    fs.rmSync(otherDir, { recursive: true, force: true })
  }, 60_000)

  it('deploys with a plain create transaction where the proxy does not exist', async () => {
    const [deployer] = anvil.accounts
    await anvil.provider.send('anvil_setCode', [DETERMINISTIC_DEPLOYMENT_PROXY, '0x'])
    const plan = await planDeployment(anvil.provider, deployer.address)
    expect(plan.map(item => [item.deployedVia, item.predictedAddress])).toEqual([
      ['create', undefined],
      ['create', undefined],
    ])

    const record = await deployContracts({ signer: deployer, chainIdentifier: 'local-31337', outDir })

    expect(record.create2).toBeUndefined()
    const { GenericHTLC: htlc, StateChannel: channel } = record.contracts
    expect(htlc.deployedVia).toBe('create')
    expect(htlc.address).not.toBe(predictCreate2Address(GenericHTLC.bytecode))
    expect((await anvil.provider.getTransactionReceipt(htlc.transactionHash))?.contractAddress).toBe(
      htlc.address,
    )
    expect(await anvil.provider.getCode(htlc.address)).toBe(GenericHTLC.deployedBytecode)
    expect(await anvil.provider.getCode(channel.address)).toBe(StateChannel.deployedBytecode)

    // A second run finds the recorded contracts and does not deploy second copies.
    const nonce = await anvil.provider.getTransactionCount(deployer.address)
    expect(
      await deployContracts({ signer: deployer, chainIdentifier: 'local-31337', outDir }),
    ).toEqual(record)
    expect(await anvil.provider.getTransactionCount(deployer.address)).toBe(nonce)
  }, 60_000)

  it('takes a canonical chain identifier and refuses a node that is another chain', async () => {
    expect(registryChainId('monad-testnet')).toBe(10143n)
    expect(() => registryChainId('monad')).toThrow(/not a chain identifier/)
    expect(() => registryChainId('evm')).toThrow(/not a chain identifier/)
    expect(() => registryChainId('btc-mainnet')).toThrow(/not an EVM network/)

    const walletJson = path.join(outDir, 'wallet.json')
    const wallet = ethers.Wallet.createRandom()
    fs.writeFileSync(walletJson, JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }))
    await expect(
      resolveCliTarget(['--chain', 'monad-testnet', '--rpc', anvil.url, '--wallet-json', walletJson]),
    ).rejects.toThrow(/reports chain id 31337, expected 10143 for monad-testnet/)
    await expect(resolveCliTarget(['--local', '--rpc', anvil.url])).rejects.toThrow(/--out-dir/)
    await expect(
      resolveCliTarget(['--chain', 'monad-testnet', '--local', '--rpc', anvil.url]),
    ).rejects.toThrow(/exactly one/)

    const target = await resolveCliTarget(['--local', '--rpc', anvil.url, '--out-dir', outDir])
    expect(target.chainIdentifier).toBe('local-31337')
    expect(target.outDir).toBe(path.resolve(outDir))
    target.provider.destroy()
  }, 60_000)
})
