import { Command } from 'commander'

import { balanceCommand, sweepCommand } from './commands/balance'
import { createIdentityCommand, showIdentityCommand } from './commands/identity'
import { inboxCommand, listenCommand } from './commands/inbox'
import { sendCommand } from './commands/send'
import { topicPostCommand, topicReadCommand } from './commands/topic'

export function createProgram(): Command {
  const program = new Command()

  program
    .name('signet')
    .description(
      'Signet CLI: standalone terminal client for Monad cashweb protocol, stamped DMs, topics, and wallet operations',
    )
    .version('0.0.1')
    .option(
      '-d, --data-dir <path>',
      'State storage directory (defaults to ~/.signet or $SIGNET_HOME)',
    )
    .option('--json', 'Output results formatted as JSON')

  // Helper to merge global options with command options
  const mergeOptions = <T extends Record<string, unknown>>(
    cmdOptions: T,
    command: Command,
  ): T & { dataDir?: string; json?: boolean } => {
    const parentOpts = command.optsWithGlobals()
    return {
      ...cmdOptions,
      dataDir: cmdOptions.dataDir ?? parentOpts.dataDir,
      json: cmdOptions.json ?? parentOpts.json,
    }
  }

  // --- Identity commands ---
  const identity = program
    .command('identity')
    .description('Manage local secp256k1 identities and credentials')

  identity
    .command('create')
    .description(
      'Generate a new local secp256k1 identity and mnemonic seed, outputting public address and encryption pubkey',
    )
    .option(
      '--password <password>',
      'Optional password to encrypt the keystore',
    )
    .action(async (opts, cmd) => {
      await createIdentityCommand(mergeOptions(opts, cmd))
    })

  identity
    .command('show')
    .description(
      'Display current active identity, encryption public key, and registered relay profile',
    )
    .option(
      '-a, --address <address>',
      'Specific identity address to show (defaults to active identity)',
    )
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await showIdentityCommand(mergeOptions(opts, cmd))
    })

  // --- Send command ---
  program
    .command('send <recipient> <message>')
    .description(
      'Encrypt payload via ECDH, derive recipient stamp-child stealth address, construct and sign Monad stamp payment tx, submit envelope to relay',
    )
    .option(
      '-s, --stamp <amount>',
      'Stamp payment amount in wei or MON (default: 0.01 MON)',
    )
    .option('-r, --relay <url>', 'Override relay base URL')
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (recipient, message, opts, cmd) => {
      await sendCommand(recipient, message, mergeOptions(opts, cmd))
    })

  // --- Inbox & Listen commands ---
  program
    .command('inbox')
    .description(
      'Fetch, decrypt, and display direct messages from relay mailbox',
    )
    .option('-l, --limit <n>', 'Maximum number of messages to display')
    .option('-u, --unread', 'Only show unread messages since last check')
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await inboxCommand(mergeOptions(opts, cmd))
    })

  program
    .command('listen')
    .description('Stream incoming direct messages in real-time')
    .option('-f, --follow', 'Continuously poll and stream incoming messages')
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await listenCommand(mergeOptions(opts, cmd))
    })

  // --- Wallet & Balance commands ---
  program
    .command('balance')
    .description(
      'Display EOA balance, active funding pool lanes, and uncollected stamp-child balances',
    )
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await balanceCommand(mergeOptions(opts, cmd))
    })

  program
    .command('sweep')
    .description(
      'Consolidate and sweep confirmed stamp payments from one-time child addresses',
    )
    .option(
      '--destination <address>',
      'Destination address to sweep funds into (defaults to active identity)',
    )
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await sweepCommand(mergeOptions(opts, cmd))
    })

  // Wallet subcommand alias group: `signet wallet balance` and `signet wallet sweep`
  const wallet = program
    .command('wallet')
    .description('Wallet management subcommands (balance, sweep)')

  wallet
    .command('balance')
    .description(
      'Display EOA balance, active funding pool lanes, and uncollected stamp-child balances',
    )
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await balanceCommand(mergeOptions(opts, cmd))
    })

  wallet
    .command('sweep')
    .description(
      'Consolidate and sweep confirmed stamp payments from one-time child addresses',
    )
    .option(
      '--destination <address>',
      'Destination address to sweep funds into',
    )
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await sweepCommand(mergeOptions(opts, cmd))
    })

  // --- Topic commands ---
  const topic = program
    .command('topic')
    .description('Burn-weighted public broadcast topics and feeds')

  topic
    .command('post <topic> <content>')
    .description('Construct and submit burn-weighted public broadcast')
    .option(
      '-b, --burn <amount>',
      'Burn weight amount in wei or MON (default: 0.01 MON)',
    )
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (topicName, content, opts, cmd) => {
      await topicPostCommand(topicName, content, mergeOptions(opts, cmd))
    })

  topic
    .command('read <topic>')
    .description('Read and display public feed items')
    .option(
      '--since <ms>',
      'Fetch messages authored at or after timestamp in milliseconds',
    )
    .action(async (topicName, opts, cmd) => {
      await topicReadCommand(topicName, mergeOptions(opts, cmd))
    })

  return program
}
