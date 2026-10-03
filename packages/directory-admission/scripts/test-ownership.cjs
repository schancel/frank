const { build, packageRoot } = require('./build-tests.cjs')
const { spawnSync } = require('child_process')
const path = require('path')
const { verifyCleanup } = require('../test/browser-cleanup.cjs')
verifyCleanup()
build('ownership')
  .then(() => {
    const run = spawnSync(
      process.execPath,
      [
        path.join(packageRoot, 'dist/test-ownership.cjs'),
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit' },
    )
    process.exitCode = run.status ?? 1
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
