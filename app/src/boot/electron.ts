import { defineBoot as boot } from '@quasar/app-vite'

export default boot(({ app }) => {
  app.config.globalProperties.updateBadge = (unread: number) => {
    window.badge.setBadgeCount(unread)
  }

  app.config.globalProperties.openURL = (url: string) => {
    window.url.open(url)
  }
})
