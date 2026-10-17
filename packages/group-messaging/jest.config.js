module.exports = {
  ...require('../wallet/jest.config.js'),
  rootDir: '../wallet',
  roots: ['<rootDir>/../group-messaging'],
  testMatch: ['<rootDir>/../group-messaging/**/*.jest.test.ts'],
}
