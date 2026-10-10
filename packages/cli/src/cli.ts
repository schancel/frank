import { Command } from 'commander'

import { balanceCommand, sweepCommand } from './commands/balance'
import { createIdentityCommand, showIdentityCommand } from './commands/identity'
import { inboxCommand, listenCommand } from './commands/inbox'
import { mailSendCommand } from './commands/mail'
import { sendCommand } from './commands/send'
import {
  swapBuildCommand,
  swapQuoteCommand,
} from './commands/swap'
import {
  tokenBalanceCommand,
  tokenListCommand,
  tokenRecordCommand,
  tokenSendCommand,
} from './commands/token'
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
      'Send a direct message from the messaging account (a separate address from the identity: see `identity show`). Encrypt payload via ECDH, derive recipient stamp-child stealth address, construct and sign Monad stamp payment tx, submit envelope to relay',
    )
    .option(
      '-s, --stamp <amount>',
      'Stamp payment amount in wei or MON (default: 0.01 MON)',
    )
    .option('-r, --relay <url>', 'Override relay base URL')
    .option(
      '--subject <subject>',
      'Email subject line (when sending to email recipient)',
    )
    .option(
      '-c, --conversation <id>',
      'Frank conversation ID (when sending to email recipient)',
    )
    .option(
      '--in-reply-to <id>',
      'In-Reply-To Frank message ID (when sending to email recipient)',
    )
    .option(
      '-m, --message-id <id>',
      'Frank message ID (when sending to email recipient)',
    )
    .option(
      '-g, --gateway <url>',
      'Override mail gateway HTTP URL (when sending to email recipient)',
    )
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (recipient, message, opts, cmd) => {
      await sendCommand(recipient, message, mergeOptions(opts, cmd))
    })

  // --- Mail commands ---
  const mailCmd = program
    .command('mail')
    .description(
      'Email Gateway interaction: send and reply to external emails via Frank gateway',
    )

  mailCmd
    .command('send <recipientEmail> <message>')
    .description(
      'Send an outbound email to an external recipient via the mail gateway',
    )
    .option('-s, --subject <subject>', 'Email subject line')
    .option(
      '-c, --conversation <id>',
      'Frank conversation ID for thread preservation',
    )
    .option('--in-reply-to <id>', 'In-Reply-To Frank message ID')
    .option(
      '-m, --message-id <id>',
      'Frank message ID for outbound message tracking',
    )
    .option('-g, --gateway <url>', 'Override mail gateway HTTP URL')
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (recipientEmail, message, opts, cmd) => {
      await mailSendCommand(recipientEmail, message, mergeOptions(opts, cmd))
    })

  // --- Inbox & Listen commands ---
  program
    .command('inbox')
    .description(
      'Fetch, decrypt, and display the messaging account\'s direct messages (a separate address from the identity: see `identity show`)',
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

  // --- Token commands ---
  const token = program
    .command('token')
    .description(
      'Token management, local LevelDB UTXOs, and encrypted transfers',
    )

  token
    .command('list')
    .description(
      'List supported tokens across Monad, Ethereum, Solana, and eCash',
    )
    .option('-c, --chain <chain>', 'Filter by chain identifier')
    .action(async (opts, cmd) => {
      await tokenListCommand(mergeOptions(opts, cmd))
    })

  token
    .command('balance')
    .description(
      'Display token balances and unspent UTXOs from local LevelDB TokenUtxoStore',
    )
    .option('-c, --chain <chain>', 'Filter by chain identifier')
    .option('-t, --token <symbolOrAddress>', 'Specific token to query')
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (opts, cmd) => {
      await tokenBalanceCommand(mergeOptions(opts, cmd))
    })

  token
    .command('record <amount> <token>')
    .description(
      'Record an inbound or offline unspent token note into local storage',
    )
    .option('-c, --chain <chain>', 'Chain identifier (default: monad)')
    .option(
      '--recipient <address>',
      'Recipient address (defaults to active identity)',
    )
    .option('--tx <hash>', 'Transaction hash reference')
    .option('--derivation-index <n>', 'Derivation index')
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (amount, tokenSym, opts, cmd) => {
      await tokenRecordCommand(amount, tokenSym, mergeOptions(opts, cmd))
    })

  token
    .command('send <recipient> <amount> <token>')
    .description('Send tokens to a recipient via Type 6 Encrypted DM')
    .option('-c, --chain <chain>', 'Chain identifier (default: monad)')
    .option('-r, --relay <url>', 'Override relay base URL')
    .option('-s, --stamp <amount>', 'Stamp payment amount')
    .option('--memo <memo>', 'Optional transfer memo')
    .option('--password <password>', 'Password if keystore is encrypted')
    .action(async (recipient, amount, tokenSym, opts, cmd) => {
      await tokenSendCommand(
        recipient,
        amount,
        tokenSym,
        mergeOptions(opts, cmd),
      )
    })

  // --- Swap commands ---
  const swap = program
    .command('swap')
    .description(
      'Swap quotes read from the chain named by --chain; no interface fee',
    )

  swap
    .command('quote <fromAsset> <toAsset> <amount>')
    .description(
      "Ask the swap deployment's quoter contract what the amount buys now",
    )
    .option('--chain <id>', 'Canonical chain identifier (required)')
    .option('--venue <id>', "One of the chain's swap venues (default: its first)")
    .option('--rpc-url <url>', 'JSON-RPC endpoint for that chain')
    .option('--slippage <bps>', 'Slippage in basis points (default: 50)')
    .action(async (fromAsset, toAsset, amount, opts, cmd) => {
      await swapQuoteCommand(
        fromAsset,
        toAsset,
        amount,
        mergeOptions(opts, cmd),
      )
    })

  swap
    .command('build <fromAsset> <toAsset> <amount>')
    .description(
      'Print the unsigned transactions for a swap from --account (signs and sends nothing)',
    )
    .requiredOption('--account <address>', 'The account that would swap')
    .option('--chain <id>', 'Canonical chain identifier (required)')
    .option('--venue <id>', "One of the chain's swap venues (default: its first)")
    .option('--rpc-url <url>', 'JSON-RPC endpoint for that chain')
    .option('--slippage <bps>', 'Slippage in basis points (default: 50)')
    .action(async (fromAsset, toAsset, amount, opts, cmd) => {
      await swapBuildCommand(
        fromAsset,
        toAsset,
        amount,
        mergeOptions(opts, cmd),
      )
    })

  return program
}
