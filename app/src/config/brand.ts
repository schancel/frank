import { readViteEnv } from '@frank/wallet/chain/vite-env'

export interface AppBrandProfile {
  readonly id: string
  readonly productName: string
  readonly shortName: string
  readonly description: string
  readonly appId: string
  readonly themeColor: string
  readonly backgroundColor: string
}

export const BUILTIN_BRANDS: Readonly<Record<string, AppBrandProfile>> = {
  frank: {
    id: 'frank',
    productName: 'Frank',
    shortName: 'Frank',
    description: 'Encrypted messaging and a multichain wallet',
    appId: 'org.cashweb.stamp',
    themeColor: '#121218',
    backgroundColor: '#f7f7f2',
  },
  plainspoken: {
    id: 'plainspoken',
    productName: 'Plainspoken',
    shortName: 'Plainspoken',
    description: 'Encrypted messaging and a multichain wallet',
    appId: 'org.cashweb.plainspoken',
    themeColor: '#121218',
    backgroundColor: '#f7f7f2',
  },
  signet: {
    id: 'signet',
    productName: 'Signet',
    shortName: 'Signet',
    description: 'Encrypted messaging and a multichain wallet',
    appId: 'org.cashweb.signet',
    themeColor: '#c8431e',
    backgroundColor: '#f7f7f2',
  },
  stamp: {
    id: 'stamp',
    productName: 'Stamp',
    shortName: 'Stamp',
    description: 'Encrypted messaging and a multichain wallet',
    appId: 'org.cashweb.stamp',
    themeColor: '#121218',
    backgroundColor: '#f7f7f2',
  },
  lotus: {
    id: 'lotus',
    productName: 'Lotus',
    shortName: 'Lotus',
    description: 'Encrypted messaging and a multichain wallet',
    appId: 'org.cashweb.lotus',
    themeColor: '#9d5cff',
    backgroundColor: '#f7f7fb',
  },
}

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function readEnvValue(
  key: string,
  env?: Record<string, string | undefined>,
): string | undefined {
  if (env && key in env) {
    return env[key]
  }
  const viteVal = readViteEnv(key)
  if (typeof viteVal === 'string' && viteVal) {
    return viteVal
  }
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key]
  }
  return undefined
}

export function resolveAppBrand(
  env?: Record<string, string | undefined>,
): AppBrandProfile {
  const rawBrand = (
    readEnvValue('APP_BRAND', env) ||
    readEnvValue('QCLI_APP_BRAND', env) ||
    'frank'
  ).trim()

  const normalizedId =
    rawBrand
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frank'

  const base: AppBrandProfile = BUILTIN_BRANDS[normalizedId] ?? {
    id: normalizedId,
    productName: titleCaseSlug(rawBrand),
    shortName: titleCaseSlug(rawBrand),
    description: 'Encrypted messaging and a multichain wallet',
    appId: `org.cashweb.${normalizedId.replace(/-/g, '')}`,
    themeColor: '#121218',
    backgroundColor: '#f7f7f2',
  }

  const customName = (
    readEnvValue('APP_BRAND_NAME', env) ||
    readEnvValue('QCLI_APP_BRAND_NAME', env) ||
    ''
  ).trim()
  const productName = customName || base.productName
  const shortName =
    (readEnvValue('APP_BRAND_SHORT_NAME', env) || '').trim() ||
    customName ||
    base.shortName
  const description =
    (readEnvValue('APP_BRAND_DESCRIPTION', env) || '').trim() ||
    base.description
  const appId = (readEnvValue('APP_BRAND_ID', env) || '').trim() || base.appId
  const themeColor =
    (readEnvValue('APP_BRAND_THEME_COLOR', env) || '').trim() || base.themeColor
  const backgroundColor =
    (readEnvValue('APP_BRAND_BACKGROUND_COLOR', env) || '').trim() ||
    base.backgroundColor

  return {
    id: base.id,
    productName,
    shortName,
    description,
    appId,
    themeColor,
    backgroundColor,
  }
}

export function getActiveBrand(): AppBrandProfile {
  return resolveAppBrand()
}

/**
 * Recursively substitutes the default product name ("Frank") in locale
 * message dictionaries with the active brand's `productName`.
 * When `productName === 'Frank'`, returns the input dictionary untouched.
 */
export function applyBrandToLocaleMessages<T>(
  messages: T,
  productName = getActiveBrand().productName,
): T {
  if (!productName || productName === 'Frank') {
    return messages
  }
  if (typeof messages === 'string') {
    return messages.replace(/\bFrank\b/g, productName) as unknown as T
  }
  if (Array.isArray(messages)) {
    return messages.map(item =>
      applyBrandToLocaleMessages(item, productName),
    ) as unknown as T
  }
  if (messages && typeof messages === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(
      messages as Record<string, unknown>,
    )) {
      out[key] = applyBrandToLocaleMessages(value, productName)
    }
    return out as T
  }
  return messages
}
