/* eslint-env node */
// The Silence Laboratories package is resolved from node_modules when it is
// installed. Until the lockfile entries are installed by a working yarn, point
// JOINT_SIGNER_DKLS_NODE_PATH at an installed copy of
// @silencelaboratories/dkls-wasm-ll-node (the package directory).
const dklsNodePath = process.env.JOINT_SIGNER_DKLS_NODE_PATH

module.exports = {
  // The frank-lindell backend runs whole Paillier key generations.
  testTimeout: 300000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    ...(dklsNodePath
      ? { '^@silencelaboratories/dkls-wasm-ll-node$': dklsNodePath }
      : {}),
    '^@frank/threshold-ecdsa$': '<rootDir>/../threshold-ecdsa/src/index.ts',
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
  transformIgnorePatterns: ['/node_modules/(?!@noble/)', 'dkls-wasm-ll-node'],
}
