# 进度与续接记录

更新时间：2026-09-15（Asia/Shanghai）

## 原任务接续审计

- `inspect-asar.mjs` 和 `decompress-cache.mjs` 已实际成功执行，完成 MCHOSE HUB ASAR 与 Chromium 缓存提取。
- `probe-mchose.cjs` 于 2026-09-13 14:27 实际识别设备：`BY Tech / K99 V2`，VID/PID `258A:010C`，release `0x0200`，interface 1，usagePage `FF00`，usage 1，Col06。
- 旧 `read-mchose-state.cjs` 首次因错误地要求 performance 回应为 520 字节而失败；修正为 136 字节后，于 14:28:53 成功读出两个 bin。
- 旧 `test-mchose-led.cjs` 两次实际运行都失败。第二次读回 mode 2，说明 performance 包已生效，但呼吸 RGB 仍为 `255,0,0`。根因后来确认为旧代码把十进制命令 `10` 误写成 `0x10`。旧代码还会在 primary error 后提前抛出，跳过完整恢复一致性比较。
- 旧会话执行证据：`%USERPROFILE%\.codex\sessions\2026\09\13\rollout-<local-session>.jsonl`，关键 ordinals 480、506、520、542、559。

最初基线在本轮任何 HID 写入前已保全为只读快照：

- `work\snapshots\baseline-k99v2-258a-010c-20260913T142853+0800`
- performance 136 B，SHA-256 `77FC8098DB6A7434D429541C3DD2C7695F6070DF41F7FD9626ADA8B892FB6DA4`
- light-color 520 B，SHA-256 `C45198B329555CA0D7B9178035C4CB38D7EC9C16D9B585931BD03A16D6DB953C`
- 基线 mode 1；静态 RGB `255,241,241`；呼吸 RGB `255,0,0`

`work\read-mchose-state.cjs` 已替换为只创建带时间和设备标识的快照，绝不覆盖 original.bin；最新安全读取生成 `diagnostic-read-20260914T150402Z-ee34803e`，排他锁已释放。两个 original 的哈希和只读属性仍与基线一致。`work\test-mchose-led.cjs` 已替换为新的可逆测试器，独立记录 test error、restore error、restore mismatch 和 close error，无论主测试成败都会继续尝试恢复。

## 协议依据与纠正

本机官方 MCHOSE HUB bundle：

- `work\mchose-cache-decompressed\f_00003e.br`
- 8,720,649 B
- SHA-256 `ECAF24A1FA4E0810C707985783C60201AB1B621CF7E7BD99F8EB3570CCA81837`

已核验参数（0-based，含 Node-HID Report ID）：

| 项目 | 值 |
|---|---|
| 设备 | `258A:010C`，K99 V2，`FF00:1`，interface 1，Col06 |
| Report ID / 写报告总长 | `0x06` / 520 B |
| performance 读 / 写 | `0x84` / `0x04` |
| light-color 读 / 写 | `0x8A` / **`0x0A`** |
| lightType / lightMode | offsets 17 / 18 |
| 静态 RGB | offsets 29..31 |
| 呼吸 RGB | offsets 50..52 |
| 静态 brightness / packed | offsets 66 / 67 |
| 呼吸 brightness2 / packed(speed2,multiColor2) | offsets 68 / 69 |
| performance 尾标 | offsets 134..135 = `5A A5` |
| light-color 尾标 | offsets 514..515 = `5A A5` |

关键纠正：官方命令表的 `wiredCommand:"10"` 是 JS 字符串，随后进入 `Uint8Array` 时 ToNumber 得到十进制 10，即 `0x0A`，不是 `0x10`。可靠单色呼吸还必须设置 `lightType=0`、`lightMode=2`、`brightness2`、`multiColor2=0` 和 `speed2`，再写 RGB。offset 69 高半字节为 speed，低半字节为 multiColor；配置速度 1–4 映射到协议 0–3，百分比亮度映射到官方 1–4 档。

真实读取曾发现低概率 HID 瞬态：500 次零延迟读取中出现 1 次 137 B 的前导 `00` 响应；另有一次 136 B 包在 offsets 8–9 瞬态变化。协议层因此每次命令等待 5 ms，并要求最多 4 次内得到连续两个“长度、头部、尾标和全部字节完全相同”的响应。修复后实机连续 100 次完整状态读取全部得到精确基线哈希。

## 已完成实现

