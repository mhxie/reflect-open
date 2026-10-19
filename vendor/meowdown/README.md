# Vendored Meowdown packages

Built from Meowdown fork commit `cdde84f3734ada7126cac9892b495676e8328456`. Source file SHA-256: `34791af2a0fee1338340bc7509367bc6c10428b37ecc81d5046e857debf8aa81`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.77.0-cdde84f3734a.tgz | `4e003da630a2be51be0864f372cb0b989894f604351862dceeba42da45ccccb1` |
| meowdown-core-0.81.1-cdde84f3734a.tgz | `cec46b2d1a9c89d3002dc87c227678e2b6660ae1d0473f119ff1af8e81f86c85` |
| meowdown-react-0.80.3-cdde84f3734a.tgz | `7e05fe6a37522f563ae3b00cd3cd88ebd30c99c4140d4e13337406c03e9168e9` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
