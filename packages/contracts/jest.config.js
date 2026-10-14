/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  moduleNameMapper: {
    '^@frank/threshold-ecdsa$': '<rootDir>/../threshold-ecdsa/src/index.ts',
    '^@frank/adaptor-signatures$':
      '<rootDir>/../adaptor-signatures/src/index.ts',
    '^@frank/adaptor-signatures/src/(.*)\\.js$':
      '<rootDir>/../adaptor-signatures/src/$1',
    '^@frank/nakamoto/(.*)$': '<rootDir>/../nakamoto/src/$1',
    '^@frank/nakamoto$': '<rootDir>/../nakamoto/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],
  testEnvironment: 'node',
  testMatch: ['**/*.jest.test.ts'],
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        tsconfig: {
          ...require('./tsconfig.json').compilerOptions,
          module: 'CommonJS',
          moduleResolution: 'Node',
          allowJs: true,
        },
      },
    ],
  },
}
