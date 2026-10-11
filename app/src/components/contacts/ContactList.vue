<template>
  <q-list separator padding>
    <contact-item
      v-for="(contact, address) in contacts"
      :key="address"
      @mouseover-contact="navigateUsingMouse"
      @mouseleave-contact="hoveredAddress = null"
      :address="address"
      :contact="contact"
      :contact-click="contactClick"
      :class="{
        active:
          address === hoveredAddress ||
          (!hoveredAddress && keyboardFocus && address === activeAddress),
      }"
    />
  </q-list>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import ContactItem from './ContactItem.vue'

export default defineComponent({
  components: {
    ContactItem,
  },
  props: {
    contacts: {
      type: Object,
      default: () => ({}),
    },
    contactClick: {
      type: Function,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      default: () => () => {},
    },
  },
  data() {
    return {
      activeAddress: Object.keys(this.contacts)[0],
      hoveredAddress: null as string | null,
      keyboardFocus: false,
    }
  },
  created() {
    document.addEventListener('keydown', this.navigateUsingArrowKeys)
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.navigateUsingArrowKeys)
  },
  methods: {
    navigateUsingArrowKeys(e: KeyboardEvent) {
      const addresses = Object.keys(this.contacts)
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        this.keyboardFocus = true
        this.hoveredAddress = null
      }
      if (e.key === 'ArrowUp') {
        this.activeAddress = addresses[this.nextAddressIndex({ direction: -1 })]
      }
      if (e.key === 'ArrowDown') {
        this.activeAddress = addresses[this.nextAddressIndex({ direction: 1 })]
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        this.contactClick(this.activeAddress, this.contacts[this.activeAddress])
      }
    },
    nextAddressIndex({ direction }: { direction: number }) {
      const addresses = Object.keys(this.contacts)
      // Add addresses.length so that not found (-1) is the last item
      return (
        (addresses.indexOf(this.activeAddress) + direction + addresses.length) %
        addresses.length
      )
    },
    navigateUsingMouse(addressToBecomeFocused: string) {
      this.hoveredAddress = addressToBecomeFocused
      this.keyboardFocus = false
    },
  },
  watch: {
    contacts() {
      this.activeAddress = Object.keys(this.contacts)[0]
    },
  },
})
</script>
