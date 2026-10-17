const BUILTIN_BRANDS = {
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

function titleCaseSlug(slug) {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function resolveAppBrand(env = process.env) {
  const rawBrand = (
    env.APP_BRAND ||
    env.QCLI_APP_BRAND ||
    'frank'
  )
    .toString()
    .trim()
  const normalizedId =
    rawBrand
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frank'

  const base = BUILTIN_BRANDS[normalizedId] || {
    id: normalizedId,
    productName: titleCaseSlug(rawBrand),
    shortName: titleCaseSlug(rawBrand),
    description: 'Encrypted messaging and a multichain wallet',
    appId: `org.cashweb.${normalizedId.replace(/-/g, '')}`,
    themeColor: '#121218',
    backgroundColor: '#f7f7f2',
  }

  const productName =
    (env.APP_BRAND_NAME || env.QCLI_APP_BRAND_NAME || '').toString().trim() ||
    base.productName
  const shortName =
    (env.APP_BRAND_SHORT_NAME || '').toString().trim() ||
    (env.APP_BRAND_NAME || env.QCLI_APP_BRAND_NAME || '').toString().trim() ||
    base.shortName
  const description =
    (env.APP_BRAND_DESCRIPTION || '').toString().trim() || base.description
  const appId = (env.APP_BRAND_ID || '').toString().trim() || base.appId
  const themeColor =
    (env.APP_BRAND_THEME_COLOR || '').toString().trim() || base.themeColor
  const backgroundColor =
    (env.APP_BRAND_BACKGROUND_COLOR || '').toString().trim() ||
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

module.exports = {
  BUILTIN_BRANDS,
  resolveAppBrand,
}
