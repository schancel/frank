# Frank Documentation Site (`@frank/docs`)

This workspace contains the static documentation site for Frank and Cashweb, powered by [VitePress](https://vitepress.dev/) with Mermaid diagramming and KaTeX mathematical rendering.

## Getting Started

```bash
# Install dependencies from monorepo root
yarn install

# Run local development server with hot module reloading
yarn docs:dev
# or
yarn --cwd packages/docs dev

# Build production static site to .vitepress/dist
yarn docs:build

# Preview production build locally
yarn docs:preview
```

## Structure

- `.vitepress/config.ts`: Main navigation, sidebar structure, search config, and Markdown plugins.
- `.vitepress/theme/`: Custom theme extensions, KaTeX CSS inclusion, and custom styles.
- `index.md`: Portal homepage.
- `protocol/`: Protocol architecture and visualizer pages.
- `cbor/`: Deterministic CBOR v1 documentation and CDDL schemas.
- `architecture/`: Backend and clustering specifications.
- `sdks/`: TypeScript and Rust SDK documentation.
