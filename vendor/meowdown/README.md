# Vendored Meowdown packages

Built from Meowdown fork commit `0f7b074f39d35f7f569d4aad86611d00f7387476`. Source file SHA-256: `83c327e23a6ea12a00daf5e1bd964a5c5c4e697f9ca86304bbdc45f39326511d`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.76.0-0f7b074f39d3.tgz | `4d4872a9598ecf0502e096e3b4c1ea16c2c63264cd006b5d7ee5e034c58d2be6` |
| meowdown-core-0.78.4-0f7b074f39d3.tgz | `02cfebfbb67f11ae7c8bc7cc9abd79194b6e02b123d89b3fef0c6b9fd281e81b` |
| meowdown-react-0.77.0-0f7b074f39d3.tgz | `b18de82e02c783f5757f287154ccad291bafc0b846272d53017d4a5e561f6752` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
