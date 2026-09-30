<template>
  <div class="digital-goods q-pa-sm" style="min-width: 220px">
    <template v-if="item.action === 'catalog'">
      <div class="text-caption text-weight-bold q-mb-xs">Catalog</div>
      <div
        v-for="entry in shownEntries"
        :key="entry.itemId"
        class="row items-center q-gutter-sm q-mb-xs"
      >
        <img
          v-if="thumbnailSrc(entry.thumbnail)"
          class="catalog-thumbnail"
          :src="thumbnailSrc(entry.thumbnail)"
          alt=""
          width="64"
          height="48"
          style="object-fit: cover; border-radius: 4px"
        />
        <div class="col text-caption">
          {{ entry.description }} -- {{ displayPrice(entry.priceWei) }}
        </div>
        <q-btn
          label="Buy"
          dense
          color="primary"
          :loading="buyingItemId === entry.itemId"
          :disable="!!buyingItemId"
          @click="onBuy(entry)"
        />
      </div>
      <div v-if="hiddenCount > 0" class="text-caption text-grey">
        {{ hiddenCount }} more item{{ hiddenCount === 1 ? '' : 's' }} not shown
      </div>
    </template>
    <div v-else-if="item.action === 'request'" class="text-caption">
      Requested: {{ item.itemId }}
    </div>
    <div
      v-else-if="item.action === 'fulfill'"
      class="text-caption text-weight-bold"
    >
      Here's your purchase ({{ item.itemId }}):
    </div>
    <div v-else-if="item.action === 'error'" class="text-caption text-negative">
      {{ item.message }}
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue'

import { DigitalGoodsItem } from '@frank/cashweb/types/messages'
import { activeChain } from '@frank/wallet/chain'

import {
  inspectImageDataUri,
  MAX_RENDERED_CATALOG_ENTRIES,
  THUMBNAIL_LIMITS,
} from '../../../utils/image-data-uri'
import { errorNotify } from '../../../utils/notifications'

export default defineComponent({
  name: 'ChatMessageDigitalGoods',
  props: {
    item: {
      type: Object as PropType<DigitalGoodsItem>,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
  },
  emits: ['sendFollowUp'],
  data() {
    return {
      buyingItemId: null as string | null,
    }
  },
  computed: {
    shownEntries(): NonNullable<DigitalGoodsItem['catalog']> {
      const catalog = this.item.catalog
      return Array.isArray(catalog)
        ? catalog.slice(0, MAX_RENDERED_CATALOG_ENTRIES)
        : []
    },
    hiddenCount(): number {
      const catalog = this.item.catalog
      return Array.isArray(catalog)
        ? Math.max(0, catalog.length - MAX_RENDERED_CATALOG_ENTRIES)
        : 0
    },
  },
  methods: {
    // Only an inline image data URI is ever rendered: a bot-supplied remote URL would make the
    // viewer's client fetch it (leaking that they opened the chat), so anything else is ignored.
    thumbnailSrc(thumbnail: string | undefined): string | undefined {
      return inspectImageDataUri(thumbnail, THUMBNAIL_LIMITS).ok
        ? thumbnail
        : undefined
    },
    // The price comes from an untrusted peer: never throw while rendering.
    displayPrice(priceWei: string): string {
      try {
        if (!/^\d{1,40}$/.test(String(priceWei))) return 'price unavailable'
        return `${activeChain.toDisplayAmount(BigInt(priceWei))} ${
          activeChain.unit
        }`
      } catch {
        return 'price unavailable'
      }
    },
    async onBuy(entry: { itemId: string; priceWei: string }) {
      if (this.buyingItemId) return
      this.buyingItemId = entry.itemId
      try {
        this.$emit('sendFollowUp', {
          items: [
            { type: 'digital-goods', action: 'request', itemId: entry.itemId },
          ],
          stampValueWei: BigInt(entry.priceWei),
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        this.buyingItemId = null
      }
    },
  },
})
</script>
