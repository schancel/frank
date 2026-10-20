export type ExtensionTargetBrowser = 'chrome' | 'firefox' | 'safari'

export const FA_PLUG_ICON =
  'M96 0C78.3 0 64 14.3 64 32v96h64V32c0-17.7-14.3-32-32-32zM288 0c-17.7 0-32 14.3-32 32v96h64V32c0-17.7-14.3-32-32-32zM32 160c-17.7 0-32 14.3-32 32s14.3 32 32 32v32c0 77.4 55 142 128 156.8V480c0 17.7 14.3 32 32 32s32-14.3 32-32V412.8C297 398 352 333.4 352 256V224c17.7 0 32-14.3 32-32s-14.3-32-32-32H32z|0 0 384 512'

export const FA_PLUG_CIRCLE_PLUS_ICON =
  'M96 0C78.3 0 64 14.3 64 32v96h64V32c0-17.7-14.3-32-32-32zM288 0c-17.7 0-32 14.3-32 32v96h64V32c0-17.7-14.3-32-32-32zM32 160c-17.7 0-32 14.3-32 32s14.3 32 32 32v32c0 77.4 55 142 128 156.8V480c0 17.7 14.3 32 32 32s32-14.3 32-32V412.8c12.3-2.5 24.1-6.4 35.1-11.5c-2.1-10.8-3.1-21.9-3.1-33.3c0-97.2 78.8-176 176-176c26.5 0 51.6 5.9 74.1 16.4c4.9-5.2 5.9-11.4 5.9-16.4c0-17.7-14.3-32-32-32H32zM432 512a144 144 0 1 0 0-288 144 144 0 1 0 0 288zm16-208v48h48c8.8 0 16 7.2 16 16s-7.2 16-16 16H448v48c0 8.8-7.2 16-16 16s-16-7.2-16-16V384H368c-8.8 0-16-7.2-16-16s7.2-16 16-16h48V304c0-8.8 7.2-16 16-16s16 7.2 16 16z|0 0 576 512'

export interface ExtensionDownloadTargetInfo {
  target: ExtensionTargetBrowser
  label: string
  shortLabel: string
  filename: string
  url: string
  installHint: string
}

export const EXTENSION_DOWNLOAD_TARGETS: Record<
  ExtensionTargetBrowser,
  ExtensionDownloadTargetInfo
> = {
  chrome: {
    target: 'chrome',
    label: 'Download Chrome / Brave Extension (.zip)',
    shortLabel: 'Chrome / Brave',
    filename: 'frank-extension-chrome.zip',
    url: '/downloads/frank-extension-chrome.zip',
    installHint:
      'Unzip and load via chrome://extensions (enable Developer Mode -> Load unpacked or drag zip).',
  },
  firefox: {
    target: 'firefox',
    label: 'Download Firefox Extension (.zip)',
    shortLabel: 'Firefox',
    filename: 'frank-extension-firefox.zip',
    url: '/downloads/frank-extension-firefox.zip',
    installHint:
      'Load via about:debugging#/runtime/this-firefox -> Load Temporary Add-on.',
  },
  safari: {
    target: 'safari',
    label: 'Download Safari Extension (.zip)',
    shortLabel: 'Safari',
    filename: 'frank-extension-safari.zip',
    url: '/downloads/frank-extension-safari.zip',
    installHint:
      'Unzip and convert with xcrun safari-web-extension-converter or enable in Safari -> Settings -> Extensions.',
  },
}

export function detectPreferredExtensionTarget(
  userAgent?: string,
): ExtensionTargetBrowser {
  const ua =
    typeof userAgent === 'string'
      ? userAgent
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : ''
  if (/Firefox\//i.test(ua)) {
    return 'firefox'
  }
  if (
    /Safari\//i.test(ua) &&
    !/Chrome\//i.test(ua) &&
    !/Chromium\//i.test(ua) &&
    !/Edg\//i.test(ua) &&
    !/OPR\//i.test(ua)
  ) {
    return 'safari'
  }
  return 'chrome'
}

export function getExtensionDownloadInfo(
  target?: ExtensionTargetBrowser,
): ExtensionDownloadTargetInfo {
  const resolved = target ?? detectPreferredExtensionTarget()
  return EXTENSION_DOWNLOAD_TARGETS[resolved] ?? EXTENSION_DOWNLOAD_TARGETS.chrome
}

export function triggerExtensionDownload(
  target?: ExtensionTargetBrowser,
): ExtensionDownloadTargetInfo {
  const info = getExtensionDownloadInfo(target)
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const a = document.createElement('a')
    a.href = info.url
    a.download = info.filename
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body?.appendChild(a)
    a.click()
    a.remove()
  }
  return info
}
