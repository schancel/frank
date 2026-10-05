/* eslint-env node */
module.exports = {
  // Paillier key generation and the cut-and-choose range proof take seconds
  // in JavaScript; the protocol suites run whole key generations.
  testTimeout: 300000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/nakamoto/keys$': '<rootDir>/../nakamoto/src/keys.ts',
    '^@frank/adaptor-signatures$':
      '<rootDir>/../adaptor-signatures/src/index.ts',
    '^@frank/adaptor-signatures/src/(.*)\\.js$':
      '<rootDir>/../adaptor-signatures/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|js)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  testPathIgnorePatterns: ['/node_modules/'],
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],
}
