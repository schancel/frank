/* eslint-env node */
module.exports = {
  testTimeout: 300000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/nakamoto/keys$': '<rootDir>/../nakamoto/src/keys.ts',
    '^@frank/adaptor-signatures$':
      '<rootDir>/../adaptor-signatures/src/index.ts',
    '^@frank/adaptor-signatures/src/(.*)\\.js$':
      '<rootDir>/../adaptor-signatures/src/$1',
    '^@frank/threshold-ecdsa/src/(.*)\\.js$':
      '<rootDir>/../threshold-ecdsa/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|js)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  testPathIgnorePatterns: ['/node_modules/'],
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],
}
