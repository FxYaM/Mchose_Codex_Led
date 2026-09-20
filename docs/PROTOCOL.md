# K99 V2 protocol notes

Scope: wired Windows x64, BY Tech / MCHOSE K99 V2, VID/PID `258A:010C`, release `0x0200`, usage page `FF00`, usage 1, interface 1, collection Col06. This is a device-specific implementation, not a universal MCHOSE protocol.

Offsets below are zero-based and include the Node-HID report ID.

| Field | Value |
|---|---|
| Report ID / write report length | `0x06` / 520 bytes |
| Performance read / write command | `0x84` / `0x04` |
| Light-color read / write command | `0x8A` / `0x0A` |
| Performance response length | 136 bytes |
| Light-color response length | 520 bytes |
| lightType / lightMode | offsets 17 / 18 |
| Static RGB | offsets 29–31 |
| Breathing RGB | offsets 50–52 |
| Static brightness / packed settings | offsets 66 / 67 |
| Breathing brightness / packed settings | offsets 68 / 69 |
| Performance marker | offsets 134–135: `5A A5` |
| Light-color marker | offsets 514–515: `5A A5` |

The light-color command is decimal ten (`0x0A`), not `0x10`. Breathing uses lightType 0 and lightMode 2. The high nibble of offset 69 holds speed and the low nibble holds multiColor; a single-color preset sets multiColor to zero. Configured speed 1–4 maps to protocol 0–3. Brightness 1–100 percent maps to hardware levels 1–4.

Reads validate length, header and marker, and require two consecutive identical responses within four attempts. Writes preserve unrelated payload bytes. Preset application verifies the selected fields; restoration verifies the complete performance and color responses byte for byte.

The controller commits a snapshot and a pending pointer before modifying lighting. Recovery completes before a new takeover. Stable identity must match and device selection must be unique. K99 V2 provides no serial number, so matching identity cannot distinguish two otherwise identical physical keyboards swapped at different times.

Tests use synthetic protocol packets with documented headers, markers and fields. They check software invariants and do not establish compatibility with untested hardware. Manual and unverified snapshots remain available until explicitly removed by their owner.
