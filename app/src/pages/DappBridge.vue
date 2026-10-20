<template>
  <div class="dapp-bridge-page-container column full-height overflow-hidden">
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          flat
          dense
          class="q-px-sm"
          icon="menu"
          :aria-label="$t('settings.openMenu')"
          data-test="dapp-bridge-menu"
          @click="$emit('toggleMyDrawerOpen')"
        />
        <q-icon :name="plugIcon" size="18px" class="q-ml-xs q-mr-xs" />
        <q-toolbar-title class="h6">{{
          $t('leftDrawer.dappBridge')
        }}</q-toolbar-title>
        <q-space />
        <extension-popout-btn />
      </q-toolbar>
    </q-header>

    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="dapp-bridge-page q-ma-none col full-height overflow-y-auto"
        :style-fn="pageStyle"
        data-test="dapp-bridge-page"
      >
        <div class="dapp-bridge-page-inner">
          <dapp-bridge-panel />
        </div>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import DappBridgePanel from 'src/components/panels/DappBridgePanel.vue'
import ExtensionPopoutBtn from 'src/components/navigation/ExtensionPopoutBtn.vue'
import { viewportPageStyle } from 'src/utils/layout'
import { FA_PLUG_CIRCLE_PLUS_ICON } from 'src/utils/extension-download'

export default defineComponent({
  name: 'DappBridgePage',
  components: {
    DappBridgePanel,
    ExtensionPopoutBtn,
  },
  emits: [
    'toggleMyDrawerOpen',
    'toggleContactDrawerOpen',
    'setupNavigationLocked',
    'setupCompleted',
  ],
  setup() {
    return {
      pageStyle: viewportPageStyle,
      plugIcon: FA_PLUG_CIRCLE_PLUS_ICON,
    }
  },
})
</script>

<style scoped>
.dapp-bridge-page-container {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0;
}

.dapp-bridge-page {
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0 !important;
  overscroll-behavior-y: contain;
  padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px));
}

.dapp-bridge-page-inner {
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
}
</style>
