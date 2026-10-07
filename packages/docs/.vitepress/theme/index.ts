import DefaultTheme from "vitepress/theme";
import Layout from "./Layout.vue";
import "katex/dist/katex.min.css";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
};
