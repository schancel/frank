/* eslint-env node */
module.exports = {
  // The frank-lindell backend runs whole Paillier key generations.
  testTimeout: 300000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/threshold-ecdsa$': '<rootDir>/../threshold-ecdsa/src/index.ts',
    '^@frank/threshold-ecdsa/src/(.*)\\.js$':
      '<rootDir>/../threshold-ecdsa/src/$1',
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
  // The wasm-bindgen glue is CommonJS already and must not be transformed.
  transformIgnorePatterns: ['/node_modules/(?!@noble/)', 'third_party/'],
}
