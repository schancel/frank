/* eslint-env node */
// Same base rules the app applies to TypeScript (eslint:recommended + @typescript-eslint/recommended),
// without Vue. `src/` additionally must stay free of Node and DOM globals (browser-safe codec).
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
      files: ['test/**/*.ts', 'fixtures/**/*.ts'],
      env: { jest: true, node: true },
    },
    {
      files: ['*.js', 'browsercheck/*.js'],
      env: { node: true, browser: true },
      rules: { '@typescript-eslint/no-var-requires': 'off' },
    },
  ],
}
