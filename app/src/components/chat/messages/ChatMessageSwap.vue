<template>
  <div class="q-mb-sm" data-testid="chat-message-swap">
    <q-card flat bordered class="q-pa-sm" :class="cardBg">
      <div class="row items-center justify-between q-mb-xs">
        <div class="row items-center">
          <q-icon name="swap_horiz" size="sm" color="primary" class="q-mr-xs" />
          <span class="text-weight-bold text-subtitle2">
            {{ $t('chatMessageSwap.title') }}
          </span>
        </div>
        <q-badge :color="statusColor" data-testid="swap-status-badge">
          {{ status }}
        </q-badge>
      </div>

      <div class="q-my-sm">
        <div class="row items-center q-mb-xs">
          <span class="text-caption text-grey-7 q-mr-xs">{{ $t('chatMessageSwap.offered') }}:</span>
          <span class="text-weight-bold">{{ offeredAmount }} {{ offeredAsset }}</span>
          <q-badge outline color="primary" class="q-ml-xs">
            {{ offeredChain }}
          </q-badge>
        </div>
        <div class="row items-center">
          <span class="text-caption text-grey-7 q-mr-xs">{{ $t('chatMessageSwap.for') }}:</span>
          <span class="text-weight-bold">{{ requestedAmount }} {{ requestedAsset }}</span>
          <q-badge outline color="secondary" class="q-ml-xs">
            {{ requestedChain }}
          </q-badge>
        </div>
      </div>

      <div v-if="status === 'pending'" class="row justify-end q-mt-sm q-gutter-xs">
        <q-btn
          v-if="outbound"
          flat
          dense
          color="negative"
          size="sm"
          :label="$t('chatMessageSwap.cancel')"
          data-testid="swap-cancel-btn"
          @click="$emit('cancel', swapId)"
        />
        <q-btn
          v-else
          flat
          dense
          color="positive"
          size="sm"
          :label="$t('chatMessageSwap.accept')"
          data-testid="swap-accept-btn"
          @click="$emit('accept', swapId)"
        />
      </div>
    </q-card>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useQuasar } from 'quasar'

export default defineComponent({
  name: 'ChatMessageSwap',
  props: {
    swapId: {
      type: String,
      required: true,
    },
    offeredChain: {
      type: String,
      required: true,
    },
    offeredAsset: {
      type: String,
      required: true,
    },
    offeredAmount: {
      type: String,
      required: true,
    },
    requestedChain: {
      type: String,
      required: true,
    },
    requestedAsset: {
      type: String,
      required: true,
    },
    requestedAmount: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      default: 'pending',
    },
    outbound: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['accept', 'cancel'],
  setup() {
    const $q = useQuasar()
    return {
      cardBg: $q?.dark?.isActive ? 'bg-grey-9' : 'bg-grey-2',
    }
  },
  computed: {
    statusColor(): string {
      switch (this.status) {
        case 'pending':
          return 'orange'
        case 'accepted':
          return 'teal'
        case 'settled':
          return 'positive'
        case 'cancelled':
        case 'expired':
        default:
          return 'grey-6'
      }
    },
  },
})
</script>
