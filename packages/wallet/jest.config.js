/* eslint-env node */
module.exports = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testTimeout: 5000,
  testMatch: ['<rootDir>/**/*.jest.(spec|test).+(ts|js)'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Ticket #54: `chain/vite-env.ts` contains a real `import.meta.env` reference (see its own
  // header) -- V8 refuses to compile that token outside a genuine ES module, and Jest wraps every
  // transpiled file in a plain CommonJS function, so it can never load that file directly.
  // Substitute the Node-safe stub (`vite-env.node.ts`) for tests only; Vite and `tsx` both
  // resolve the real file normally, unaffected by this (Jest-only) config.
  moduleNameMapper: {
    '^\\./vite-env$': '<rootDir>/chain/vite-env.node.ts',
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
