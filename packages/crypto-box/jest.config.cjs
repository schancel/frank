/* eslint-env node */
module.exports = {
  testTimeout: 20000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@frank/nakamoto/curve$': '<rootDir>/../nakamoto/src/curve.ts',
    '^@frank/nakamoto/constructors$':
      '<rootDir>/../nakamoto/src/constructors.ts',
  },
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json',
        useESM: false,
      },
    ],
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
}
