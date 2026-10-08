# Vendored Meowdown packages

Built from Meowdown fork commit `b7ce2effbc89c15900489e5dba71302f3f57a06b`. Source file SHA-256: `2eed7dbe94f9bf2647e088397a0160294747fc6c84b852305f888c9d6b3b7ccf`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.76.0-b7ce2effbc89.tgz | `4d4872a9598ecf0502e096e3b4c1ea16c2c63264cd006b5d7ee5e034c58d2be6` |
| meowdown-core-0.78.4-b7ce2effbc89.tgz | `02cfebfbb67f11ae7c8bc7cc9abd79194b6e02b123d89b3fef0c6b9fd281e81b` |
| meowdown-react-0.76.4-b7ce2effbc89.tgz | `d18221c61352f2fb5993091fd60bc64d3119d6a403dcda69b36f9fbf92ca536d` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
