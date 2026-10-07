# Vendored Meowdown packages

Built from Meowdown fork commit `390494b327959f6c2b299d7d07d98c229ecc222d`. Source file SHA-256: `232d4b96233d45bbbdc3ee7dbd87ca2f2f4b379c5a8cca99e6ce2cd1d6686cd6`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.76.0-390494b32795.tgz | `4d4872a9598ecf0502e096e3b4c1ea16c2c63264cd006b5d7ee5e034c58d2be6` |
| meowdown-core-0.78.4-390494b32795.tgz | `b821d2cea8d7bc3ef9761def94d592811d7140f5a975f82bbe083bd54181081a` |
| meowdown-react-0.76.4-390494b32795.tgz | `713ef15f5802bf8db1217525359bab550b352876636af7a175e910645777aa4f` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
