# Third-party notices

The js-code-analysis skill is licensed under the MIT License (see `LICENSE` at the repository root). It redistributes, or fetches at bundle time, the third-party software below. That software stays under its own license.

## Redistributed in this repository

### FTA (Fast TypeScript Analyzer) 3.0.1

- Files: `vendor/fta/*/fta` (prebuilt binaries taken unmodified from the `fta-cli@3.0.1` npm package)
- Copyright (c) 2023-present Sam Brown
- License: MIT. The full text is in `vendor/fta/LICENSE.md`.
- Source: https://github.com/sgb-io/fta

The FTA binaries are compiled Rust programs. They statically include the Rust standard library, about 170 crates from crates.io, and, in the `*-linux-musl` builds, musl libc. The license and copyright texts for all of these are in [`licenses/FTA_THIRD_PARTY_LICENSES.txt`](licenses/FTA_THIRD_PARTY_LICENSES.txt). By license family:

| License | Notable crates |
|---|---|
| MIT and/or Apache-2.0 (dual-licensed) | clap, serde, serde_json, regex, log, env_logger, tempfile, the Rust standard library |
| Apache-2.0 only | the SWC parser crates (`swc_*`, `ast_node`, `better_scoped_tls`, `bytes-str`, `from_variant`, `string_enum`, `hstr`, `is-macro`) |
| MIT only | comfy-table, crossterm, phf, tracing, bytes, strsim, musl libc |
| Unlicense OR MIT | memchr, aho-corasick, walkdir, same-file, globset, ignore |
| Unicode-3.0 | the ICU4X crates (`icu_*`, `zerovec`, `yoke`, `tinystr`, ...); `unicode-ident` (also MIT OR Apache-2.0) |
| MPL-2.0 | `smartstring` 1.0.1 |

**MPL-2.0 notice:** FTA includes the `smartstring` crate, which is licensed under the Mozilla Public License 2.0. Its source code is available at https://crates.io/crates/smartstring/1.0.1 and https://github.com/bodil/smartstring. MPL-2.0 applies only to that crate's files and does not extend to the rest of FTA or to this skill.

None of the bundled crates ship a NOTICE file.

## Fetched at bundle time, not committed

`scripts/bundle.sh` runs `npm install c8@12.0.0` and copies the result into `vendor/c8/node_modules`. That directory is ignored by git, so it is not part of this repository. If you distribute a bundled copy of the skill, c8 and its dependencies go with it under their own licenses (ISC, MIT, BSD-3-Clause, Apache-2.0 and similar). Each package's license file is inside its `node_modules` folder.

## Installed into the analyzed project, not redistributed

When the user approves `--install`, the analyzer runs the project's own package manager, for example to add `@vitest/coverage-v8`. Those packages go into the analyzed project and are never redistributed by this skill.
