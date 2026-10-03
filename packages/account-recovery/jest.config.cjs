/* eslint-env node */
module.exports = {
  testMatch: ['<rootDir>/src/**/*.jest.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@frank/nakamoto/(bech32|convert-bits)$':
      '<rootDir>/../nakamoto/src/$1.ts',
  },
}
