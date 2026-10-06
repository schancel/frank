import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, HDNodeWallet, ContractFactory, Contract } from 'ethers';
import {
  ChannelVaultArtifact,
  TablePotVaultArtifact,
  GenericHTLCArtifact
} from '../src/artifacts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

const DEFAULT_PORT = 19545;
const RPC_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

let hardhatProcess: ChildProcess | null = null;
let providerInstance: JsonRpcProvider | null = null;

process.on('exit', () => {
  if (hardhatProcess) {
    try {
      hardhatProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
});

export async function getTestProvider(): Promise<JsonRpcProvider> {
  if (providerInstance && await checkRpc(RPC_URL)) {
    return providerInstance;
  }

  // Check if server is already running
  const isRunning = await checkRpc(RPC_URL);
  if (!isRunning) {
    hardhatProcess = spawn('npx', ['hardhat', 'node', '--port', String(DEFAULT_PORT), '--hostname', '127.0.0.1'], {
      cwd: packageRoot,
      stdio: 'ignore',
      detached: false
    });

    // Wait for node to be ready
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 200));
      if (await checkRpc(RPC_URL)) {
        break;
      }
      attempts++;
    }
    if (attempts >= 30) {
      throw new Error(`Failed to start Hardhat node on port ${DEFAULT_PORT}`);
    }
  }

  providerInstance = new JsonRpcProvider(RPC_URL);
  return providerInstance;
}

export async function stopTestNode(): Promise<void> {
  if (hardhatProcess) {
    try {
      hardhatProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
    hardhatProcess = null;
  }
  providerInstance = null;
}

async function checkRpc(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
    });
    const data = await res.json() as any;
    return !!data && !!data.result;
  } catch {
    return false;
  }
}

export interface TestWallets {
  deployer: HDNodeWallet;
  player: HDNodeWallet;
  dealer: HDNodeWallet;
  jointSigner: HDNodeWallet;
  bob: HDNodeWallet;
  charlie: HDNodeWallet;
}

const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

export async function getTestWallets(provider: JsonRpcProvider): Promise<TestWallets> {
  const derive = (index: number) => {
    const raw = HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
    raw.getNonce = async () => {
      const hex = await provider.send('eth_getTransactionCount', [raw.address, 'latest']);
      return parseInt(hex, 16);
    };
    return raw;
  };

  return {
    deployer: derive(0),
    player: derive(1),
    dealer: derive(2),
    jointSigner: derive(3),
    bob: derive(4),
    charlie: derive(5)
  };
}

export async function getBalance(provider: JsonRpcProvider, address: string): Promise<bigint> {
  const hex = await provider.send('eth_getBalance', [address, 'latest']);
  return BigInt(hex);
}

export async function increaseTime(provider: JsonRpcProvider, seconds: number): Promise<void> {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

export async function deployAll(signer: HDNodeWallet) {
  const ChannelVaultFactory = new ContractFactory(
    ChannelVaultArtifact.abi,
    ChannelVaultArtifact.bytecode,
    signer
  );
  const channelVault = await ChannelVaultFactory.deploy();
  await channelVault.waitForDeployment();

  const TablePotVaultFactory = new ContractFactory(
    TablePotVaultArtifact.abi,
    TablePotVaultArtifact.bytecode,
    signer
  );
  const tablePotVault = await TablePotVaultFactory.deploy();
  await tablePotVault.waitForDeployment();

  const GenericHTLCFactory = new ContractFactory(
    GenericHTLCArtifact.abi,
    GenericHTLCArtifact.bytecode,
    signer
  );
  const genericHtlc = await GenericHTLCFactory.deploy();
  await genericHtlc.waitForDeployment();

  return {
    channelVault: channelVault as Contract,
    tablePotVault: tablePotVault as Contract,
    genericHtlc: genericHtlc as Contract
  };
}
