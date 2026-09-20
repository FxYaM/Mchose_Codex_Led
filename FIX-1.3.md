# MCHOSE Codex LED v1.3 autostart repair

This build adds the missing Windows logon startup registration.

- Installer creates `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MCHOSECodexLED`.
- The entry launches `mchose-led.ps1 autostart` hidden after the current user signs in.
- `autostart` starts the daemon only when the persistent controller-enabled flag is true.
- A deliberate `mchose-led.ps1 stop` therefore stays disabled across reboot; running `start` enables it again.
- v1.2 explicit pink idle/waiting lighting is retained.

After reinstalling this build, a normal Windows restart + sign-in should restore the idle pink lighting without a manual command.
