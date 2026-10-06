import { createProgram } from '../src/cli'

describe('CLI Argument Parsing', () => {
  it('configures program metadata and global options', () => {
    const program = createProgram()
    expect(program.name()).toBe('signet')
    expect(program.version()).toBe('0.0.1')

    const options = program.options.map(opt => opt.long)
    expect(options).toContain('--data-dir')
    expect(options).toContain('--json')
  })

  it('defines all required command branches', () => {
    const program = createProgram()
    const commandNames = program.commands.map(cmd => cmd.name())

    expect(commandNames).toContain('identity')
    expect(commandNames).toContain('send')
    expect(commandNames).toContain('inbox')
    expect(commandNames).toContain('listen')
    expect(commandNames).toContain('balance')
    expect(commandNames).toContain('sweep')
    expect(commandNames).toContain('wallet')
    expect(commandNames).toContain('topic')
  })

  it('defines identity subcommands', () => {
    const program = createProgram()
    const identityCmd = program.commands.find(cmd => cmd.name() === 'identity')
    expect(identityCmd).toBeDefined()

    const subNames = identityCmd!.commands.map(cmd => cmd.name())
    expect(subNames).toContain('create')
    expect(subNames).toContain('show')
  })

  it('defines topic subcommands', () => {
    const program = createProgram()
    const topicCmd = program.commands.find(cmd => cmd.name() === 'topic')
    expect(topicCmd).toBeDefined()

    const subNames = topicCmd!.commands.map(cmd => cmd.name())
    expect(subNames).toContain('post')
    expect(subNames).toContain('read')
  })

  it('defines wallet subcommands', () => {
    const program = createProgram()
    const walletCmd = program.commands.find(cmd => cmd.name() === 'wallet')
    expect(walletCmd).toBeDefined()

    const subNames = walletCmd!.commands.map(cmd => cmd.name())
    expect(subNames).toContain('balance')
    expect(subNames).toContain('sweep')
  })

  it('parses global options properly', () => {
    const program = createProgram()
    // Configure exitOverride to prevent process.exit during test
    program.exitOverride()

    program.parse([
      'node',
      'signet',
      '--data-dir',
      '/tmp/custom-signet',
      '--json',
      'balance',
    ])
    const opts = program.opts()
    expect(opts.dataDir).toBe('/tmp/custom-signet')
    expect(opts.json).toBe(true)
  })

  it('parses send command arguments and flags', () => {
    const program = createProgram()
    program.exitOverride()

    let capturedRecipient = ''
    let capturedMessage = ''
    let capturedOpts: any = {}

    const sendCmd = program.commands.find(c => c.name() === 'send')
    sendCmd!.action((recipient, message, opts) => {
      capturedRecipient = recipient
      capturedMessage = message
      capturedOpts = opts
    })

    program.parse([
      'node',
      'signet',
      'send',
      '0x1234567890123456789012345678901234567890',
      'Hello Monad!',
      '--stamp',
      '0.05 MON',
      '--relay',
      'http://relay.example.com',
    ])

    expect(capturedRecipient).toBe('0x1234567890123456789012345678901234567890')
    expect(capturedMessage).toBe('Hello Monad!')
    expect(capturedOpts.stamp).toBe('0.05 MON')
    expect(capturedOpts.relay).toBe('http://relay.example.com')
  })

  it('parses topic post arguments and flags', () => {
    const program = createProgram()
    program.exitOverride()

    let capturedTopic = ''
    let capturedContent = ''
    let capturedOpts: any = {}

    const topicCmd = program.commands.find(c => c.name() === 'topic')
    const postCmd = topicCmd!.commands.find(c => c.name() === 'post')
    postCmd!.action((topic, content, opts) => {
      capturedTopic = topic
      capturedContent = content
      capturedOpts = opts
    })

    program.parse([
      'node',
      'signet',
      'topic',
      'post',
      'general',
      'Announcing Signet CLI release',
      '--burn',
      '0.1 MON',
    ])

    expect(capturedTopic).toBe('general')
    expect(capturedContent).toBe('Announcing Signet CLI release')
    expect(capturedOpts.burn).toBe('0.1 MON')
  })
})
