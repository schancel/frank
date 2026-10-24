// Only the PIN scenario substitutes this module. Origin policy and all other exports stay real.
export * from '../../../src-bex/runtime-adapter.original'
import {
  isSimulatedExtension,
  openTab,
  closeView,
  message,
} from './pairing-runtime'
export const isBrowserExtensionRuntime = isSimulatedExtension
export const getRawExtensionApi = () =>
  isSimulatedExtension()
    ? {
        tabs: {
          create: () => {
            throw new Error('Use acknowledged openExtensionTab')
          },
        },
      }
    : null
export const openExtensionTab = openTab
export const closeExtensionView = closeView
// This slice sends requests only; update/expiry/race behavior is covered by sender Jest tests.
export const onRuntimeMessage: typeof import('../../../src-bex/runtime-adapter.original').onRuntimeMessage =
  () => () => undefined
export const sendRuntimeMessage = message
