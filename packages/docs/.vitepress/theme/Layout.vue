<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import MermaidZoomModal from "./MermaidZoomModal.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #layout-bottom>
      <MermaidZoomModal />
    </template>
  </Layout>
</template>
