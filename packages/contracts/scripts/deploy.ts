/**
 * Deploys GenericHTLC and StateChannel and records where they went.
 *
 *   yarn --cwd packages/contracts deploy --chain monad-testnet --rpc <url> --wallet-json <file> --dry-run
 *   yarn --cwd packages/contracts deploy --chain monad-testnet --rpc <url> --wallet-json <file>
 *   yarn --cwd packages/contracts deploy --local --rpc http://127.0.0.1:8545 --out-dir <dir>
 *
 * `--chain` is a canonical `chainIdentifier` from docs/protocol/chains/v1.json that the
 * registry marks as a testnet (any other network is refused); the node must report that
 * row's native chain id. `--local` is for a local dev node (chain id 31337) and
 * needs `--out-dir`, so a local run can never write a public network's record.
 * `--wallet-json` is a file `{"address","privateKey"}`, the format of the demo funding wallet.
 *
 * What is deployed is the checked-in bytecode in `artifacts/` (the bytecode the tests run).
 * The address reported is read back from the chain: the record is written only after
 * `eth_getCode` at that address returns exactly the artifact's runtime code.
 *
 * Output: `deployments/<chainIdentifier>.json`. After a deployment, list the new record in
 * `deployments/index.ts`: the wallet's chain registry
 * (packages/wallet/chain/chains-registry.ts) takes each network's contract addresses from
 * there, and a network without a record has no contract address.
 */
import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import GenericHTLCArtifact from '../artifacts/GenericHTLC.json'
import StateChannelArtifact from '../artifacts/StateChannel.json'
import protocolChains from '../../../docs/protocol/chains/v1.json'
import type {
  ContractDeployment,
  DeployedContractName,
  DeploymentRecord,
} from '../deployments'

export type { ContractDeployment, DeployedContractName, DeploymentRecord }

/**
 * The deterministic deployment proxy (github.com/Arachnid/deterministic-deployment-proxy).
 * It has no ABI: the calldata is `salt (32 bytes) ++ initcode`, and it CREATE2s the initcode.
 */
export const DETERMINISTIC_DEPLOYMENT_PROXY =
  '0x4e59b44847b379578588920cA78FbF26c0B4956C'
export const DEPLOY_SALT = ethers.id('frank.contracts.v1')
export const LOCAL_DEV_CHAIN_ID = 31337n
/** The first account of the standard dev-node mnemonic ("test test ... junk"). Local only. */
const LOCAL_DEV_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const ARTIFACTS: Record<
  DeployedContractName,
  {
    bytecode: string
    deployedBytecode: string
    compiler: ContractDeployment['compiler']
  }
> = {
  GenericHTLC: GenericHTLCArtifact,
  StateChannel: StateChannelArtifact,
}
const CONTRACT_NAMES = Object.keys(ARTIFACTS) as DeployedContractName[]

export interface DeploymentPlanItem {
  contract: DeployedContractName
  deployedVia: 'create2-proxy' | 'create'
  /** Known in advance only for CREATE2; a plain create address depends on the nonce. */
  predictedAddress?: string
  alreadyDeployed: boolean
  transaction?: { to: string | null; data: string; gasLimit: bigint }
}

export function predictCreate2Address(
  initCode: string,
  salt: string = DEPLOY_SALT,
): string {
  return ethers.getCreate2Address(
    DETERMINISTIC_DEPLOYMENT_PROXY,
    salt,
    ethers.keccak256(initCode),
  )
}

async function hasCode(provider: ethers.Provider, address: string) {
  return (await provider.getCode(address)) !== '0x'
}

