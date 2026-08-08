# Third-Party Notices

Portal's own source code is released under the MIT License in [`LICENSE`](./LICENSE). The components listed here remain under their original licenses; this file does not relicense third-party code.

The versions below are the versions resolved by the current lockfiles. The frontend table lists direct dependencies, while the Rust table also calls out native bridge crates that can affect a packaged application. The complete transitive dependency graph remains pinned in `pnpm-lock.yaml` and `src-tauri/Cargo.lock`. `license-report.csv` is the machine-readable inventory with a scope column. When dependencies change, regenerate both records before publishing a new application bundle.

## Frontend runtime dependencies

| Component | Version | License | Source |
| --- | --- | --- | --- |
| `@tauri-apps/api` | 2.10.1 | Apache-2.0 OR MIT | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) |
| `@tauri-apps/plugin-clipboard-manager` | 2.3.2 | MIT OR Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `@tauri-apps/plugin-dialog` | 2.6.0 | MIT OR Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `@tauri-apps/plugin-global-shortcut` | 2.3.2 | MIT OR Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `@tauri-apps/plugin-notification` | 2.3.3 | MIT OR Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `@tauri-apps/plugin-opener` | 2.5.4 | MIT OR Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `@tauri-apps/plugin-store` | 2.4.4 | MIT OR Apache-2.0 | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `@xterm/addon-fit` | 0.11.0 | MIT | [xterm.js](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) |
| `@xterm/xterm` | 6.0.0 | MIT | [xterm.js](https://github.com/xtermjs/xterm.js) |
| `antd` | 6.3.3 | MIT | [ant-design/ant-design](https://github.com/ant-design/ant-design) |
| `prismjs` | 1.30.0 | MIT | [PrismJS/prism](https://github.com/PrismJS/prism) |
| `pubsub-js` | 1.9.5 | MIT | [mroderick/PubSubJS](https://github.com/mroderick/PubSubJS) |
| `react` | 19.2.4 | MIT | [facebook/react](https://github.com/facebook/react) |
| `react-dom` | 19.2.4 | MIT | [facebook/react](https://github.com/facebook/react) |
| `react-hot-toast` | 2.6.0 | MIT | [timolins/react-hot-toast](https://github.com/timolins/react-hot-toast) |
| `valtio` | 2.3.1 | MIT | [pmndrs/valtio](https://github.com/pmndrs/valtio) |

## Rust dependencies and native bridges

| Component | Version | License | Source |
| --- | --- | --- | --- |
| `tauri` | 2.10.3 | Apache-2.0 OR MIT | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) |
| `tauri-plugin-clipboard-manager` | 2.3.2 | Apache-2.0 OR MIT | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `tauri-plugin-dialog` | 2.6.0 | Apache-2.0 OR MIT | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `tauri-plugin-global-shortcut` | 2.3.2 | Apache-2.0 OR MIT | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `tauri-plugin-notification` | 2.3.3 | Apache-2.0 OR MIT | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `tauri-plugin-opener` | 2.5.4 | Apache-2.0 OR MIT | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `tauri-plugin-store` | 2.4.4 | Apache-2.0 OR MIT | [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace) |
| `serde` / `serde_json` | 1.0.228 / 1.0.149 | MIT OR Apache-2.0 | [serde-rs](https://github.com/serde-rs) |
| `dirs` | 5.0.1 | MIT OR Apache-2.0 | [soc/dirs-rs](https://github.com/soc/dirs-rs) |
| `ssh2` / `libssh2-sys` | 0.9.5 / 0.3.1 | MIT OR Apache-2.0 | [alexcrichton/ssh2-rs](https://github.com/alexcrichton/ssh2-rs) |
| `thiserror` | 1.0.69 | MIT OR Apache-2.0 | [dtolnay/thiserror](https://github.com/dtolnay/thiserror) |
| `tauri-build` (build dependency) | 2.5.6 | Apache-2.0 OR MIT | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) |
| `windows-sys` | 0.52.0 | MIT OR Apache-2.0 | [microsoft/windows-rs](https://github.com/microsoft/windows-rs) |
| `libz-sys` | 1.1.25 | MIT OR Apache-2.0 | [rust-lang/libz-sys](https://github.com/rust-lang/libz-sys) |
| `openssl-sys` | 0.9.112 | MIT | [rust-openssl](https://github.com/rust-openssl/rust-openssl) |

## Transitive license exceptions

The current Rust lockfile also contains the following license families outside the project's own MIT license and the direct MIT/Apache-2.0 choices. They remain licenses of the upstream files and are not applied to Portal source code.

| Components | License | Reason / handling |
| --- | --- | --- |
| `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext` | [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0/) | Pulled in by Tauri/Wry, HTML/CSS and directory helpers. Keep the MPL notice; modified MPL files require corresponding source under MPL-2.0. |
| ICU4X crates (`icu_*`, `litemap`, `potential_utf`, `tinystr`, `writeable`, `yoke*`, `zerofrom*`, `zerotrie`, `zerovec*`) | [Unicode-3.0](https://www.unicode.org/license.txt) | Unicode data/code notice must remain available when those crates are shipped. |
| `r-efi` (target-conditional) | MIT OR Apache-2.0 OR LGPL-2.1-or-later | The expression provides MIT/Apache-2.0 alternatives; desktop builds do not select the EFI target. Recheck this row if EFI/WASI targets are added. |

## Copyright notices

`@xterm/xterm` includes the following copyright notices:

```text
Copyright (c) 2017-2019, The xterm.js authors
Copyright (c) 2014-2016, SourceLair Private Company
Copyright (c) 2012-2013, Christopher Jeffrey
```

`@xterm/addon-fit` includes:

```text
Copyright (c) 2019, The xterm.js authors
```

The complete upstream license files remain authoritative; this inventory is not a replacement for every upstream license text. When distributing a bundled application, retain the license and notice files for the exact dependency versions used by that bundle.

## Compatibility notes

- MIT, BSD and ISC dependencies remain compatible with this project's MIT license, provided their copyright and license notices are retained.
- Dependencies offering `Apache-2.0 OR MIT` or `MIT OR Apache-2.0` are not relicensed by Portal. The selected license and any applicable Apache `NOTICE` text must remain available to recipients.
- MPL-2.0 dependencies use file-level copyleft: unmodified copies can remain separate dependencies, while changes to their files must retain the MPL terms. This does not require Portal's unrelated source files to become MPL-2.0.
- Unicode-3.0 is a separate upstream license for ICU data and related code; retain its notice when the corresponding crates are included.
- Development-only tools are listed in `license-report.csv` for source-repository transparency but are not part of the runtime application bundle.
- `ssh2` brings native `libssh2`, zlib and OpenSSL bindings. The default build links to the platform-provided libraries, so their licenses and notices must be checked for the exact target image; they are separate from the Rust binding licenses listed above.
- Linux packages may use system GTK, WebKitGTK and (depending on the Tauri plugin set) libappindicator libraries. macOS and Windows use system WebKit/WebView2 components. Their platform licenses are separate from the Rust and JavaScript package licenses and are not changed by Portal's MIT license.
- For a binary release, ship this notice file and the applicable upstream license/notice files alongside the installer or archive. Do not copy third-party text into `LICENSE`; keeping that file as the unmodified MIT template lets repository hosts identify the project license reliably.
