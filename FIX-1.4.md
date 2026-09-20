# MCHOSE Codex LED v1.4 reboot/re-enumeration repair

This build fixes a reboot-specific device identity deadlock.

The K99 V2 exposes no serial number, and Windows can change the HID endpoint path after reboot, reconnect, or USB re-enumeration. Previous builds treated that endpoint path as stable identity during pending snapshot restore. After a reboot, the daemon could therefore reject the same keyboard, keep the restore pending, and never reach the requested idle/pink state.

v1.4 now treats `endpointPath` as transport metadata when all stable identity fields match. Safety is retained because device selection still requires a unique match on VID/PID, product, manufacturer, release, usage page, usage, interface and collection. Ambiguous duplicate devices are still rejected.

This build also includes the v1.3 Windows logon autostart registration.
