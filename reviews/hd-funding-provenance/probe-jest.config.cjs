const path = require('path')
const wallet = require('../../packages/wallet/jest.config.js')
module.exports = {
  ...wallet,
  rootDir: path.resolve(__dirname, '../../packages/wallet'),
  roots: [__dirname],
  testMatch: [path.join(__dirname, 'base-loss.jest.test.ts')],
}
