import * as fs from 'fs'
import * as path from 'path'
import solc from 'solc'

const contractsDir = path.resolve(__dirname, '../contracts')
const artifactsDir = path.resolve(__dirname, '../artifacts')

/** The settings every Frank contract is compiled with. A deployment record carries a copy. */
export const COMPILER_SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'cancun',
} as const

export interface CompilerInfo {
  version: string
  settings: typeof COMPILER_SETTINGS
}

export interface ContractArtifact {
  contractName: string
  sourceName: string
  abi: any[]
  bytecode: string
  deployedBytecode: string
  compiler: CompilerInfo
}

/** Compiles every `.sol` file in `sourceDirs` together and returns the artifacts by contract name. */
export function compileSolidity(
  sourceDirs: readonly string[],
): Record<string, ContractArtifact> {
  const sources: Record<string, { content: string }> = {}
  for (const dir of sourceDirs) {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sol'))) {
      if (sources[file]) throw new Error(`Duplicate Solidity file name: ${file}`)
      sources[file] = { content: fs.readFileSync(path.join(dir, file), 'utf8') }
    }
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      ...COMPILER_SETTINGS,
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
        },
      },
    },
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (output.errors ?? []).filter((e: any) => e.severity === 'error')
  if (errors.length > 0) {
    throw new Error(
      `Solidity compilation failed:\n${errors
        .map((e: any) => e.formattedMessage)
        .join('\n')}`,
    )
  }

  const compiler: CompilerInfo = {
    version: solc.version(),
    settings: COMPILER_SETTINGS,
  }
  const artifacts: Record<string, ContractArtifact> = {}
  for (const file in output.contracts) {
    for (const contractName in output.contracts[file]) {
      const contract = output.contracts[file][contractName]
      artifacts[contractName] = {
        contractName,
        sourceName: file,
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        compiler,
      }
    }
  }
  return artifacts
}

/** Compiles `contracts/` and rewrites `artifacts/`, the bytecode that is tested and deployed. */
export function compileContracts(): Record<string, ContractArtifact> {
  const artifacts = compileSolidity([contractsDir])
  fs.mkdirSync(artifactsDir, { recursive: true })
  for (const artifact of Object.values(artifacts)) {
    fs.writeFileSync(
      path.join(artifactsDir, `${artifact.contractName}.json`),
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    )
  }
  return artifacts
}

if (require.main === module) {
  const names = Object.keys(compileContracts())
  console.log(`Compiled ${names.join(', ')} into ${artifactsDir}`)
}
