#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
const { spawnSync } = require('child_process')
const path = require('path')

// When executed directly, ensure tsx handles TypeScript resolution with tsconfig paths
if (
  !process.execArgv.some(arg => arg.includes('tsx')) &&
  !process.env._SIGNET_SPAWNED
) {
  const tsconfigPath = path.resolve(__dirname, '../tsconfig.json')
  const cliPath = path.resolve(__dirname, '../src/index.ts')
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliPath, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        _SIGNET_SPAWNED: '1',
        TSX_TSCONFIG_PATH: tsconfigPath,
      },
    },
  )
  process.exit(result.status ?? 0)
} else {
  require('../src/index.ts')
}
