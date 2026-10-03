import { execFileSync } from 'child_process'
import { resolve } from 'path'

describe('root demo workspace resolution', () => {
  it('loads the AEAD and identity consumers through the bot tsconfig', () => {
    const repoRoot = resolve(__dirname, '../../..')
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "await Promise.all([import('./packages/cashweb/relay/monad-message-envelope.ts'), import('./packages/wallet/monad-identity.ts')]); process.stdout.write('workspace imports ok')",
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: 'packages/bot/tsconfig.json',
        },
      },
    )

    expect(output).toBe('workspace imports ok')
  })
})
