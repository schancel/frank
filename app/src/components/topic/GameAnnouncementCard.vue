<template>
  <q-card
    flat
    bordered
    class="game-announcement-card q-my-sm q-pa-sm"
    :class="$q.dark.isActive ? 'bg-grey-9 text-white' : 'bg-grey-2 text-dark'"
    data-test="game-discovery-card"
  >
    <div class="row items-center justify-between no-wrap q-col-gutter-sm">
      <div class="row items-center q-gutter-x-sm col-grow no-wrap">
        <q-avatar
          size="36px"
          color="primary"
          text-color="white"
          :icon="gameIcon"
          class="q-mr-xs"
        />
        <div class="column justify-center">
          <div
            class="row items-center no-wrap text-weight-bold text-subtitle2"
          >
            <span>{{ announcement.gameName }}</span>
            <q-badge
              v-if="announcement.tableId"
              color="accent"
              class="q-ml-xs text-caption font-mono"
            >
              #{{ shortTableId }}
            </q-badge>
          </div>
          <div
            class="text-caption"
            :class="$q.dark.isActive ? 'text-grey-4' : 'text-grey-7'"
          >
            <span v-if="announcement.buyInAmount">
              Buy-in: {{ announcement.buyInAmount }}
            </span>
            <span v-if="announcement.currentPlayers !== undefined">
              <span v-if="announcement.buyInAmount"> • </span>
              Players: {{ announcement.currentPlayers }}/{{
                announcement.maxPlayers || '?'
              }}
            </span>
            <span v-if="announcement.hostAddress">
              • Host: {{ formattedHostAddress }}
            </span>
          </div>
        </div>
      </div>

      <div class="row items-center q-gutter-x-xs no-wrap">
        <q-btn
          color="primary"
          unelevated
          size="sm"
          icon="play_arrow"
          no-caps
          :label="announcement.callToAction || 'Join Table'"
          :to="joinRoute"
          @click="openRoute(joinRoute)"
          data-test="join-table-btn"
        />
        <q-btn
          v-if="hostRoute"
          outline
          color="secondary"
          size="sm"
          icon="chat"
          no-caps
          label="Message Host"
          :to="hostRoute"
          @click="openRoute(hostRoute)"
          data-test="message-host-btn"
        />
      </div>
    </div>
  </q-card>
</template>

<script lang="ts">
import { defineComponent, computed, getCurrentInstance } from 'vue'
import type { PropType } from 'vue'
import type { ParsedGameAnnouncement } from 'src/utils/game-announcement'
import { getJoinRoute, getHostRoute } from 'src/utils/game-announcement'

export default defineComponent({
  name: 'GameAnnouncementCard',
  props: {
    announcement: {
      type: Object as PropType<ParsedGameAnnouncement>,
      required: true,
    },
  },
  setup(props) {
    const instance = getCurrentInstance()
    const getRouter = () => (instance?.proxy as any)?.$router

    const gameIcon = computed(() => {
      const name = props.announcement.gameName.toLowerCase()
      if (name.includes('poker')) return 'style'
      if (name.includes('dice')) return 'casino'
      if (name.includes('blackjack')) return 'view_carousel'
      return 'sports_esports'
    })

    const shortTableId = computed(() => {
      const id = props.announcement.tableId
      return id && id.length > 8 ? id.slice(0, 8) : id
    })

    const formattedHostAddress = computed(() => {
      const addr = props.announcement.hostAddress
      if (!addr) return 'Unknown'
      if (addr.length <= 14) return addr
      return `${addr.slice(0, 6)}...${addr.slice(-4)}`
    })

    const joinRoute = computed(() => getJoinRoute(props.announcement))
    const hostRoute = computed(() => getHostRoute(props.announcement))

    const openRoute = (route?: string) => {
      const router = getRouter()
      if (route && router) {
        try {
          const res = router.push(route)
          if (res && typeof (res as any).catch === 'function') {
            ;(res as any).catch(() => {})
          }
        } catch {
          // ignore navigation error
        }
      }
    }

    return {
      gameIcon,
      shortTableId,
      formattedHostAddress,
      joinRoute,
      hostRoute,
      openRoute,
    }
  },
})
</script>

<style scoped>
.game-announcement-card {
  border-radius: 8px;
}
</style>
