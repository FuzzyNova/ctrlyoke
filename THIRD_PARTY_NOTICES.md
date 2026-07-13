# Third-Party Notices

This product includes third-party software and assets. This file records the runtime dependencies shipped with ctrlyoke as audited on July 5, 2026 from the installed production dependency tree (`package-lock.json` plus `node_modules`).

## Commercial Distribution

Commercial distribution is permitted for the licenses identified here, subject to each license's conditions.

- Most shipped runtime dependencies are under permissive licenses such as `MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `0BSD`, `BlueOak-1.0.0`, `Python-2.0`, and `Unlicense`.
- `@vscode/codicons` is licensed under `CC-BY-4.0` and requires attribution.
- `@resvg/resvg-wasm` is licensed under `MPL-2.0`, which is a file-level copyleft license.
- `@pushforge/builder` is licensed under `MIT`.
- `dompurify`, included transitively through `streamdown` -> `mermaid`, is dual-licensed under `(MPL-2.0 OR Apache-2.0)`. ctrlyoke relies on the `Apache-2.0` option for distribution analysis.
- As of the current release packaging, `@resvg/resvg-wasm` is shipped as an isolated runtime package under `out/runtime-deps/` instead of being merged into the proprietary `out/*.js` bundles.

## Attribution

ctrlyoke includes icon assets from `@vscode/codicons` by Microsoft Corporation.

- Package: `@vscode/codicons`
- Version: `0.0.45`
- License: `CC-BY-4.0`
- Source: <https://github.com/microsoft/vscode-codicons>
- License URL: <https://creativecommons.org/licenses/by/4.0/>

The codicons font and related assets are used under the Creative Commons Attribution 4.0 International license.

## Production Dependency Summary

The installed production dependency tree contained 470 non-dev packages with the following declared license families:

| License                 | Count |
| ----------------------- | ----: |
| MIT                     |   389 |
| ISC                     |    48 |
| BSD-3-Clause            |    13 |
| Apache-2.0              |     5 |
| BlueOak-1.0.0           |     5 |
| 0BSD                    |     2 |
| BSD-2-Clause            |     2 |
| (MPL-2.0 OR Apache-2.0) |     1 |
| CC-BY-4.0               |     1 |
| MISSING_LICENSE_FIELD   |     1 |
| MPL-2.0                 |     1 |
| Python-2.0              |     1 |
| Unlicense               |     1 |

`khroma@2.1.0` does not declare a `license` field in its `package.json`, but it ships an MIT license file in the package contents and is treated as MIT-licensed for audit purposes.

## Direct Runtime Dependencies

These are the direct `dependencies` declared in the root `package.json`, with the installed versions present in the audited lockfile:

| Package                       | Version         | License         |
| ----------------------------- | --------------- | --------------- |
| `@codemirror/autocomplete`    | `6.20.2`        | `MIT`           |
| `@codemirror/commands`        | `6.10.3`        | `MIT`           |
| `@codemirror/lang-cpp`        | `6.0.3`         | `MIT`           |
| `@codemirror/lang-css`        | `6.3.1`         | `MIT`           |
| `@codemirror/lang-html`       | `6.4.11`        | `MIT`           |
| `@codemirror/lang-java`       | `6.0.2`         | `MIT`           |
| `@codemirror/lang-javascript` | `6.2.5`         | `MIT`           |
| `@codemirror/lang-json`       | `6.0.2`         | `MIT`           |
| `@codemirror/lang-markdown`   | `6.5.0`         | `MIT`           |
| `@codemirror/lang-php`        | `6.0.2`         | `MIT`           |
| `@codemirror/lang-python`     | `6.2.1`         | `MIT`           |
| `@codemirror/lang-rust`       | `6.0.2`         | `MIT`           |
| `@codemirror/lang-yaml`       | `6.1.3`         | `MIT`           |
| `@codemirror/language`        | `6.12.3`        | `MIT`           |
| `@codemirror/lint`            | `6.9.6`         | `MIT`           |
| `@codemirror/search`          | `6.7.0`         | `MIT`           |
| `@codemirror/state`           | `6.6.0`         | `MIT`           |
| `@codemirror/view`            | `6.43.0`        | `MIT`           |
| `@dnd-kit/core`               | `6.3.1`         | `MIT`           |
| `@dnd-kit/sortable`           | `10.0.0`        | `MIT`           |
| `@modelcontextprotocol/sdk`   | `1.29.0`        | `MIT`           |
| `@pushforge/builder`          | `2.0.5`         | `MIT`           |
| `@resvg/resvg-wasm`           | `2.6.2`         | `MPL-2.0`       |
| `@tanstack/react-virtual`     | `3.13.25`       | `MIT`           |
| `@types/express`              | `5.0.6`         | `MIT`           |
| `@types/js-yaml`              | `4.0.9`         | `MIT`           |
| `@types/ws`                   | `8.18.1`        | `MIT`           |
| `@vscode/codicons`            | `0.0.45`        | `CC-BY-4.0`     |
| `@xterm/addon-fit`            | `0.11.0`        | `MIT`           |
| `@xterm/addon-webgl`          | `0.19.0`        | `MIT`           |
| `@xterm/xterm`                | `6.0.0`         | `MIT`           |
| `ajv`                         | `8.20.0`        | `MIT`           |
| `chalk`                       | `5.6.2`         | `MIT`           |
| `chokidar`                    | `5.0.0`         | `MIT`           |
| `codemirror`                  | `6.0.2`         | `MIT`           |
| `commander`                   | `14.0.3`        | `MIT`           |
| `diff`                        | `9.0.0`         | `BSD-3-Clause`  |
| `express`                     | `5.2.1`         | `MIT`           |
| `glob`                        | `13.0.6`        | `BlueOak-1.0.0` |
| `gpt-tokenizer`               | `3.4.0`         | `MIT`           |
| `js-yaml`                     | `5.0.0`         | `MIT`           |
| `jsonc-parser`                | `3.3.1`         | `MIT`           |
| `node-pty`                    | `1.2.0-beta.13` | `MIT`           |
| `qrcode`                      | `1.5.4`         | `MIT`           |
| `react`                       | `19.2.6`        | `MIT`           |
| `react-diff-view`             | `3.3.3`         | `MIT`           |
| `react-dom`                   | `19.2.6`        | `MIT`           |
| `react-resizable-panels`      | `4.11.1`        | `MIT`           |
| `refractor`                   | `5.0.0`         | `MIT`           |
| `selfsigned`                  | `5.5.0`         | `MIT`           |
| `streamdown`                  | `2.5.0`         | `Apache-2.0`    |
| `tree-kill`                   | `1.2.2`         | `MIT`           |
| `typo-js`                     | `1.3.2`         | `BSD-3-Clause`  |
| `ws`                          | `8.21.0`        | `MIT`           |
| `zundo`                       | `2.3.0`         | `MIT`           |
| `zustand`                     | `5.0.13`        | `MIT`           |

## Additional Transitive Packages With Special Attention

These packages are not direct dependencies in the root `package.json`, but they appear in the production tree and are worth calling out because of attribution or copyleft implications:

| Package     | Version  | License                   | Notes                                                                                                                                |
| ----------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dompurify` | `3.4.11` | `(MPL-2.0 OR Apache-2.0)` | Included transitively via `streamdown` -> `mermaid`; Apache option is available.                                                     |
| `khroma`    | `2.1.0`  | `MIT`                     | Included transitively via `streamdown` -> `mermaid`; package metadata omits `license`, but the package contains an MIT license file. |

## Source And License References

- Mozilla Public License 2.0: <https://www.mozilla.org/en-US/MPL/2.0/>
- MPL 2.0 FAQ: <https://www.mozilla.org/en-US/MPL/2.0/FAQ/>
- Creative Commons Attribution 4.0: <https://creativecommons.org/licenses/by/4.0/>
- Apache License 2.0: <https://www.apache.org/licenses/LICENSE-2.0>
- Blue Oak Model License 1.0.0: <https://blueoakcouncil.org/license/1.0.0>

## Notes

- This file is a dependency audit and notice record, not legal advice.
- If release packaging changes the shipped production dependency tree, this file should be regenerated before release.
