import { createProgram } from './cli'

export * from './cli'
export * from './config'
export * from './util'
export * from './commands/identity'
export * from './commands/send'
export * from './commands/inbox'
export * from './commands/balance'
export * from './commands/topic'

export async function main(): Promise<void> {
  const program = createProgram()
  await program.parseAsync(process.argv)
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(err => {
    console.error('Fatal CLI Error:', err)
    process.exit(1)
  })
}
