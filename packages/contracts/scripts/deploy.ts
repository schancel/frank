import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers, ContractFactory, JsonRpcProvider, Wallet, HDNodeWallet } from 'ethers';
import {
  ChannelVaultArtifact,
  TablePotVaultArtifact,
  GenericHTLCArtifact
} from '../src/artifacts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const deploymentsDir = path.resolve(packageRoot, 'deployments');

export interface DeploymentRecord {
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: string;
  contracts: {
    ChannelVault: {
      address: string;
      transactionHash: string;
    };
    TablePotVault: {
      address: string;
      transactionHash: string;
    };
    GenericHTLC: {
      address: string;
      transactionHash: string;
    };
  };
}

export async function deployContracts(options: {
  rpcUrl?: string;
  privateKeyOrMnemonic?: string;
  networkName?: string;
} = {}): Promise<DeploymentRecord> {
  const rpcUrl = options.rpcUrl || process.env.RPC_URL || 'http://127.0.0.1:18545';
  const provider = new JsonRpcProvider(rpcUrl);

  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const networkName = options.networkName || (chainId === 10143 ? 'monad-testnet' : chainId === 31337 ? 'local' : `chain-${chainId}`);

  let signer: Wallet | HDNodeWallet;
  const secret = options.privateKeyOrMnemonic || process.env.PRIVATE_KEY || process.env.DEV_MNEMONIC || 'test test test test test test test test test test test junk';

  if (secret.trim().includes(' ')) {
    signer = HDNodeWallet.fromPhrase(secret.trim()).connect(provider);
  } else {
    signer = new Wallet(secret.trim(), provider);
  }
  signer.getNonce = async () => {
    const hex = await provider.send('eth_getTransactionCount', [signer.address, 'latest']);
    return parseInt(hex, 16);
  };

  console.log(`\n========================================`);
  console.log(`Deploying Frank EVM Contracts`);
  console.log(`Network:   ${networkName} (Chain ID: ${chainId})`);
  console.log(`Deployer:  ${signer.address}`);
  console.log(`RPC:       ${rpcUrl}`);
  console.log(`========================================\n`);

  // 1. ChannelVault
  console.log('Deploying ChannelVault...');
  const ChannelVaultFactory = new ContractFactory(
    ChannelVaultArtifact.abi,
    ChannelVaultArtifact.bytecode,
    signer
  );
  const channelVault = await ChannelVaultFactory.deploy();
  await channelVault.waitForDeployment();
  const channelVaultAddr = await channelVault.getAddress();
  const cvDeployTx = channelVault.deploymentTransaction();
  console.log(`✓ ChannelVault deployed at: ${channelVaultAddr} (tx: ${cvDeployTx?.hash})`);

  // 2. TablePotVault
  console.log('Deploying TablePotVault...');
  const TablePotVaultFactory = new ContractFactory(
    TablePotVaultArtifact.abi,
    TablePotVaultArtifact.bytecode,
    signer
  );
  const tablePotVault = await TablePotVaultFactory.deploy();
  await tablePotVault.waitForDeployment();
  const tablePotVaultAddr = await tablePotVault.getAddress();
  const tpvDeployTx = tablePotVault.deploymentTransaction();
  console.log(`✓ TablePotVault deployed at: ${tablePotVaultAddr} (tx: ${tpvDeployTx?.hash})`);

  // 3. GenericHTLC
  console.log('Deploying GenericHTLC...');
  const GenericHTLCFactory = new ContractFactory(
    GenericHTLCArtifact.abi,
    GenericHTLCArtifact.bytecode,
    signer
  );
  const genericHtlc = await GenericHTLCFactory.deploy();
  await genericHtlc.waitForDeployment();
  const genericHtlcAddr = await genericHtlc.getAddress();
  const htlcDeployTx = genericHtlc.deploymentTransaction();
  console.log(`✓ GenericHTLC deployed at: ${genericHtlcAddr} (tx: ${htlcDeployTx?.hash})`);

  fs.mkdirSync(deploymentsDir, { recursive: true });

  const record: DeploymentRecord = {
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: signer.address,
    contracts: {
      ChannelVault: {
        address: channelVaultAddr,
        transactionHash: cvDeployTx?.hash ?? ''
      },
      TablePotVault: {
        address: tablePotVaultAddr,
        transactionHash: tpvDeployTx?.hash ?? ''
      },
      GenericHTLC: {
        address: genericHtlcAddr,
        transactionHash: htlcDeployTx?.hash ?? ''
      }
    }
  };

  const recordPath = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8');
  console.log(`\n✓ Saved deployment manifest to: ${recordPath}\n`);

  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  deployContracts()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
