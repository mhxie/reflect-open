# Vendored Meowdown packages

These packages are built from Meowdown fork commit `a47bd410ea702798137c226e87ee156ed527735d`. The filenames record its first 12 characters, and the lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-core-0.78.4-a47bd410ea70.tgz | `8de551dceb80686b30db5f9d7c87a166c7fb1c55da4e72afcca01feea46edbe8` |
| meowdown-react-0.76.4-a47bd410ea70.tgz | `13a1ee62cd80ae49b2699fdd4ca29bd6b10f650f5acb7275e646a4f08ebcc300` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown` from the repository root with a clean, committed renderer checkout, then run `pnpm install`. The script regenerates these archives and this provenance file.
