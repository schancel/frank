/* eslint-env node */
// Same base rules as packages/frank-codec. src/ has no Node or DOM globals.
module.exports = {
  root: true,
  ignorePatterns: ['dist/', 'node_modules/'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { es2020: true },
  overrides: [
    {
      files: ['src/**/*.ts'],
      env: { browser: false, node: false },
      rules: {
        'no-restricted-globals': [
          'error',
          'process',
          'Buffer',
          'require',
          'module',
          '__dirname',
          'window',
          'document',
          'TextEncoder',
          'TextDecoder',
        ],
      },
    },
    {
      files: ['test/**/*.ts'],
      env: { jest: true, node: true },
    },
    {
      files: ['*.js'],
      env: { node: true },
      rules: { '@typescript-eslint/no-var-requires': 'off' },
    },
  ],
}
