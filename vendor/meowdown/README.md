# Vendored Meowdown packages

Built from Meowdown fork commit `ccc3ad98fef647dd0c5a7a1b62c667b8cb643dca`. Source file SHA-256: `f71db7e27daf9fbbb7027a41295577971c260f47b7f5383474d45b5b2532b0db`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.76.0-ccc3ad98fef6.tgz | `4d4872a9598ecf0502e096e3b4c1ea16c2c63264cd006b5d7ee5e034c58d2be6` |
| meowdown-core-0.78.4-ccc3ad98fef6.tgz | `02cfebfbb67f11ae7c8bc7cc9abd79194b6e02b123d89b3fef0c6b9fd281e81b` |
| meowdown-react-0.76.4-ccc3ad98fef6.tgz | `b2dcb18e611a5c1da073f5f6b5d457226fc1979292a2fe10bc0dba5ee21abd49` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
