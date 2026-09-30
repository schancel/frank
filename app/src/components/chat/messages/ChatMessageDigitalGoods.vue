<template>
  <div class="digital-goods q-pa-sm" style="min-width: 220px">
    <template v-if="item.action === 'catalog'">
      <div class="text-caption text-weight-bold q-mb-xs">
        {{ $t('digitalGoods.catalog') }}
      </div>
      <template v-for="entry in shownEntries" :key="entry.itemId">
        <div class="row items-center q-gutter-sm q-mb-xs">
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
            v-if="confirmingItemId !== entry.itemId"
            :label="$t('digitalGoods.buy')"
            dense
            color="primary"
            data-testid="goods-buy"
            :data-item-id="entry.itemId"
            :loading="buyingItemId === entry.itemId"
            :disable="!!buyingItemId || !hasValidPrice(entry)"
            @click="openConfirm(entry.itemId)"
          />
        </div>
        <!-- Buying pays the vendor immediately (the price is the message stamp), so it always takes
      a second, explicit step that names the item, the price and who gets the money. -->
        <div
          v-if="confirmingItemId === entry.itemId"
          class="q-mb-sm q-pa-xs"
          role="group"
          tabindex="-1"
          :aria-label="
            $t('digitalGoods.confirmGroupLabel', { item: entry.description })
          "
          :data-item-id="entry.itemId"
          data-testid="goods-confirm"
        >
          <div class="text-caption">
            {{
              $t('digitalGoods.confirmPrompt', {
                item: entry.description,
                price: displayPrice(entry.priceWei),
                name: recipientLabel,
                address: shortRecipient,
              })
            }}
          </div>
          <div class="q-gutter-xs q-mt-xs">
            <q-btn
              :label="
                $t('digitalGoods.confirmBuy', {
                  price: displayPrice(entry.priceWei),
                })
              "
              dense
              color="primary"
              data-testid="goods-confirm-buy"
              :loading="buyingItemId === entry.itemId"
              :disable="!!buyingItemId"
              @click="confirmAndBuy(entry)"
            />
            <q-btn
              :label="$t('digitalGoods.cancel')"
              dense
              flat
              data-testid="goods-confirm-cancel"
              :disable="!!buyingItemId"
              @click="cancelConfirm(entry.itemId)"
            />
          </div>
        </div>
      </template>
      <div v-if="hiddenCount > 0" class="text-caption text-grey">
        {{
          $t(
            hiddenCount === 1
              ? 'digitalGoods.hiddenOne'
              : 'digitalGoods.hiddenMany',
            { count: hiddenCount },
          )
        }}
      </div>
    </template>
    <div v-else-if="item.action === 'request'" class="text-caption">
      {{ $t('digitalGoods.requested', { itemId: item.itemId }) }}
    </div>
    <div
      v-else-if="item.action === 'fulfill'"
      class="text-caption text-weight-bold"
    >
      {{ $t('digitalGoods.fulfilled', { itemId: item.itemId }) }}
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
import { shortAddress } from '../../../utils/short-address'
import { errorNotify } from '../../../utils/notifications'

// A purchase normally settles within a few seconds; this only frees the guard if nobody answers.
const BUY_SETTLE_TIMEOUT_MS = 120_000

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
    /** The vendor's display name, shown beside the address in the purchase confirmation. */
    recipientName: {
      type: String,
      default: '',
    },
  },
  emits: ['sendFollowUp'],
  data() {
    return {
      buyingItemId: null as string | null,
      confirmingItemId: null as string | null,
    }
  },
  computed: {
    shortRecipient(): string {
      return shortAddress(this.address)
    },
    recipientLabel(): string {
      return this.recipientName || this.shortRecipient
    },
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
    hasValidPrice(entry: { priceWei: string }): boolean {
      return /^\d{1,40}$/.test(String(entry.priceWei))
    },
    // The control that had focus is removed when the confirmation opens/closes, so move focus to
    // the new place explicitly instead of dropping it to the page.
    focusFor(testid: string, itemId: string) {
      void this.$nextTick(() => {
        const nodes = (this.$el as HTMLElement).querySelectorAll<HTMLElement>(
          `[data-testid="${testid}"]`,
        )
        for (const node of Array.from(nodes)) {
          if (node.dataset.itemId === itemId) {
            node.focus()
            return
          }
        }
      })
    },
    openConfirm(itemId: string) {
      this.confirmingItemId = itemId
      this.focusFor('goods-confirm', itemId)
    },
    cancelConfirm(itemId: string) {
      this.confirmingItemId = null
      this.focusFor('goods-buy', itemId)
    },
    async confirmAndBuy(entry: { itemId: string; priceWei: string }) {
      // One confirmation buys one purchase: close it before anything is sent.
      this.confirmingItemId = null
      this.focusFor('goods-buy', entry.itemId)
      await this.onBuy(entry)
    },
    // The price comes from an untrusted peer: never throw while rendering.
    displayPrice(priceWei: string): string {
      try {
        if (!/^\d{1,40}$/.test(String(priceWei)))
          return this.$t('digitalGoods.priceUnavailable')
        return `${activeChain.toDisplayAmount(BigInt(priceWei))} ${
          activeChain.unit
        }`
      } catch {
        return this.$t('digitalGoods.priceUnavailable')
      }
    },
    async onBuy(entry: { itemId: string; priceWei: string }) {
      if (this.buyingItemId) return
      this.buyingItemId = entry.itemId
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Held until the chat reports the purchase message was sent (or not), so a second
        // purchase cannot start while the first is still being paid for. The timeout only
        // protects against a parent that never reports back.
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(resolve, BUY_SETTLE_TIMEOUT_MS)
          try {
            this.$emit('sendFollowUp', {
              items: [
                {
                  type: 'digital-goods',
                  action: 'request',
                  itemId: entry.itemId,
                },
              ],
              stampValueWei: BigInt(entry.priceWei),
              settled: () => resolve(),
            })
          } catch (err) {
            reject(err)
          }
        })
      } catch (err) {
        errorNotify(err instanceof Error ? err : new Error(String(err)))
      } finally {
        clearTimeout(timer)
        this.buyingItemId = null
      }
    },
  },
})
</script>
