// Only the PIN scenario substitutes this module. Origin policy and all other exports stay real.
export * from '../../../src-bex/runtime-adapter.original'
import {
  isSimulatedExtension,
  openTab,
  closeView,
  listen,
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
export const onRuntimeMessage = listen
export const sendRuntimeMessage = message
