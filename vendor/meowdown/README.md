# Vendored Meowdown packages

These packages are built from Meowdown fork commit `ba6b0b2fee19d7e832fe58140a9ba52992f77e73`. The filenames record its first 12 characters, and the lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-core-0.78.4-ba6b0b2fee19.tgz | `a5754def545c49b1b64dc5d31e4b2e1c92a7f37eb458029423a6fa01381ee74b` |
| meowdown-react-0.76.4-ba6b0b2fee19.tgz | `b21a78a309fc2836de292150108ad4e946539cacf42aebd9e7fc19f9a7c9b480` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown` from the repository root with a clean, committed renderer checkout, then run `pnpm install`. The script regenerates these archives and this provenance file.