/** Works out what would be sent, without sending anything. */
export async function planDeployment(
  provider: ethers.Provider,
  deployer: string,
  salt: string = DEPLOY_SALT,
): Promise<DeploymentPlanItem[]> {
  const viaProxy = await hasCode(provider, DETERMINISTIC_DEPLOYMENT_PROXY)
  const plan: DeploymentPlanItem[] = []
  for (const contract of CONTRACT_NAMES) {
    const initCode = ARTIFACTS[contract].bytecode
    const request = viaProxy
      ? {
          to: DETERMINISTIC_DEPLOYMENT_PROXY,
          data: ethers.concat([salt, initCode]),
        }
      : { to: null, data: initCode }
    const predictedAddress = viaProxy
      ? predictCreate2Address(initCode, salt)
      : undefined
    if (predictedAddress && (await hasCode(provider, predictedAddress))) {
      plan.push({
        contract,
        deployedVia: 'create2-proxy',
        predictedAddress,
        alreadyDeployed: true,
      })
      continue
    }
    // Some chains (Monad) charge for the gas limit rather than the gas used, so the margin
    // over the estimate is kept small.
    const estimate = await provider.estimateGas({ ...request, from: deployer })
    plan.push({
      contract,
      deployedVia: viaProxy ? 'create2-proxy' : 'create',
      predictedAddress,
      alreadyDeployed: false,
      transaction: { ...request, gasLimit: (estimate * 105n) / 100n },
    })
  }
  return plan
}

const NONCE_TAKEN = new Set([
  'NONCE_EXPIRED',
  'REPLACEMENT_UNDERPRICED',
  'TRANSACTION_REPLACED',
])

/**
 * Returns a function that sends one transaction and resolves with its successful receipt.
 *
 * The wallet may be shared with other processes, so the pending nonce is read immediately
 * before each send, never below one past the last nonce this sender saw confirmed (a node
 * can lag). When the node refuses the nonce, or another transaction is mined at it, ours
 * did not land: the nonce is read again and the transaction is sent again.
 */
