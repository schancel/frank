<template>
  <div class="q-py-sm" data-testid="dapp-swap-view">
    <template v-if="venue">
      <!-- Which venue is in use, and a choice when the chain has more than one. -->
      <div
        v-if="venue.label"
        class="row items-center justify-between q-px-xs q-pb-sm"
      >
        <div class="row items-center q-gutter-x-xs">
          <q-icon name="swap_horiz" color="primary" size="18px" />
          <template v-if="venues.length > 1">
            <q-btn
              v-for="option in venues"
              :key="option.id"
              dense
              no-caps
              unelevated
              size="sm"
              :outline="option.id !== venue.id"
              :color="option.id === venue.id ? 'primary' : 'grey-7'"
              :label="option.label"
              :data-testid="`swap-venue-${option.id}`"
              @click="chosenVenueId = option.id"
            />
          </template>
          <span
            v-else
            class="text-subtitle2 text-weight-bold"
            data-testid="swap-venue"
          >
            {{ venue.label }}
          </span>
        </div>
        <span
          v-if="venue.note"
          class="text-caption text-grey-7"
          data-testid="swap-venue-note"
        >
          {{ $t(venue.note.key, venue.note.params ?? {}) }}
        </span>
      </div>
      <component
        :is="venue.panel"
        :key="`${selectedWallet}:${venue.id}`"
        v-bind="venue.panelProps"
      />
    </template>
    <q-card v-else flat bordered>
      <q-card-section role="status" data-testid="swap-unavailable">
        <div class="text-subtitle1 text-weight-medium">
          {{ $t('walletPanel.swapUnavailable') }}
        </div>
        <p class="text-body2 text-grey-7 q-mt-sm q-mb-none">
          {{ $t('swap.unavailableNetwork') }}
        </p>
      </q-card-section>
    </q-card>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, ref, watch } from 'vue'
import { swapVenuesForWallet } from 'src/swap/venues'

/**
 * The swap shell. It knows a wallet's venues only through `SwapVenuePresentation` (an id, a
 * label, a note, a panel): it names the venue in use, offers a choice when there are several,
 * and mounts that venue's panel. What a swap is on any chain family is the panel's business.
 */
export default defineComponent({
  name: 'DAppSwapView',
  props: {
    selectedWallet: {
      type: String,
      default: 'monad',
    },
    isTestnet: {
      type: Boolean,
      default: true,
    },
  },
  setup(props) {
    const venues = computed(() =>
      swapVenuesForWallet(props.selectedWallet, props.isTestnet),
    )
    const chosenVenueId = ref<string>()
    watch(
      () => [props.selectedWallet, props.isTestnet],
      () => {
        chosenVenueId.value = undefined
      },
    )
    const venue = computed(
      () =>
        venues.value.find(option => option.id === chosenVenueId.value) ??
        venues.value[0],
    )
    return { venues, venue, chosenVenueId }
  },
})
</script>
