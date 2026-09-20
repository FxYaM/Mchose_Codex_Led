# Public release preparation

Date: 2026-09-20

## Scope

- Preserved the remote `main` initialization commit (`d114a57`) and its project description.
- Added publication ignore rules and a portable hooks example.
- Updated README setup, lighting defaults, recovery behavior, stop instructions, and test limitations to match the existing implementation.
- Replaced personal absolute paths and a local session identifier in historical documentation with placeholders.
- Added `vendor/package.json` to install `node-hid` 3.1.2 at the path already used by the controller.
- Existing `.cjs` and `.ps1` files, including all tests, remained byte-for-byte unchanged (SHA-256 comparison).

## Validation

Environment: Windows, Node.js v24.19.0 from the locally available Codex runtime.

| Check | Result |
|---|---|
| Existing `package.json` test command: `node --test tests/*.test.cjs` | 38/38 passed in the original project, with its local snapshots present |
| Existing `check` script's four `node --check` commands | Passed |
| PowerShell AST parsing of all three scripts | Passed, zero parse errors |
| Public-file export: full test command | 22 tests passed; two test files failed to load with `ENOENT` because their local snapshot fixtures are excluded |
| Public-file export: state machine, operation lock, SQLite watcher, Codex wrapper tests | 22/22 passed |

The two affected files are `tests/protocol.test.cjs` and `tests/snapshots-hooks.test.cjs`. They require `snapshots/legacy-baseline-k99v2-258a-010c-20260913T142853+0800`. Their 16 tests ran successfully in the original project but cannot run from the public export without the private fixture. Tests were not altered or skipped to hide this dependency. Codex executable auto-discovery also requires an installed Codex executable.

The available runtime had no npm command, so the existing npm scripts were executed through their exact Node commands. A fresh dependency installation and full installer execution were not performed in this publication check. Physical HID writes, unplug/replug, Windows reboot, and live Codex task integration were not re-tested; historical observations in `TEST-REPORT.md` are not new release verification.

## Excluded local files

- `snapshots/`: the original keyboard recovery manifest and two binary packets, including the machine-specific HID endpoint.
- `hooks-snippet.json`: generated commands containing local absolute paths; a separate placeholder template is published.
- `vendor/node_modules/`: installed `node-hid` and `pkg-prebuilds` packages; install dependencies from the published manifest instead.

All these files were retained locally. Ignore rules also cover environment files, private keys and common credential files, logs, PID/lock files, backups, temporary files, caches, SQLite runtime databases, recovery/state directories, and Windows/PowerShell local artifacts. No credential values were found in the files selected for publication.

## Remaining limitations

- Public tests need portable, non-device-specific fixtures in a future development change to run the complete suite on a clean clone.
- No standalone uninstall command exists; README documents stopping and manual removal of startup/hooks registration.
- `package.json` retains `private: true` and `license: UNLICENSED`; this publication does not assign a new open-source license or publish an npm package.
