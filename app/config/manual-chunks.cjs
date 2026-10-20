'use strict'

function stripSourceMappingUrlComments(content) {
  if (typeof content !== 'string') return content
  return content
    .replace(/\/\/[#@]\s*sourceMappingURL=[^\r\n]*/g, '')
    .replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, '')
}

function resolveManualChunk(id) {
  if (!id || typeof id !== 'string') return undefined
  const normalized = id.replace(/\\/g, '/')
  if (
    !normalized.includes('/node_modules/') &&
    !normalized.includes('/packages/bitcore-lib-xpi/') &&
    !normalized.includes('/packages/bn.js/')
  ) {
    return undefined
  }
  if (
    normalized.includes('/node_modules/quasar/') ||
    normalized.includes('/node_modules/@quasar/')
  ) {
    return 'vendor-quasar'
  }
  if (
    normalized.includes('/node_modules/vue/') ||
    normalized.includes('/node_modules/@vue/') ||
    normalized.includes('/node_modules/vue-router/') ||
    normalized.includes('/node_modules/pinia/') ||
    normalized.includes('/node_modules/vue-i18n/') ||
    normalized.includes('/node_modules/@intlify/')
  ) {
    return 'vendor-vue'
  }
  if (
    normalized.includes('/node_modules/@noble/curves/') ||
    normalized.includes('/node_modules/@noble/hashes/') ||
    normalized.includes('/node_modules/@noble/ciphers/') ||
    normalized.includes('/node_modules/@scure/')
  ) {
    return 'vendor-noble'
  }
  if (
    normalized.includes('/node_modules/ethers/') ||
    normalized.includes('/node_modules/@ethersproject/')
  ) {
    return 'vendor-ethers'
  }
  if (
    normalized.includes('/node_modules/level-js/') ||
    normalized.includes('/node_modules/level-transcoder/') ||
    normalized.includes('/node_modules/level-Transcoder/') ||
    normalized.includes('/node_modules/abstract-leveldown/') ||
    normalized.includes('/node_modules/levelup/') ||
    normalized.includes('/node_modules/encoding-down/') ||
    normalized.includes('/node_modules/idb/')
  ) {
    return 'vendor-storage'
  }
  if (normalized.includes('/node_modules/@solana/')) {
    return 'vendor-solana'
  }
  if (
    normalized.includes('/packages/bitcore-lib-xpi/') ||
    normalized.includes('/packages/bn.js/') ||
    normalized.includes('/node_modules/bitcore-lib') ||
    normalized.includes('/node_modules/ecashaddrjs/') ||
    normalized.includes('/node_modules/bip39/') ||
    normalized.includes('/node_modules/bip32/')
  ) {
    return 'vendor-utxo'
  }
  return undefined
}

module.exports = {
  resolveManualChunk,
  stripSourceMappingUrlComments,
}
