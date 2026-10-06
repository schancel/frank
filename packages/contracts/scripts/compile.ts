import * as fs from 'fs'
import * as path from 'path'
import solc from 'solc'

const contractsDir = path.resolve(__dirname, '../contracts')
const artifactsDir = path.resolve(__dirname, '../artifacts')

export function compileContracts() {
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true })
  }

  const sources: Record<string, { content: string }> = {}
  const contractFiles = fs
    .readdirSync(contractsDir)
    .filter(f => f.endsWith('.sol'))

  for (const file of contractFiles) {
    const fullPath = path.join(contractsDir, file)
    sources[file] = {
      content: fs.readFileSync(fullPath, 'utf8'),
    }
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
        },
      },
    },
  }

  console.log(`Compiling ${contractFiles.length} Solidity contracts...`)
  const output = JSON.parse(solc.compile(JSON.stringify(input)))

  if (output.errors && output.errors.length > 0) {
    const fatalErrors = output.errors.filter(
      (e: any) => e.severity === 'error',
    )
    for (const err of output.errors) {
      if (err.severity === 'error') {
        console.error(err.formattedMessage)
      } else {
        console.warn(err.formattedMessage)
      }
    }
    if (fatalErrors.length > 0) {
      throw new Error(`Solidity compilation failed with ${fatalErrors.length} errors`)
    }
  }

  const compiledArtifacts: Record<
    string,
    { abi: any[]; bytecode: string; deployedBytecode: string }
  > = {}

  for (const file in output.contracts) {
    for (const contractName in output.contracts[file]) {
      const contract = output.contracts[file][contractName]
      const artifact = {
        contractName,
        sourceName: file,
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      }

      compiledArtifacts[contractName] = artifact
      const outPath = path.join(artifactsDir, `${contractName}.json`)
      fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8')
      console.log(`✓ Artifact generated: ${contractName} -> ${outPath}`)
    }
  }

  return compiledArtifacts
}

if (require.main === module) {
  compileContracts()
}