export function confirmedSender(signer: ethers.Signer) {
  let floor = 0
  return async (
    request: ethers.TransactionRequest,
    onSent?: (hash: string) => void,
  ): Promise<ethers.TransactionReceipt> => {
    const from = await signer.getAddress()
    for (let attempt = 1; ; attempt++) {
      const pending = await signer.provider!.getTransactionCount(from, 'pending')
      const nonce = Math.max(pending, floor)
      try {
        const tx = await signer.sendTransaction({ ...request, nonce })
        onSent?.(tx.hash)
        const receipt = await tx.wait()
        if (!receipt || receipt.status !== 1) {
          throw new Error(`transaction ${tx.hash} failed`)
        }
        floor = nonce + 1
        return receipt
      } catch (err) {
        const code = (err as { code?: string }).code
        const repriced = (err as { reason?: string }).reason === 'repriced'
        if (!code || !NONCE_TAKEN.has(code) || repriced || attempt >= 6) throw err
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  }
}

type ContractEntries = Partial<Record<DeployedContractName, ContractDeployment>>

function readEntries(file: string): ContractEntries {
  if (!fs.existsSync(file)) return {}
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentRecord).contracts
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Deploys both contracts from `signer` and writes `<outDir>/<chainIdentifier>.json`.
 * An address is recorded only once it holds the artifact's runtime code.
 *
 * Each contract is noted in `<chainIdentifier>.partial.json` as soon as it is verified, so a
 * run that stops between the two (no funds, a dropped connection) is finished by running the
 * same command again; the record itself is written only when both are deployed.
 */
export async function deployContracts(options: {
  signer: ethers.Signer
  chainIdentifier: string
  outDir: string
  salt?: string
  log?: (line: string) => void
}): Promise<DeploymentRecord> {
  const { signer, chainIdentifier, outDir } = options
  const salt = options.salt ?? DEPLOY_SALT
  const log = options.log ?? (() => undefined)
  const provider = signer.provider
  if (!provider) throw new Error('The deployer signer has no provider')
  const deployer = await signer.getAddress()
  const { chainId } = await provider.getNetwork()
  const recordFile = path.join(outDir, `${chainIdentifier}.json`)
  const partialFile = path.join(outDir, `${chainIdentifier}.partial.json`)
  const existing = { ...readEntries(recordFile), ...readEntries(partialFile) }
  const base = { chainIdentifier, chainId: chainId.toString() }

  const plan = await planDeployment(provider, deployer, salt)
  const contracts = {} as Record<DeployedContractName, ContractDeployment>
  const send = confirmedSender(signer)
  for (const item of plan) {
    const artifact = ARTIFACTS[item.contract]
    const previous = existing[item.contract]
    if (item.alreadyDeployed && previous?.address !== item.predictedAddress) {
      throw new Error(
        `${item.contract} already has code at ${item.predictedAddress} on ${chainIdentifier}, but ${recordFile} does not record that deployment. Find its transaction and record it by hand.`,
      )
    }
    // Recorded by an earlier run (through the proxy or by a plain create): keep it if the
    // code is still there, instead of deploying a second copy.
    if (previous && (await provider.getCode(previous.address)) === artifact.deployedBytecode) {
      contracts[item.contract] = previous
      log(`${item.contract}: already deployed at ${previous.address}`)
      continue
    }

    const receipt = await send(item.transaction!, hash =>
      log(`${item.contract}: sent ${hash}`),
    )
    const tx = { hash: receipt.hash }
    const address = item.predictedAddress ?? receipt.contractAddress
    if (!address) {
      throw new Error(`${item.contract}: ${tx.hash} created no contract`)
    }
    await requireRuntimeCode(provider, address, item.contract, receipt.blockNumber)
    contracts[item.contract] = {
      address: ethers.getAddress(address),
      deployer,
      deployedVia: item.deployedVia,
      transactionHash: tx.hash,
      blockNumber: receipt.blockNumber,
      initCodeHash: ethers.keccak256(artifact.bytecode),
      runtimeCodeHash: ethers.keccak256(artifact.deployedBytecode),
      compiler: artifact.compiler,
    }
    log(`${item.contract}: deployed at ${address} in block ${receipt.blockNumber}`)
    writeJson(partialFile, { ...base, contracts })
  }

  const usedProxy = Object.values(contracts).some(
    c => c.deployedVia === 'create2-proxy',
  )
  const record: DeploymentRecord = {
    ...base,
    ...(usedProxy
      ? { create2: { proxy: DETERMINISTIC_DEPLOYMENT_PROXY, salt } }
      : {}),
    contracts,
  }
  writeJson(recordFile, record)
  fs.rmSync(partialFile, { force: true })
  log(`Wrote ${recordFile}`)
  return record
}

/**
 * Reads the code back after a deployment and requires it to be the artifact's runtime code.
 * The read is pinned to the transaction's block and repeated for a minute, because the node
 * that answers may not have that block yet.
 */
async function requireRuntimeCode(
  provider: ethers.Provider,
  address: string,
  contract: DeployedContractName,
  minedInBlock: number,
) {
  const expected = ARTIFACTS[contract].deployedBytecode
  const deadline = Date.now() + 60_000
  let seen = ''
  for (;;) {
    try {
      const code = await provider.getCode(address, minedInBlock)
      if (code === expected) return
      seen = code === '0x' ? 'empty' : 'not the artifact runtime code'
    } catch (err) {
      seen = `unreadable (${(err as Error).message})`
    }
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`${contract}: eth_getCode at ${address} is ${seen}`)
}

/**
 * Reads a `{"address","privateKey"}` wallet file and checks the two agree. Errors never
 * carry anything read from the file: a parser's message can quote the text it choked on.
 */
export function loadWalletJson(file: string): ethers.Wallet {
  let parsed: { address?: unknown; privateKey?: unknown }
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    throw new Error(`${file} ${missing ? 'does not exist' : 'is not valid JSON'}`)
  }
  if (typeof parsed?.privateKey !== 'string') {
    throw new Error(`${file} has no privateKey`)
  }
  let wallet: ethers.Wallet
  try {
    wallet = new ethers.Wallet(parsed.privateKey)
  } catch {
    throw new Error(`${file}: privateKey is not a valid private key`)
  }
  if (
    typeof parsed.address !== 'string' ||
    parsed.address.toLowerCase() !== wallet.address.toLowerCase()
  ) {
    throw new Error(`${file}: address does not belong to privateKey`)
  }
  return wallet
}

/** The native chain id the protocol registry gives a canonical EVM testnet `chainIdentifier`. */
export function registryChainId(chainIdentifier: string): bigint {
  const row = protocolChains.chains.find(c => c.id === chainIdentifier)
  if (!row) {
    throw new Error(
      `"${chainIdentifier}" is not a chain identifier in docs/protocol/chains/v1.json`,
    )
  }
  if (row.family !== 'evm' || !('native_chain_id' in row)) {
    throw new Error(`"${chainIdentifier}" is not an EVM network`)
  }
  // Only testnets for now: nothing here has been approved for a network with real money.
  if (row.network !== 'testnet') {
    throw new Error(
      `"${chainIdentifier}" is a ${row.network} network; these scripts only deploy to testnets`,
    )
  }
  return BigInt(row.native_chain_id as string)
}

/**
 * The provider the scripts use. ethers answers a repeated read from a short cache by
 * default; a script that reads, sends and reads again must see the chain each time.
 */
export function createProvider(rpcUrl: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 })
}

