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
      env: { es2020: true, browser: false, node: false },
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
      files: ['*.js', '*.cjs'],
      parserOptions: { sourceType: 'script' },
      env: { node: true },
      rules: { '@typescript-eslint/no-var-requires': 'off' },
    },
    {
      files: ['scripts/**/*.mjs'],
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
      env: { node: true, es2022: true },
    },
  ],
}
