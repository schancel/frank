import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import markdownItKatex from "markdown-it-katex";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default withMermaid(
  defineConfig({
    title: "Frank & Cashweb",
    description:
      "Protocol Specifications, High-Assurance Architecture, and Developer Documentation",
    base: "/docs/",
    outDir: path.resolve(__dirname, "../../../app/public/docs"),
    cleanUrls: true,
    lastUpdated: true,

    head: [
      ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/frank-logo.svg" }],
      [
        "link",
        {
          rel: "stylesheet",
          href: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
        },
      ],
      ["meta", { name: "theme-color", content: "#0ea5e9" }],
    ],

    markdown: {
      lineNumbers: true,
      config: (md) => {
        md.use(markdownItKatex);
      },
    },

    mermaid: {
      theme: "dark",
      securityLevel: "loose",
    },

    vite: {
      optimizeDeps: {
        include: ["fastdom", "mermaid"],
      },
    },

    themeConfig: {
      logo: "/frank-logo.svg",
      siteTitle: "Frank Docs",

      search: {
        provider: "local",
        options: {
          detailedView: true,
        },
      },

      nav: [
        { text: "Guide", link: "/guide/introduction" },
        { text: "Protocol Specs", link: "/protocol/dns-routing" },
        { text: "CBOR & CDDL", link: "/cbor/spec" },
        { text: "Architecture", link: "/architecture/clustered-relay" },
        { text: "Client SDKs", link: "/sdks/frank-codec" },
      ],

      sidebar: [
        {
          text: "Frank & Cashweb Guide",
          collapsed: false,
          items: [
            {
              text: "Introduction & Architecture Overview",
              link: "/guide/introduction",
            },
          ],
        },
        {
          text: "Core Protocol Specifications",
          collapsed: false,
          items: [
            {
              text: "Dual-Protocol DNS Routing (SRV + MX)",
              link: "/protocol/dns-routing",
            },
            {
              text: "Forwarding Envelope (Type 25)",
              link: "/protocol/forwarding-envelope",
            },
            {
              text: "Encrypted Blob Storage & Attachments",
              link: "/protocol/blob-storage",
            },
            {
              text: "Cashweb Protocol Overview",
              link: "/protocol/cashweb-spec",
            },
            {
              text: "DKSAP Stamp Derivation & DLEQ",
              link: "/protocol/stamp-derivation",
            },
            {
              text: "Cross-Chain Atomic Swaps",
              link: "/protocol/atomic-swaps",
            },
            {
              text: "Codex32 Paper Backup & Recovery",
              link: "/protocol/codex32-backup",
            },
            {
              text: "Ambient Privacy & Graph Entropy",
              link: "/protocol/ambient-privacy",
            },
          ],
        },
        {
          text: "Deterministic CBOR v1 (FRNK)",
          collapsed: false,
          items: [
            { text: "Specification Overview", link: "/cbor/spec" },
            {
              text: "Common Schema (common.cddl)",
              link: "/cbor/common-cddl",
            },
            {
              text: "Direct Message Schema (direct-message.cddl)",
              link: "/cbor/dm-cddl",
            },
            {
              text: "Directory Schema (directory.cddl)",
              link: "/cbor/directory-cddl",
            },
            { text: "Test Vectors & Conformance", link: "/cbor/vectors" },
          ],
        },
        {
          text: "Relay & Backend Infrastructure",
          collapsed: false,
          items: [
            {
              text: "Clustered Relay Architecture",
              link: "/architecture/clustered-relay",
            },
            {
              text: "Backend Daemon Topology",
              link: "/architecture/backend-topology",
            },
            {
              text: "Inbound/Outbound Email Gateway",
              link: "/architecture/email-gateway",
            },
            {
              text: "Prometheus Metrics & Health",
              link: "/architecture/metrics",
            },
          ],
        },
        {
          text: "Client & Backend SDKs",
          collapsed: false,
          items: [
            {
              text: "@frank/codec (TS CBOR Reference)",
              link: "/sdks/frank-codec",
            },
            {
              text: "frank-cbor (Rust Zero-Copy Parser)",
              link: "/sdks/rust-cbor",
            },
            { text: "@frank/cashweb (Client SDK)", link: "/sdks/cashweb" },
            {
              text: "@frank/wallet (EVM + UTXO Engine)",
              link: "/sdks/wallet",
            },
            {
              text: "@frank/crypto-box (AEAD & KEM)",
              link: "/sdks/crypto-box",
            },
            {
              text: "bitcore-lib-xpi (Lotus Cryptography)",
              link: "/sdks/bitcore-lib",
            },
          ],
        },
      ],

      socialLinks: [
        { icon: "github", link: "https://github.com/schancel/frank" },
      ],

      footer: {
        message: "Frank & Cashweb High-Assurance Protocol Documentation",
        copyright: "Copyright © 2026 Frank Contributors. Licensed under MIT.",
      },
    },
  })
);
