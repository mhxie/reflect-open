# Vendored Meowdown packages

Built from Meowdown fork commit `c74e3d70efd2086ea32b6a11092a029bac0ac175`. Source file SHA-256: `7eed093719231b6a433e1e9d12b6e1f1b41004f692db188eb2ff3078400dba05`. The lockfile pins each archive's integrity.

| Package | SHA-256 |
| --- | --- |
| meowdown-markdown-0.77.0-c74e3d70efd2.tgz | `5fd13ecb8ade39b122ef971edb3f7ed23982db7c15b43bea07f808fd7443c838` |
| meowdown-core-0.81.3-c74e3d70efd2.tgz | `7f720c79b42e0849327a590b74bcb625b8e4186f66af9f78b1128987402d93e3` |
| meowdown-react-0.81.2-c74e3d70efd2.tgz | `ec95f7dd80f136c4badd8fe686cff2f9bc6ff0e2b0ab7a5d406f9e58b9fdec3d` |

To refresh, run `node apps/desktop/scripts/vendor-meowdown.mjs /path/to/meowdown`, then `pnpm install`. Snapshot mode records local source content without creating a commit.
