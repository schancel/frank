import { boot } from 'quasar/wrappers'
import { reactive, watch } from 'vue'
import { useWalletStore } from '../stores/wallet'
import { useProfileStore } from '../stores/my-profile'
import { useContactStore } from '../stores/contacts'
import { useAppearanceStore } from '../stores/appearance'
import { useForumStore } from '../stores/forum'
import { useTopicStore } from '../stores/topics'
import { useChatStore } from '../stores/chats'
import { accountSession, accountStatus } from '../accounts/session'

export default boot(async ({ app }) => {
  // The wallet plugin inspects old data read-only and never hydrates secrets.
  await useWalletStore().restored
  await Promise.all([
    useProfileStore().restored,
    useContactStore().restored,
    useAppearanceStore().restored,
    useForumStore().restored,
    useChatStore().restored,
    useTopicStore().restored,
  ])
  const status = reactive({ loaded: false, setup: false })
  app.config.globalProperties.$status = status
  watch(
    () => accountStatus.status,
    value => {
      status.setup = value === 'ready'
      status.loaded = value !== 'loading'
    },
    { immediate: true },
  )
  await accountSession.initialize()
})
