<template>
  <div class="q-mb-sm" data-testid="chat-message-swap">
    <q-card flat bordered class="q-pa-sm" :class="cardBg">
      <!-- Title & Status Badge -->
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

      <!-- Leadership / Standby Banner if not active master -->
      <div
        v-if="isStandby"
        class="row items-center justify-between q-py-xs q-px-sm q-mb-xs bg-amber-1 text-amber-10 rounded-borders"
        data-testid="swap-standby-banner"
      >
        <span class="text-caption">
          {{
            $t('chatMessageSwap.activeOnOtherDevice', {
              device: masterDeviceName,
            })
          }}
        </span>
        <q-btn
          flat
          dense
          size="xs"
          color="primary"
          :label="$t('chatMessageSwap.takeOverActive')"
          data-testid="swap-takeover-btn"
          @click="takeOverActiveRole"
        />
      </div>

      <!-- Offered and Requested Assets -->
      <div class="q-my-sm">
        <div class="row items-center q-mb-xs">
          <span class="text-caption text-grey-7 q-mr-xs">
            {{ $t('chatMessageSwap.offered') }}:
          </span>
          <span class="text-weight-bold">
            {{ offeredAmount }} {{ offeredAsset }}
          </span>
          <q-badge outline color="primary" class="q-ml-xs">
            {{ offeredChain }}
          </q-badge>
        </div>
        <div class="row items-center">
          <span class="text-caption text-grey-7 q-mr-xs">
            {{ $t('chatMessageSwap.for') }}:
          </span>
          <span class="text-weight-bold">
            {{ requestedAmount }} {{ requestedAsset }}
          </span>
          <q-badge outline color="secondary" class="q-ml-xs">
            {{ requestedChain }}
          </q-badge>
        </div>
      </div>

      <!-- Transaction Explorer Links -->
      <div v-if="hasExplorerLinks" class="q-my-xs q-gutter-x-sm text-caption">
        <a
          v-if="legATxUrl"
          :href="legATxUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary"
          data-testid="swap-leg-a-tx-link"
        >
          {{ $t('chatMessageSwap.viewTx', { chain: offeredChain }) }}
        </a>
        <a
          v-if="legBTxUrl"
          :href="legBTxUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-secondary"
          data-testid="swap-leg-b-tx-link"
        >
          {{ $t('chatMessageSwap.viewTx', { chain: requestedChain }) }}
        </a>
        <a
          v-if="claimTxUrl"
          :href="claimTxUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-positive"
          data-testid="swap-claim-tx-link"
        >
          {{
            $t('chatMessageSwap.viewTx', {
              chain: outbound ? requestedChain : offeredChain,
            })
          }}
        </a>
      </div>

      <!-- Swaps are not available yet: this card moves no funds in any state -->
      <div
        class="text-caption text-grey-7 q-mt-xs"
        data-testid="swap-unavailable-note"
      >
        {{ $t('chatMessageSwap.notAvailableYet') }}
      </div>

      <!-- Actions based on role & lifecycle phase -->
      <div class="row justify-end q-mt-sm q-gutter-xs">
        <!-- Cancel button (Maker when pending) -->
        <q-btn
          v-if="canCancel"
          flat
          dense
          color="negative"
          size="sm"
          :label="$t('chatMessageSwap.cancel')"
          data-testid="swap-cancel-btn"
          @click="$emit('cancel', swapId)"
        />

        <!-- Accept button (Taker when pending) -->
        <q-btn
          v-if="canAccept"
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
import { multiChainExplorerUrl } from '../../../utils/explorer'
import { useLeaderStore } from '../../../stores/leader'

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
    hashLock: {
      type: String,
      default: '',
    },
    preimage: {
      type: String,
      default: '',
    },
    legATxHash: {
      type: String,
      default: '',
    },
    legBTxHash: {
      type: String,
      default: '',
    },
    claimTxHash: {
      type: String,
      default: '',
    },
    originInstanceId: {
      type: String,
      default: '',
    },
    recipientAddress: {
      type: String,
      default: '',
    },
  },
  emits: ['accept', 'cancel'],
  setup() {
    const $q = useQuasar()
    let leaderStore: any
    try {
      leaderStore = useLeaderStore()
    } catch {
      leaderStore = {
        isStandby: false,
        isActiveMaster: true,
        masterDeviceName: null,
        claimMasterRole: () => {
          /* no-op fallback mock */
        },
      }
    }

    return {
      cardBg: $q?.dark?.isActive ? 'bg-grey-9' : 'bg-grey-2',
      leaderStore,
    }
  },
  computed: {
    isStandby(): boolean {
      return this.leaderStore?.isStandby ?? false
    },
    masterDeviceName(): string {
      return this.leaderStore?.masterDeviceName || 'another device'
    },
    statusColor(): string {
      switch (this.status) {
        case 'pending':
          return 'orange'
        case 'accepted':
          return 'teal'
        case 'locked':
          return 'indigo'
        case 'settled':
          return 'positive'
        case 'cancelled':
        case 'expired':
        default:
          return 'grey-6'
      }
    },
    canCancel(): boolean {
      return this.status === 'pending' && this.outbound
    },
    canAccept(): boolean {
      return this.status === 'pending' && !this.outbound
    },
    legATxUrl(): string | undefined {
      return multiChainExplorerUrl(this.legATxHash, this.offeredChain)
    },
    legBTxUrl(): string | undefined {
      return multiChainExplorerUrl(this.legBTxHash, this.requestedChain)
    },
    claimTxUrl(): string | undefined {
      return multiChainExplorerUrl(
        this.claimTxHash,
        this.outbound ? this.requestedChain : this.offeredChain,
      )
    },
    hasExplorerLinks(): boolean {
      return !!this.legATxUrl || !!this.legBTxUrl || !!this.claimTxUrl
    },
  },
  methods: {
    takeOverActiveRole() {
      this.leaderStore?.claimMasterRole()
    },
  },
})
</script>
