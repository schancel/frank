/* eslint-env node */
module.exports = {
  testTimeout: 5000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json',
      },
    ],
  },
  testPathIgnorePatterns: ['/node_modules/'],
  // @noble/curves and @noble/hashes ship pure ESM .js files; Jest's default
  // transformIgnorePatterns would skip transforming them (they're under node_modules) and then
  // fail requiring their `import` syntax under CommonJS. Let ts-jest transform just these two
  // scoped packages down to CommonJS (see tsconfig.jest.json's "module": "commonjs" override).
  transformIgnorePatterns: ['/node_modules/(?!@noble/)'],
}
