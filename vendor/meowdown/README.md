# Vendored Meowdown packages

Built from Meowdown fork commit `3a80c7adcc1d7433bfa80a786bc0f434daa32769`. Source file SHA-256: `2dbca5286e0b7eba137ad3403dea908eb22f22c8fd0ff7fa35ee2e5dcc707fe8`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.77.0-3a80c7adcc1d.tgz | `2c9db47246cccebf2c220ae4c88c6934fbf841b247671fe793e125e2e7bb67d7` |
| meowdown-core-0.82.0-3a80c7adcc1d.tgz | `50b5d6a7311e867a111d3c8086f9f44e673e489af14dfdd5b9ab244367e85159` |
| meowdown-react-0.82.1-3a80c7adcc1d.tgz | `f753a0790d51635c2dab303622b63c2aa7c9c691c45759278f2fc36d8e150517` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
