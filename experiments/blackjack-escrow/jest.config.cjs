/* eslint-env node */
// Stage-1 feasibility experiments for docs/protocol/blackjack-escrow.md. Not shipped code.
// Run: node_modules/.bin/jest -c experiments/blackjack-escrow/jest.config.cjs
module.exports = {
  rootDir: __dirname,
  testTimeout: 120000,
  testMatch: ['<rootDir>/**/*.jest.test.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/adaptor-signatures$':
      '<rootDir>/../../packages/adaptor-signatures/src/index.ts',
    '^@frank/adaptor-signatures/(.*)$':
      '<rootDir>/../../packages/adaptor-signatures/src/$1',
    '^@frank/nakamoto/keys$': '<rootDir>/../../packages/nakamoto/src/keys.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|js)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],
}
