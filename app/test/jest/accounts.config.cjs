const base = require('../../jest.config.js')
module.exports = {
  ...base,
  rootDir: '../..',
  moduleNameMapper: {
    '^@frank/account-recovery$':
      '<rootDir>/../packages/account-recovery/src/index.ts',
    '^@frank/account-vault$':
      '<rootDir>/../packages/account-vault/src/index.ts',
    '^@frank/domain-roots$': '<rootDir>/../packages/domain-roots/src/index.ts',
    '^@frank/codex32$': '<rootDir>/../packages/codex32/src/index.ts',
    '^@frank/nakamoto/(.*)$': '<rootDir>/../packages/nakamoto/src/$1',
    ...base.moduleNameMapper,
  },
}
