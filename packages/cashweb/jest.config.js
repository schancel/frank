/* eslint-env node */
module.exports = {
  testTimeout: 5000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/directory-admission$':
      '<rootDir>/../directory-admission/src/index.ts',
    '^@frank/directory-admission/node$':
      '<rootDir>/../directory-admission/src/node.ts',
    '^@frank/codec$': '<rootDir>/../frank-codec/src/index.ts',
    '^@frank/crypto-box$': '<rootDir>/../crypto-box/src/index.ts',
    '^@frank/nakamoto$': '<rootDir>/../nakamoto/src/index.ts',
    '^@frank/nakamoto/curve$': '<rootDir>/../nakamoto/src/curve.ts',
    '^@frank/nakamoto/constructors$':
      '<rootDir>/../nakamoto/src/constructors.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
  },
  testPathIgnorePatterns: ['/node_modules/'],
}
