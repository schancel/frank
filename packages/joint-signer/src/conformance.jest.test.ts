import { runConformance } from './conformance.js'
import { createFrankLindellBackend } from './frank-lindell/backend.js'
import { loadSilenceDklsNode } from './silence-dkls/load-node.js'

// The same suite, unchanged, against every backend.
runConformance('silence-dkls', () => loadSilenceDklsNode())
runConformance('frank-lindell', () => createFrankLindellBackend())
