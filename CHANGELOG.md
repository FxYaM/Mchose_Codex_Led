# Changelog

## 1.6.1 — 2026-09-20

- Resolve Windows startup and hook script paths before uninstall ownership checks, including short (8.3) path aliases and casing, while rejecting unrelated commands that merely mention a script.
- Add regression coverage for equivalent and unrelated paths, including short-path installation followed by long-path uninstallation; update pinned CI actions to their Node.js 24 versions.

## 1.6.0 — 2026-09-20

- Refuse device tests while an earlier recovery is pending, preserving the original restoration source.
- Keep late terminal corrections within their original task batch; correlate tool completions with outstanding waits and allow repeated identical approval requests.
- Preserve unrelated hooks in mixed groups during installation and removal.
- Keep Codex's exit code and output independent of LED daemon or IPC failures.
- Replace private snapshot fixtures and installed-Codex assumptions with portable synthetic fixtures and subprocess tests.
- Add Windows CI, a dependency lockfile, complete syntax checks, Node.js 24+ runtime selection and dependency preflight.
- Add safe uninstallation that completes restoration before removing program files, preserves recovery data and backs up configuration.
- Rotate controller logs and retain the latest 20 verified automatic recovery snapshots; preserve pending, manual, legacy and unverified snapshots.
- Remove the ineffective `--accept-device` option and consolidate historical session reports into current usage, protocol and validation documentation.

## Earlier versions

- **1.5.0:** reclaim HID locks left by a previous Windows boot even if the PID has been reused.
- **1.4.0:** tolerate endpoint re-enumeration when stable device identity uniquely matches.
- **1.3.0:** add per-user Windows logon startup that respects a persistent manual stop.
- **1.2.0:** use explicit idle/waiting lighting and combine hooks with the local SQLite watcher.
