# Vendored Meowdown packages

Built from Meowdown fork commit `bebf7b499684d925c9bb0d65793429354a08f6aa`. Source file SHA-256: `1a34884721f1be098d5b63c60d81ab21c447bc85ca0f50a16291d76025769f1f`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.78.0-bebf7b499684.tgz | `9d405eba841a4e88ab46797d5a1df2b36d75c1f78c65b412e500a710cbf26c65` |
| meowdown-core-0.83.1-bebf7b499684.tgz | `0aeafeae8a6d465027b319729c327a55f75a0511c2c310e117e1e5a3afda57c3` |
| meowdown-react-0.83.1-bebf7b499684.tgz | `3180efcf64ab303fbef851c6e3ebefa8d511f3592950d5f06a2b59683d793b34` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