- 自包含的 Windows x64 Node-HID 3.1.2 预编译依赖和许可证。
- 严格设备选择、协议验证、稳定读取、读改写和指定字段读回确认。
- 时间戳+随机 ID 快照；长度、SHA-256、设备身份、endpoint 和协议 manifest。
- takeover 快照及 pending 指针先于第一笔写入；恢复全包逐字节比较，通过后才清 pending。
- 正常退出恢复；强杀或离线时保留 pending；重连/下次启动先恢复旧 takeover 再接管。
- 守护进程和 read/snapshot/restore/device-test 共用跨进程 HID 排他锁；崩溃遗留锁按 PID 安全回收。
- Windows named-pipe 单实例、HID 操作串行化、离线重试和重连重施加；相同灯效不会重复写。
- `restore --watch` 把打开后发生的 HID 读写/关闭失败视为离线并继续等待，但身份不匹配仍立即拒绝。
- 可配置 idle / waiting / running / success / error / restore，及启动、停止、手动切换命令。
- 多任务聚合、事件幂等、running 优先、waiting 不算成功、失败优先、终态 TTL 和陈旧任务兜底。
- PermissionRequest 的幂等键纳入官方 `tool_name` 和 `tool_input`，同一 turn 后续审批不会被误丢弃。
- 显式 stop/restore 清空活动任务，防止停用期间漏掉终态后在下次 start 复活旧 running。
- Desktop lifecycle hook adapter；合并而不覆盖飞书 Stop hook，不修改 `config.toml` notify。
- `codex exec --json` 包装器；等待 stdio close 后识别 completed、failed、error、非零退出、启动失败和 Ctrl-C。
- 安装器升级前先安全恢复、等待旧 PID 完全退出并保留用户配置，再更新与重启。
- 实验性 Desktop 本地状态 watcher：只读查询版本化 `thread_history_*.sqlite` / `state_*.sqlite` 的任务 ID、状态和时间，不读取对话正文或 error_json。
- watcher 实测映射 `inProgress` / `completed` / `failed` / `interrupted`，过滤子代理和陈旧 active，启动不重放历史终态；数据库缺失、锁定或 schema 变化时安全降级并重试。
- 状态机新增持久化终态 tombstone：不同来源的重复终态不会延长提示，迟到的 PostToolUse 不能复活任务，error 可升级 success、success 不能覆盖 error。

## 真实 Desktop 未触发的根因

- `~/.codex/hooks.json` 中 7 个 MCHOSE 组均为 enabled，但 app-server `hooks/list` 返回的 trustStatus 全是 `untrusted`。
- `~/.codex/config.toml` 的 `[hooks.state]` 只有旧飞书 `Stop` 的 trusted_hash，没有 MCHOSE 记录；Codex 按官方规则跳过未信任 hook。
- Desktop app-server 于 2026-09-14 11:16 启动，最终 MCHOSE hooks 于 23:10 写入，旧运行时也没有重载它们。
- 用户在 Desktop 聊天框发送 `/hooks` 被当作普通消息；正确入口是交互式 Codex CLI TUI。
- 同期 controller 日志只有用户已确认有效的手动 `running → success → error → idle`，没有 `codex-hook` 事件，因此故障位于 Codex 事件接入层，不是 HID 层。

## 当前 Codex 与事件边界

- Codex Desktop：`26.908.4834.0`
- Desktop 内置 CLI：`codex-cli 0.154.0-alpha.6.2`
- PATH / VS Code CLI：`0.153.0`
- 控制器的 `codex-info` 自动选择 Desktop 内置 0.154 路径。

官方 lifecycle hooks 可覆盖 UserPromptSubmit、Stop、Interrupt、PermissionRequest 等，但更改后的非托管 hooks 必须由用户在交互式 CLI TUI 的 `/hooks` 中审阅和信任。Stop payload 没有 terminal status，官方也没有 TurnFailed hook，因此 hooks 本身无法可靠区分一般失败与额度耗尽；外部 sidecar 也没有官方方式旁听 Desktop 已占有的 app-server stdio。

当前补充采用 Codex 自身维护的结构化投影数据库：本机 `thread_turns.status` 实时给出 `inProgress`、`completed`、`failed`、`interrupted`，历史额度耗尽也确实为 `failed`。它能覆盖运行、成功、一般失败、额度中断和取消，但属于实测内部接口，不是官方稳定契约。等待审批没有独立持久化状态，仍需已信任的 PermissionRequest / PreToolUse / PostToolUse hooks。经 `mchose-led-exec.ps1` 启动的 CLI 任务继续直接使用官方 `--json` JSONL 精确分类。

未采用内部 rollout/transcript JSONL 作为生产事件接口。官方明确说明 transcript 格式不是稳定 hook 接口；文件还可能包含工具输出中的自引用文本，用它监听会产生重放、重复和版本兼容风险。watcher 查询的是 SQLite 结构化状态列，不扫描 rollout 文本，并在状态中明确标记 `officialInterface:false`。

官方资料：

- Hooks: https://learn.chatgpt.com/docs/hooks
- Non-interactive JSONL: https://learn.chatgpt.com/docs/non-interactive-mode
- App Server: https://learn.chatgpt.com/docs/app-server

## 关键命令

```powershell
$led = "$env:USERPROFILE\.codex\mchose-led\mchose-led.ps1"

& $led status
& $led stop
& $led device-test --duration-ms 5000
& $led restore --watch
& $led start
& $led codex-info

& "$env:USERPROFILE\.codex\mchose-led\mchose-led-exec.ps1" --ephemeral --skip-git-repo-check "回复 OK"

$node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node --test "%USERPROFILE%\Documents\Codex\2026-09-13\new-chat\outputs\mchose-codex-led\tests\*.test.cjs"
```

## 若再次中断

1. 先运行 `status`；若存在 pending，执行 `restore --watch`。
2. 查看 `TEST-REPORT.md` 与 `%LOCALAPPDATA%\MCHOSECodexLED\controller.log.jsonl`。
3. 若要精确识别等待/审批，在 PowerShell 启动交互式 `codex`，在 CLI TUI 中输入 `/hooks`，审阅并信任 7 个 MCHOSE 组，然后完全重启 Desktop/VS Code。
4. 先查看 `status.codexStateWatcher`；若数据库 schema 因 Codex 升级而不兼容，可暂时关闭 watcher 并使用已信任 hooks / CLI wrapper。HID 与恢复层无需重写。
