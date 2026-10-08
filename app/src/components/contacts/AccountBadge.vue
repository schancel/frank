<template>
  <q-badge
    v-if="badgeInfo"
    :color="badgeInfo.color"
    :text-color="badgeInfo.textColor"
    :outline="badgeInfo.outline"
    class="account-badge q-ml-xs text-bold"
    :data-test="badgeInfo.testId"
    :data-testid="badgeInfo.testId"
    style="
      font-size: 10px;
      padding: 2px 5px;
      line-height: 1.1;
      vertical-align: middle;
      border-radius: 4px;
    "
  >
    <q-icon
      v-if="badgeInfo.icon"
      :name="badgeInfo.icon"
      size="11px"
      class="q-mr-xs"
    />
    {{ $t(badgeInfo.i18nKey) }}
  </q-badge>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { useContactStore } from 'src/stores/contacts'
import { inferCuratedBotAttributes } from 'src/utils/curated-bots'

export default defineComponent({
  name: 'AccountBadge',
  props: {
    address: {
      type: String,
      default: '',
    },
    accountType: {
      type: Number,
      default: undefined,
    },
    botRole: {
      type: Number,
      default: undefined,
    },
    isBot: {
      type: Boolean,
      default: undefined,
    },
    curated: {
      type: Boolean,
      default: undefined,
    },
  },
  setup(props) {
    const contactStore = useContactStore()

    const badgeInfo = computed(() => {
      const isCurated =
        props.curated !== undefined
          ? props.curated
          : props.address && typeof contactStore.isCurated === 'function'
          ? contactStore.isCurated(props.address)
          : false

      const contactProfile =
        props.address && typeof contactStore.getContactProfile === 'function'
          ? contactStore.getContactProfile(props.address)
          : undefined

      const inferred =
        isCurated && contactProfile?.name
          ? inferCuratedBotAttributes(contactProfile.name)
          : {}

      const type =
        props.accountType !== undefined
          ? props.accountType
          : contactProfile?.accountType !== undefined
          ? contactProfile.accountType
          : inferred.accountType !== undefined
          ? inferred.accountType
          : (props.isBot ?? contactProfile?.isBot ?? inferred.isBot)
          ? 1
          : 0

      const role =
        props.botRole !== undefined
          ? props.botRole
          : contactProfile?.botRole !== undefined
          ? contactProfile.botRole
          : inferred.botRole

      if (isCurated) {
        if (type === 2 && role === 2) {
          return {
            i18nKey: 'profile.badgeFaucet',
            icon: 'payments',
            color: 'teal-7',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-faucet',
          }
        }
        if (type === 1 && role === 1) {
          return {
            i18nKey: 'profile.badgeAi',
            icon: 'auto_awesome',
            color: 'deep-purple-6',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-ai',
          }
        }
        if ((type === 1 || type === 2) && role === 3) {
          return {
            i18nKey: 'profile.badgeOfficialGame',
            icon: 'casino',
            color: 'red-7',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-game',
          }
        }
        if ((type === 1 || type === 2) && role === 5) {
          return {
            i18nKey: 'profile.badgeOfficialMerchant',
            icon: 'storefront',
            color: 'green-8',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-merchant',
          }
        }
        if ((type === 1 || type === 2) && role === 6) {
          return {
            i18nKey: 'profile.badgeOfficialModerator',
            icon: 'shield',
            color: 'blue-8',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-moderator',
          }
        }
        if ((type === 1 || type === 2) && role === 7) {
          return {
            i18nKey: 'profile.badgeOfficialAnnouncer',
            icon: 'campaign',
            color: 'orange-8',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-announcer',
          }
        }
        if ((type === 1 || type === 2) && role === 4) {
          return {
            i18nKey: 'profile.badgeOfficialBridge',
            icon: 'swap_horiz',
            color: 'cyan-8',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-bridge',
          }
        }
        if (type === 1) {
          return {
            i18nKey: 'profile.badgeOfficialBot',
            icon: 'smart_toy',
            color: 'purple-7',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-bot',
          }
        }
        if (type === 2) {
          return {
            i18nKey: 'profile.badgeOfficialService',
            icon: 'build',
            color: 'teal-8',
            textColor: 'white',
            outline: false,
            testId: 'badge-official-service',
          }
        }
        return {
          i18nKey: 'profile.badgeOfficial',
          icon: 'verified',
          color: 'primary',
          textColor: 'white',
          outline: false,
          testId: 'badge-official',
        }
      }

      // Not curated
      if (type === 1 || type === 2 || props.isBot) {
        if (role === 1) {
          return {
            i18nKey: 'profile.botRoleAssistant',
            icon: 'auto_awesome',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-ai',
          }
        }
        if (role === 2) {
          return {
            i18nKey: 'profile.botRoleFaucet',
            icon: 'payments',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-faucet',
          }
        }
        if (role === 3) {
          return {
            i18nKey: 'profile.badgeGame',
            icon: 'casino',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-game',
          }
        }
        if (role === 5) {
          return {
            i18nKey: 'profile.badgeMerchant',
            icon: 'storefront',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-merchant',
          }
        }
        if (role === 6) {
          return {
            i18nKey: 'profile.badgeModerator',
            icon: 'shield',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-moderator',
          }
        }
        if (role === 7) {
          return {
            i18nKey: 'profile.badgeAnnouncer',
            icon: 'campaign',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-announcer',
          }
        }
        if (role === 4) {
          return {
            i18nKey: 'profile.badgeBridge',
            icon: 'swap_horiz',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-bridge',
          }
        }
        if (type === 2) {
          return {
            i18nKey: 'profile.accountTypeService',
            icon: 'build',
            color: 'grey-7',
            textColor: undefined,
            outline: true,
            testId: 'badge-service',
          }
        }
        return {
          i18nKey: 'profile.badgeBot',
          icon: 'smart_toy',
          color: 'grey-7',
          textColor: undefined,
          outline: true,
          testId: 'badge-bot',
        }
      }

      if (type === 3) {
        return {
          i18nKey: 'profile.accountTypeOrganization',
          icon: 'corporate_fare',
          color: 'grey-7',
          textColor: undefined,
          outline: true,
          testId: 'badge-org',
        }
      }

      return null
    })

    return {
      badgeInfo,
    }
  },
})
</script>
