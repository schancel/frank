export type ExtensionTargetBrowser = 'chrome' | 'firefox' | 'safari'

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
