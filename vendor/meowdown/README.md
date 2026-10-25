# Vendored Meowdown packages

Built from Meowdown fork commit `a0b7cb52de45e28d7be93f33a613f3a47f85a273`. Source file SHA-256: `212b95dd72080e610d1b7b8c046ef1c9cada40255d1c95ea0d7e53b6a4e39e0f`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.77.0-a0b7cb52de45.tgz | `5fd13ecb8ade39b122ef971edb3f7ed23982db7c15b43bea07f808fd7443c838` |
| meowdown-core-0.81.2-a0b7cb52de45.tgz | `f80c170053f6dcd6c2b5f4f49aac04ba8dedda3d28cff90ebb61af4946f2693b` |
| meowdown-react-0.81.1-a0b7cb52de45.tgz | `cf50a6630b69fb1ff9d07c30261ba29777be420361a3f2f1a116e2e861933b8a` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
