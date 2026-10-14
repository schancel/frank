import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initBlobManifestPlugin } from './plugin'

describePluginContract({
  type: 'blob-manifest',
  init: initBlobManifestPlugin,
  samples: [
    {
      item: {
        type: 'blob-manifest',
        version: 1,
        rootPlaintextSha256: '11'.repeat(32),
        totalPlaintextBytes: 65_536,
        chunkSize: 262_144,
        symmetricKeyHex: '22'.repeat(32),
        baseNonceHex: '33'.repeat(24),
        chunkHashes: ['44'.repeat(32)],
        mimeType: 'image/png',
        fileName: 'diagram.png',
        targetItemIndex: 0,
        targetAttachmentIndex: 0,
        originRelayHint: 'https://relay.example.org',
      },
      preview: 'Attachment: diagram.png',
    },
    {
      item: {
        type: 'blob-manifest',
        version: 1,
        rootPlaintextSha256: 'aa'.repeat(32),
        totalPlaintextBytes: 524_288,
        chunkSize: 262_144,
        symmetricKeyHex: 'bb'.repeat(32),
        baseNonceHex: 'cc'.repeat(24),
        chunkHashes: ['dd'.repeat(32), 'ee'.repeat(32)],
      },
      preview: 'Encrypted attachment',
    },
  ],
})
