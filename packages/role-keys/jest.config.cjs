/* eslint-env node */
module.exports = {
  testMatch: ['<rootDir>/src/**/*.jest.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@frank/domain-roots$': '<rootDir>/../domain-roots/src/index.ts',
    '^@frank/nakamoto/(hd|keys|curve)$': '<rootDir>/../nakamoto/src/$1.ts',
  },
}
