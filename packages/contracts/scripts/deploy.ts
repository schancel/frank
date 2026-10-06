import * as fs from 'fs'
import * as path from 'path'
import { ethers } from 'ethers'
import { compileContracts } from './compile'

export const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const CREATE2_FACTORY_ABI = [
  'function deploy(bytes memory initCode, bytes32 salt) public returns (address)',
]

export interface DeploymentRecord {
  network: string
  chainId: number
  deployer: string
  contracts: {
    GenericHTLC: { address: string; deployedVia: 'create2' | 'standard' }
    StateChannel: { address: string; deployedVia: 'create2' | 'standard' }
  }
  timestamp: string
}

export async function deployAll(options?: {
  rpcUrl?: string
  privateKey?: string
  networkName?: string
  useCreate2?: boolean
  salt?: string
}): Promise<DeploymentRecord> {
  const artifacts = compileContracts()

  const rpcUrl =
    options?.rpcUrl ||
    process.env.RPC_URL ||
    process.env.MONAD_RPC_URL ||
    'http://127.0.0.1:8545'
  const privateKey =
    options?.privateKey ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    // standard hardhat test key
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)
  const network = await provider.getNetwork()
  const chainId = Number(network.chainId)
  const networkName =
    options?.networkName || process.env.NETWORK || `chain-${chainId}`

  const salt =
    options?.salt ||
    process.env.SALT ||
    ethers.id('frank.contracts.v1')
  const useCreate2 = options?.useCreate2 ?? (process.env.USE_CREATE2 === 'true')

  console.log(`\n--- Starting deployment on ${networkName} (Chain ID: ${chainId}) ---`)
  console.log(`Deployer address: ${wallet.address}`)

  const deploymentsDir = path.resolve(__dirname, '../deployments')
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true })
  }

  const deployedAddresses: Record<string, { address: string; deployedVia: 'create2' | 'standard' }> = {}

  for (const contractName of ['GenericHTLC', 'StateChannel'] as const) {
    const artifact = artifacts[contractName]
    if (!artifact) throw new Error(`Artifact for ${contractName} not found`)

    let deployedAddress: string
    let deployedVia: 'create2' | 'standard' = 'standard'

    if (useCreate2) {
      try {
        const factoryCode = await provider.getCode(CREATE2_FACTORY)
        if (factoryCode && factoryCode !== '0x') {
          console.log(`Deploying ${contractName} via CREATE2 factory...`)
          const factory = new ethers.Contract(CREATE2_FACTORY, CREATE2_FACTORY_ABI, wallet)
          const tx = await factory.deploy(artifact.bytecode, salt)
          await tx.wait()
          // Compute deterministic address
          const contractSalt = ethers.keccak256(salt)
          const initCodeHash = ethers.keccak256(artifact.bytecode)
          deployedAddress = ethers.getCreate2Address(CREATE2_FACTORY, contractSalt, initCodeHash)
          deployedVia = 'create2'
          console.log(`✓ ${contractName} deployed via CREATE2 at: ${deployedAddress}`)
        } else {
          console.log(`CREATE2 factory not present at ${CREATE2_FACTORY}, using standard deployment.`)
          deployedAddress = await deployStandard(wallet, artifact)
        }
      } catch (err) {
        console.warn(`CREATE2 deploy failed (${(err as Error).message}), falling back to standard...`)
        deployedAddress = await deployStandard(wallet, artifact)
      }
    } else {
      deployedAddress = await deployStandard(wallet, artifact)
    }

    deployedAddresses[contractName] = { address: deployedAddress, deployedVia }
  }

  const record: DeploymentRecord = {
    network: networkName,
    chainId,
    deployer: wallet.address,
    contracts: deployedAddresses as DeploymentRecord['contracts'],
    timestamp: new Date().toISOString(),
  }

  const recordFile = path.join(deploymentsDir, `${networkName}.json`)
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2), 'utf8')
  console.log(`\nDeployment manifest saved to ${recordFile}`)

  return record
}

async function deployStandard(
  wallet: ethers.Wallet,
  artifact: { abi: any[]; bytecode: string; contractName?: string },
): Promise<string> {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet)
  const contract = await factory.deploy()
  await contract.waitForDeployment()
  const address = await contract.getAddress()
  console.log(`✓ ${artifact.contractName} deployed standard at: ${address}`)
  return address
}

if (require.main === module) {
  deployAll().catch(err => {
    console.error('Deployment failed:', err)
    process.exit(1)
  })
}
