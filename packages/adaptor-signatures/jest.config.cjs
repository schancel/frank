/* eslint-env node */
module.exports = {
  testTimeout: 5000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/nakamoto/keys$': '<rootDir>/../nakamoto/src/keys.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|js)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  testPathIgnorePatterns: ['/node_modules/'],
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],
}
