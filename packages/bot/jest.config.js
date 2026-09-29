/* eslint-env node */
module.exports = {
  testTimeout: 5000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@frank/cashweb/(.*)$': '<rootDir>/../cashweb/$1',
    '^@frank/wallet/(.*)$': '<rootDir>/../wallet/$1',
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
