# Frank Plainspoken identity

Plainspoken is Frank's active brand direction. Two people face one another inside a coin-like seal, connecting private human communication with the value carried by payment-backed messages.

## Sources

- `source/plainspoken-original.png`: approved original concept on warm off-white
- `source/plainspoken-transparent.png`: transparent extraction used for splash screens and avatars
- `plainspoken-mark.svg`: simplified monochrome vector for mask icons and compact rendering

## Palette

- Ink: `#121218`
- Paper: `#F7F7F2`

## Exports

- `raster/`: app-ready sizes
- `raster/plainspoken-safari-toolbar-{16,32,64,128}.png`: generated, the transparent mark in Carnelian (`#C8431E`) for the Safari extension toolbar (Safari tints a greyscale icon as a mask). Regenerate from `app/` with `node scripts/generate-safari-toolbar-icons.cjs`; `src-bex/safari-toolbar-icons.jest.test.ts` checks the committed files match.
- `worlds-fair-upload/`: curated files for the project listing

Use the ink-on-paper version for launcher icons and project listings. Use the transparent mark on controlled light surfaces.
