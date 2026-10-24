const { resolve } = require('path')

module.exports = {
  overrides: [
    {
      files: ['messaging-baseline.mjs', 'messaging-baseline/**/*.{ts,mjs}'],
      parserOptions: {
        project: [resolve(__dirname, './tsconfig.messaging-baseline.json')],
      },
    },
    {
      files: ['messaging-baseline.mjs', 'messaging-baseline/**/*.mjs'],
      env: { node: true, browser: false },
    },
  ],
}
