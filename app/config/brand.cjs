const BUILTIN_BRANDS = require('./brands.json')

function titleCaseSlug(slug) {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function resolveAppBrand(env = process.env) {
  const rawBrand = (env.APP_BRAND || env.QCLI_APP_BRAND || 'frank')
    .toString()
    .trim()
  const normalizedId =
    rawBrand
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frank'

  const defaultFrank = BUILTIN_BRANDS.frank
  const base = BUILTIN_BRANDS[normalizedId] || {
    id: normalizedId,
    productName: titleCaseSlug(rawBrand),
    shortName: titleCaseSlug(rawBrand),
    description: defaultFrank.description,
    appId: `org.cashweb.${normalizedId.replace(/-/g, '')}`,
    themeColor: defaultFrank.themeColor,
    backgroundColor: defaultFrank.backgroundColor,
    heroLogo: defaultFrank.heroLogo,
    sidebarLogo: defaultFrank.sidebarLogo,
    publicIcons: defaultFrank.publicIcons,
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
  const heroLogo =
    (env.APP_BRAND_HERO_LOGO || '').toString().trim() || base.heroLogo
  const sidebarLogo =
    (env.APP_BRAND_SIDEBAR_LOGO || '').toString().trim() || base.sidebarLogo

  return {
    id: base.id,
    productName,
    shortName,
    description,
    appId,
    themeColor,
    backgroundColor,
    heroLogo,
    sidebarLogo,
    publicIcons: base.publicIcons || {},
  }
}

module.exports = {
  BUILTIN_BRANDS,
  resolveAppBrand,
}
