const { build, packageRoot } = require('./build-tests.cjs')
const { spawnSync } = require('child_process')
const path = require('path')
build('resources')
  .then(() => {
    const run = spawnSync(
      process.execPath,
      [path.join(packageRoot, 'dist/test-resources.cjs')],
      { stdio: 'inherit' },
    )
    process.exitCode = run.status ?? 1
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