export interface CliTarget {
  provider: ethers.JsonRpcProvider
  signer: ethers.Wallet
  chainIdentifier: string
  outDir: string
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/** Resolves `--chain`/`--local`, `--rpc`, `--wallet-json` and `--out-dir`, checking chain identity. */
export async function resolveCliTarget(
  argv: readonly string[],
): Promise<CliTarget> {
  const rpc = flag(argv, '--rpc')
  if (!rpc) throw new Error('--rpc <url> is required')
  const local = argv.includes('--local')
  const chain = flag(argv, '--chain')
  if (local === Boolean(chain)) {
    throw new Error('Give exactly one of --chain <chainIdentifier> or --local')
  }
  const walletJson = flag(argv, '--wallet-json')
  if (!local && !walletJson) throw new Error('--wallet-json <file> is required')
  const outDirFlag = flag(argv, '--out-dir')
  if (local && !outDirFlag) throw new Error('--local needs --out-dir <dir>')

  const provider = createProvider(rpc)
  const { chainId } = await provider.getNetwork()
  const expected = local ? LOCAL_DEV_CHAIN_ID : registryChainId(chain!)
  if (chainId !== expected) {
    throw new Error(
      `${rpc} reports chain id ${chainId}, expected ${expected} for ${
        chain ?? 'a local dev node'
      }`,
    )
  }
  const wallet = walletJson
    ? loadWalletJson(walletJson)
    : new ethers.Wallet(LOCAL_DEV_PRIVATE_KEY)
  return {
    provider,
    signer: wallet.connect(provider),
    chainIdentifier: chain ?? `local-${LOCAL_DEV_CHAIN_ID}`,
    outDir: outDirFlag
      ? path.resolve(outDirFlag)
      : path.resolve(__dirname, '../deployments'),
  }
}

async function main(argv: readonly string[]) {
  const target = await resolveCliTarget(argv)
  const { provider, signer, chainIdentifier } = target
  const plan = await planDeployment(provider, signer.address)
  const fees = await provider.getFeeData()
  const price = fees.maxFeePerGas ?? fees.gasPrice ?? 0n
  const balance = await provider.getBalance(signer.address)
  let total = 0n
  console.log(`Chain: ${chainIdentifier}`)
  console.log(`Deployer: ${signer.address}`)
  console.log(`Balance: ${ethers.formatEther(balance)}`)
  for (const item of plan) {
    if (!item.transaction) {
      console.log(`${item.contract}: already deployed at ${item.predictedAddress}`)
      continue
    }
    const cost = item.transaction.gasLimit * price
    total += cost
    console.log(
      `${item.contract}: ${item.deployedVia}, ${
        item.predictedAddress ?? 'address known after the transaction'
      }, gas limit ${item.transaction.gasLimit}, at most ${ethers.formatEther(cost)}`,
    )
  }
  console.log(
    `Total at most: ${ethers.formatEther(total)} (at ${ethers.formatUnits(price, 'gwei')} gwei)`,
  )
  if (argv.includes('--dry-run')) return
  if (balance < total) {
    throw new Error('The deployer cannot pay for the deployment')
  }
  await deployContracts({
    signer,
    chainIdentifier,
    outDir: target.outDir,
    log: line => console.log(line),
  })
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`Deployment failed: ${(err as Error).message}`)
    process.exit(1)
  })
}
