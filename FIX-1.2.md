# MCHOSE Codex LED v1.2 repair

This build fixes the two faults that caused the reported behavior:

1. `idle` and `waiting` are explicit pink static lighting instead of `preserve`, so normal idle no longer restores a previously-off keyboard state.
2. Official Codex hook lifecycle events are no longer discarded merely because the experimental SQLite watcher reports healthy. Hooks and watcher now cooperate through the task state machine.

The installer also migrates an existing installed config only when `idle`/`waiting` are still legacy `preserve`. Existing user-chosen static/breathing colors are retained.

After installation, `mchose-led.ps1 diagnose` reports controller, lighting, hooks, watcher and last event state.
