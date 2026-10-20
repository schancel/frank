export type ExtensionTarget = 'chrome' | 'firefox' | 'safari'

export interface ExtensionContentScript {
  matches: string[]
  js: string[]
  run_at: 'document_start' | 'document_idle' | 'document_end'
  world?: 'MAIN' | 'ISOLATED'
}

export const EXTENSION_CONTENT_MATCHES = [
  'https://*/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
]

export function buildContentScripts(
  target: ExtensionTarget = 'chrome',
): ExtensionContentScript[] {
  if (target === 'safari') {
    return [
      {
        matches: [...EXTENSION_CONTENT_MATCHES],
        js: ['inpage.js'],
        run_at: 'document_start',
      },
      {
        matches: [...EXTENSION_CONTENT_MATCHES],
        js: ['content.js'],
        run_at: 'document_start',
      },
    ]
  }
  return [
    {
      matches: [...EXTENSION_CONTENT_MATCHES],
      js: ['inpage.js'],
      run_at: 'document_start',
      world: 'MAIN',
    },
    {
      matches: [...EXTENSION_CONTENT_MATCHES],
      js: ['content.js'],
      run_at: 'document_start',
      world: 'ISOLATED',
    },
  ]
}

export function buildExtensionManifest(
  target: ExtensionTarget,
  version = '0.3.0',
): Record<string, any> {
  const baseManifest: Record<string, any> = {
    manifest_version: 3,
    name: 'Frank',
    version,
    description:
      'Frank encrypted messenger, privacy pool, and dApp bridge companion',
    icons: {
      '16': 'icons/icon-128x128.png',
      '48': 'icons/icon-128x128.png',
      '128': 'icons/icon-128x128.png',
    },
    action: {
      default_popup: 'index.html?extMode=popup',
      default_title: 'Frank',
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    content_scripts: buildContentScripts(target),
  }

  if (target === 'chrome') {
    return {
      ...baseManifest,
      permissions: [
        'storage',
        'sidePanel',
        'activeTab',
        'scripting',
        'offscreen',
      ],
      background: {
        service_worker: 'background.js',
        type: 'module',
      },
      side_panel: {
        default_path: 'index.html?extMode=sidepanel',
      },
    }
  }

  if (target === 'firefox') {
    return {
      ...baseManifest,
      browser_specific_settings: {
        gecko: {
          id: 'frank@signet.mx',
          strict_min_version: '128.0',
        },
      },
      permissions: ['storage', 'activeTab', 'scripting'],
      background: {
        scripts: ['background.js'],
        type: 'module',
      },
      sidebar_action: {
        default_panel: 'index.html?extMode=sidebar',
        default_title: 'Frank',
        default_icon: 'icons/icon-128x128.png',
      },
    }
  }

  if (target === 'safari') {
    return {
      ...baseManifest,
      permissions: ['storage', 'activeTab', 'scripting'],
      background: {
        service_worker: 'background.js',
      },
      web_accessible_resources: [
        {
          resources: ['inpage.js'],
          matches: ['<all_urls>'],
        },
      ],
    }
  }

  throw new Error(`Unsupported extension target: ${String(target)}`)
}
