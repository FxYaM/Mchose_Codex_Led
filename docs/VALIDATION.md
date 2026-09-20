# Validation

Run from a clean checkout with Node.js 24+ and npm:

```powershell
npm.cmd --prefix vendor ci
npm.cmd run check
npm.cmd test
```

The software tests do not require a keyboard, a Codex installation or private snapshots. HID responses and Codex subprocesses are simulated; SQLite tests create temporary databases. Windows installer tests use temporary profiles and mocked registry operations, and never install into the real user profile. GitHub Actions runs these checks on Windows.

Coverage includes protocol fields and exact restoration, exclusive operation locks, pending-recovery preservation, snapshot retention, log rotation, task aggregation and delayed terminal corrections, approval correlation, preservation/removal of mixed hooks, SQLite degradation and CLI output/exit-code handling when LED reporting fails.

`npm run check` checks every project CJS file and JSON configuration, plus PowerShell parsing on Windows. Dependency installation uses the committed vendor lockfile.

The 1.6.1 local checks on Windows and Node.js 24.19.0 passed **86/86 tests**, checks for 25 CJS files and six PowerShell scripts, and a fresh dependency installation with native-module loading. The Windows regression suite includes real 8.3 path aliases for uninstall ownership checks. Hardware behavior was not revalidated for this release: physical unplug/replug, reboot startup, real keyboard readback and live Desktop integration remain separate manual checks. Earlier successful observations do not count as new release verification.

For a hardware check, use only a supported device and first stop the controller. If status shows pending recovery, reconnect the original keyboard and run `restore --watch` before `device-test`. Confirm the expected color visually as well as the command's readback result. Complete recovery before uninstalling or removing runtime data.
