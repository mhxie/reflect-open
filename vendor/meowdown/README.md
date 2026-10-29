# Vendored Meowdown packages

Built from Meowdown fork commit `c06a2c57aabaa504037b769277779f801eb43503`. Source file SHA-256: `c3050082940d872b24050b3eb1af5a5ac928ddb8741ddd47ac7bc08652932e49`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.78.0-c06a2c57aaba.tgz | `9d405eba841a4e88ab46797d5a1df2b36d75c1f78c65b412e500a710cbf26c65` |
| meowdown-core-0.83.0-c06a2c57aaba.tgz | `5fdb54ea634198990788bba71e25bf4ca555f73241f124d0407f91b5cbee2913` |
| meowdown-react-0.82.2-c06a2c57aaba.tgz | `22ad7277cd000ab20f1f15c30e5f111c1d59869c35960e179573e6b761e753db` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
