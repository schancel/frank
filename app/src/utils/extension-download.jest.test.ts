/** @jest-environment jsdom */

const targets = ['chrome', 'firefox', 'safari'] as const
const originalBuild = process.env.QCLI_GIT_COMMIT_HASH

function loadBuild(build: string): typeof import('./extension-download') {
  process.env.QCLI_GIT_COMMIT_HASH = build
  jest.resetModules()
  return jest.requireActual(
    './extension-download',
  ) as typeof import('./extension-download')
}

afterEach(() => {
  if (originalBuild === undefined) delete process.env.QCLI_GIT_COMMIT_HASH
  else process.env.QCLI_GIT_COMMIT_HASH = originalBuild
  jest.resetModules()
})

it('changes every browser download URL across builds while preserving artifact paths and metadata', () => {
  const first = loadBuild('build-a')
  const second = loadBuild('build-b')
  for (const target of targets) {
    const before = first.getExtensionDownloadInfo(target)
    const after = second.getExtensionDownloadInfo(target)
    expect(before.url).not.toBe(after.url)
    expect(after.url).toBe(`/downloads/frank-extension-${target}.zip?v=build-b`)
    expect(after).toEqual({ ...before, url: after.url })
    expect(after.filename).toBe(`frank-extension-${target}.zip`)
    expect(after).toBe(second.EXTENSION_DOWNLOAD_TARGETS[target])
  }
})

it('keeps URLs stable within a build and encodes the build identifier as one query value', () => {
  const build = 'release/a+b &c?#é'
  const first = loadBuild(build)
  const second = loadBuild(build)
  for (const target of targets) {
    const info = first.getExtensionDownloadInfo(target)
    expect(info.url).toBe(second.getExtensionDownloadInfo(target).url)
    const url = new URL(info.url, 'https://signet.mx/nested/page')
    expect(url.pathname).toBe(`/downloads/frank-extension-${target}.zip`)
    expect(url.searchParams.get('v')).toBe(build)
    expect([...url.searchParams.keys()]).toEqual(['v'])
    expect(url.hash).toBe('')
  }
})

it('uses the versioned URL and unchanged filename for imperative downloads', () => {
  const downloads = loadBuild('click-build')
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.getAttribute('href')).toBe(
        '/downloads/frank-extension-safari.zip?v=click-build',
      )
      expect(this.download).toBe('frank-extension-safari.zip')
    })
  try {
    downloads.triggerExtensionDownload('safari')
    expect(click).toHaveBeenCalledTimes(1)
    expect(document.querySelector('a')).toBeNull()
  } finally {
    click.mockRestore()
  }
})

describe('canInstallDesktopExtension', () => {
  const { canInstallDesktopExtension } = jest.requireActual(
    './extension-download',
  ) as typeof import('./extension-download')
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      false,
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      false,
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      true,
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      true,
    ],
  ])('%s -> %s', (ua, expected) => {
    expect(canInstallDesktopExtension(ua)).toBe(expected)
  })
})
