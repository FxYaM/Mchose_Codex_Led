# v1.5 reboot / PID reuse fix

Fixes a Windows reboot failure where `hid-operation.lock.json` survives shutdown and its old PID is later reused by an unrelated process. Earlier versions only checked whether the PID existed, so a recycled PID could make the new daemon believe another MCHOSE LED process still owned the HID lock.

## Fix

- Detect whether the lock timestamp predates the current system boot using `os.uptime()`.
- Treat any lock from a previous boot as stale even if its PID currently exists.
- Keep the existing live-PID and incomplete-lock safeguards for same-boot contention.
- Includes the v1.3 autostart and v1.4 reboot/HID identity fixes.
