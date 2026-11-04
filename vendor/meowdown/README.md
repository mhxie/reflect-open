# Vendored Meowdown packages

Built from Meowdown fork commit `0c66a7cfdf3f36bf5373c6d37d4c0db3fe3f7260`. Source file SHA-256: `6564c6fd5443654234c620b84e944c5fce2b4943bf837aeb4224d8a75da429f4`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.78.0-0c66a7cfdf3f.tgz | `9d405eba841a4e88ab46797d5a1df2b36d75c1f78c65b412e500a710cbf26c65` |
| meowdown-core-0.83.0-0c66a7cfdf3f.tgz | `e499bfce883a1f9ddd0a4c715e10796d4660e8942272765a534f7997038f3373` |
| meowdown-react-0.82.3-0c66a7cfdf3f.tgz | `b2ce981dac7a1849b3d1f930a628f2ffd779f48576fc5d077e68fabe1b2bc499` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
