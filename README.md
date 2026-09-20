# MCHOSE Codex Status LED

Turn your MCHOSE keyboard RGB into a real-time Codex status indicator, with automatic Windows startup, HID reconnect recovery, and customizable lighting states.

这是一个 Windows 键盘 RGB 控制器，将 Codex 任务状态显示在键盘灯光上。目前仅验证 Windows x64 和有线 USB 连接的 `BY Tech / MCHOSE K99 V2`：VID/PID `258A:010C`、release `0x0200`、`FF00:1`、interface 1、Col06。其他型号、无线模式和其他操作系统未验证。

| 灯光 | 含义 |
|---|---|
| Pink static → Idle | 粉色静态 `#FF69B4`：空闲；等待输入/审批也使用粉色 |
| Blue breathing → Codex running / thinking | 蓝色呼吸 `#0060FF`：执行或思考中 |
| Green → Success | 绿色 `#00FF00`：成功，持续 2.5 秒 |
| Red → Failure | 红色 `#FF0000`：失败、中断或取消，持续 5 秒 |

终态提示结束后回到空闲灯效。颜色、亮度和提示时长可在 `config.json` 中修改。

## Windows 安装

准备 Git、带 npm 的 Node.js 24.x，以及已安装的 Codex。SQLite watcher 和完整测试需要支持 `node:sqlite` 的 Node.js；发布检查使用 Node.js 24.19.0。脚本会优先选择 Codex 自带的 Node，再尝试系统安装和 PATH，请确认实际选中的版本支持 SQLite。

在**安装目录以外**的工作目录中克隆并安装，例如：

```powershell
git clone https://github.com/FxYaM/Mchose_Codex_Led.git
Set-Location Mchose_Codex_Led
npm.cmd --prefix vendor install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`vendor/package.json` 将 `node-hid` 固定为 3.1.2，并安装到控制器使用的 `vendor/node_modules`。仓库不包含本机依赖目录。安装前关闭 MCHOSE HUB 对灯光的控制，连接受支持的键盘。安装器会复制程序到 `%USERPROFILE%\.codex\mchose-led`、合并 hooks、启动 daemon 并注册当前用户登录自启动。不要在该安装目录中直接运行安装器，以免复制到自身。

## 位置与首次启用

- 安装目录：`%USERPROFILE%\.codex\mchose-led`
- 配置：`%USERPROFILE%\.codex\mchose-led\config.json`
- 日志、状态、测试结果和恢复快照：`%LOCALAPPDATA%\MCHOSECodexLED`
- Codex hooks：`%USERPROFILE%\.codex\hooks.json`

安装器保留其他已有 hook，也不会修改 `config.toml` 中已有的 `notify`。只读本地状态 watcher 与 hooks 共同提供任务状态；等待输入/审批由已信任的 hooks 补充。安装器会根据当前机器生成 hook 命令，不需要复制包含其他用户路径的 `hooks-snippet.json`。

`hooks-snippet.example.json` 是带路径占位符的参考模板，不能原样执行；正常安装请使用安装器自动生成命令。

如果 hooks 未触发，请按下文在交互式 Codex CLI TUI 中使用 `/hooks` 审阅信任，再重启 Desktop。不要手工写入或伪造 `trusted_hash`。


## Windows 重启后自动启动

v1.3 会在当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 注册 `MCHOSECodexLED`。登录 Windows 后会隐藏执行：

```powershell
$led = "$env:USERPROFILE\.codex\mchose-led\mchose-led.ps1"
& $led autostart
```

`autostart` 不会覆盖显式 `stop`：如果你之前手动停止并持久禁用了控制器，重启后仍保持禁用；再次执行 `start` 才会重新启用。

## 配置灯效

编辑已安装的 `config.json`。主要字段如下：

| 字段 | 含义 |
|---|---|
| `states.idle` | 空闲灯效；默认粉色静态 `#FF69B4`，亮度 75% |
| `states.waiting` | 等待输入/审批；默认与空闲相同的粉色静态灯 |
| `states.running` | 执行中颜色、亮度和呼吸速度 |
| `states.success` / `states.error` | 成功/异常颜色、亮度和持续时间 |
| `color` | `#RRGGBB` |
| `brightnessPercent` | 1–100，映射到键盘官方 1–4 档 |
| `breathingSpeed` | 键盘官方速度档 1–4 |
| `durationMs` | 成功/异常提示持续毫秒数 |
| `codex.stateDatabaseWatcher.enabled` | 是否启用本机 Desktop 状态兜底，默认 `true` |
| `codex.stateDatabaseWatcher.codexHome` | Codex 数据目录，默认 `%USERPROFILE%\.codex` |
| `codex.stateDatabaseWatcher.pollIntervalMs` | 状态轮询间隔，默认 350 ms |
| `codex.stateDatabaseWatcher.initialLookbackMs` | 重启时允许恢复的活动任务最大年龄，默认 6 小时 |
| `codex.stateDatabaseWatcher.includeSubagents` | 是否把内部子代理当作独立灯光任务，默认 `false` |

例如，把平时和等待时都设为粉色静态灯：

```json
"idle": {
  "mode": "static",
  "color": "#FFD0E8",
  "brightnessPercent": 50
},
"waiting": {
  "mode": "static",
  "color": "#FFD0E8",
  "brightnessPercent": 50
}
```

修改后重启控制器：

```powershell
$led = "$env:USERPROFILE\.codex\mchose-led\mchose-led.ps1"
& $led stop
& $led start
```

`stop` 会恢复接管前的完整灯效、清除已跟踪任务并持久禁用自动联动；`start` 才会重新启用。重新运行安装器会保留已安装的 `config.json`。

## 常用与手动测试命令

```powershell
$led = "$env:USERPROFILE\.codex\mchose-led\mchose-led.ps1"

& $led start
& $led status
& $led codex-info

& $led running     # 蓝色呼吸
& $led success     # 绿色，随后自动恢复
& $led error       # 红色，随后自动恢复
& $led waiting     # 默认粉色静态
& $led idle
& $led auto        # 退出手动覆盖，重新按任务状态显示

& $led stop
```

诊断、快照和恢复：

```powershell
& $led stop
& $led read
& $led snapshot --kind before-customization
& $led snapshots
& $led device-test --duration-ms 5000
& $led restore
& $led restore --watch
& $led restore --snapshot "<快照目录或 ID>"
& $led start
```

直接读、拍快照、恢复和 `device-test` 使用跨进程 HID 排他锁，并要求先 `stop`，防止 hooks 或另一个命令在中途接管。`restore` 会保持控制器停用，完成后按需运行 `start`。它默认使用 pending 快照；键盘离线时不会删除恢复依据。重插原 USB 口后执行 `restore --watch`，或执行 `start`，程序会先恢复再接管。

K99 V2 没有序列号。v1.4 起，Windows 重启或 USB 重新枚举造成的 endpoint 路径变化不再单独阻止恢复；稳定身份字段仍须匹配，且必须唯一匹配设备。多把相同设备或身份不匹配会被拒绝。

### HID reconnect / boot recovery

断线时 daemon 保留恢复快照并退避重试；发现键盘重新连接后重新应用目标灯效。异常退出或断电留下的 pending 快照会在下次启动时先恢复并读回验证，再重新接管。v1.5 还会回收上一次系统启动遗留的 HID 锁，避免 Windows 重用旧 PID 后无法启动。登录自启动仍尊重手动 `stop` 的持久禁用状态。

## 状态聚合规则

| 状态 | 显示规则 |
|---|---|
| running | 至少一个任务正在执行；优先级最高 |
| waiting | 没有运行任务，但至少一个任务等待输入/审批；绝不当作成功 |
| success | 同一批并发任务全部结束且都成功后显示 |
| error | 同一批任务存在失败、Interrupt、取消或活动 SessionEnd 后显示；优先于 success |
| idle | 没有活动任务且提示时间已经结束 |

Desktop 任务使用 `thread_id + turn_id`，CLI 包装器使用 UUID。默认只聚合用户可见的根任务，过滤内部子代理；一个任务结束不会覆盖另一个仍在执行的任务。仅仅保持 Codex 程序打开不会触发 running。

## 三层 Codex 联动方式

### Desktop 本地状态 watcher（默认）

守护进程只读扫描当前 `Codex home` 下版本化的 `thread_history_*.sqlite` 与 `state_*.sqlite`：

- `inProgress` → running
- `completed` → success
- `failed`、`interrupted` → error

它只查询任务 ID、状态和时间，不读取 `error_json`、对话正文或 rollout/transcript。启动时只导入最近仍在运行的根任务，不重放历史绿/红提示；会忽略陈旧未完成记录和内部子代理。多任务仍按前述聚合规则处理。数据库缺失、锁定或 schema 不兼容时，watcher 会在 `status` 中显示不健康并继续重试，HID 控制与恢复不会因此崩溃；已信任 hooks 会作为降级来源。

历史实测环境为 Codex Desktop `26.908.4834.0` / CLI `0.154.0-alpha.6.2`。这是内部结构化状态源，并非官方稳定接口；Codex 升级后若数据库格式改变，它可能暂时失效。程序不扫描 transcript 文本。

### Codex Desktop hooks

安装器合并了官方事件 `UserPromptSubmit`、`Stop`、`Interrupt`、`PermissionRequest`、`PreToolUse`、`PostToolUse`、`SessionEnd`：

- `UserPromptSubmit` → running
- `PermissionRequest`，以及可识别的用户输入请求 → waiting
- 后续 `PostToolUse` → running
- 正常 `Stop` → success
- `Interrupt` 或仍有活动任务时的 `SessionEnd` → error

这些映射符合官方事件契约，适配器模拟已通过。hooks 与本地状态 watcher 现在并行作为互补信号源；不会再因为 watcher 可读就丢弃 hook 生命周期事件。状态机按 turn/task 去重，并允许 watcher 的更可靠失败终态覆盖 hook 的普通完成判断。官方 hooks 没有 `TurnFailed`，`Stop` 也没有 terminal status，所以 hooks 本身不能可靠区分一般错误和额度耗尽。

若要启用等待/审批联动：

1. 在 PowerShell 启动交互式 `codex` CLI。
2. 在 CLI TUI 中输入 `/hooks`。
3. 审阅并信任 7 个命令含 `mchose-led\hook-handler.cjs` 的组。
4. 完全退出并重启 Codex Desktop；若使用 VS Code，也要 Reload Window 或重启扩展宿主。

信任与 hook 当前哈希绑定，改动 hook 后需要重新审阅。这是 Codex 的安全边界，程序不会代替用户作出信任决定。详见 [OpenAI Hooks 文档](https://learn.chatgpt.com/docs/hooks)。

### 精确的 `codex exec --json` 包装器

需要可靠识别 `turn.completed`、`turn.failed`、非零退出、启动失败和额度错误时，用下面的命令启动 CLI 任务：

```powershell
& "$env:USERPROFILE\.codex\mchose-led\mchose-led-exec.ps1" --ephemeral --skip-git-repo-check "回复 OK"
```

包装器读取官方 JSONL，真实看到 `turn.completed` 且退出码为 0 才显示绿色；其他终止路径都显示红色。它等待子进程 stdout/stderr 关闭后才判定，避免遗漏最后一条事件。它会自动选择本机最新的 Desktop 内置 Codex CLI，可用 `codex-info` 核对。它只覆盖经包装器启动的 CLI 任务，不能旁听 Desktop 已独占 stdio 的 app-server。

## 升级

```powershell
# 在安装目录以外的克隆目录运行
git pull --ff-only
npm.cmd --prefix vendor install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

升级时安装器会先让现有实例恢复并完全退出，保留用户配置，再更新文件、备份/合并 hooks 并启动新实例。若键盘离线导致恢复未完成，安装会安全中止并保留 pending，不会覆盖仍在使用的运行文件。

## 停止与取消自动启动

```powershell
$led = "$env:USERPROFILE\.codex\mchose-led\mchose-led.ps1"
& $led stop
& $led status
```

`stop` 恢复灯效、停止 daemon 并持久禁用联动，直到再次执行 `start`。若要移除登录启动项：

```powershell
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'MCHOSECodexLED' -ErrorAction SilentlyContinue
```

项目没有独立的 `uninstall` 命令。完全卸载时，先确认恢复成功且 daemon 已停止，再备份并编辑 `%USERPROFILE%\.codex\hooks.json`，仅移除命令指向本项目 `hook-handler.cjs` 的组，保留其他 hooks。最后可自行移除安装目录；恢复快照请保留到确认键盘状态正常之后。

## 测试与公开仓库边界

```powershell
npm.cmd test
npm.cmd run check
```

本次发布在原本机目录运行现有测试，38/38 通过。`tests/protocol.test.cjs` 和 `tests/snapshots-hooks.test.cjs` 依赖本机 `snapshots/legacy-baseline-k99v2-258a-010c-20260913T142853+0800`，该恢复快照按隐私与运行数据排除要求不发布。因此干净克隆运行完整测试会因这两份文件缺少 fixture 而失败；自动发现 Codex 的测试还要求本机安装 Codex。未依赖私有快照的测试可单独运行：

```powershell
node --test tests/state-machine.test.cjs tests/operation-lock.test.cjs tests/codex-state-watcher.test.cjs tests/codex-wrapper.test.cjs
```

这些本机历史快照不是首次运行的必需文件，控制器会在接管前创建当前设备自己的快照。本次未重做物理拔插、Windows 重启或实际 HID 写入验收；详见 `PUBLICATION-REPORT.md`。`PROGRESS.md` 和 `TEST-REPORT.md` 是历史开发记录，不代表每次发布都重新验证了其中的项目。

## 安全边界

- 只接受唯一匹配的 K99 V2 Col06；不会向其他 HID collection 写入。
- 每次写入采用“稳定读取当前整包 → 只改已知灯光字段 → 写回 → 读回验证”。性能包中的按键、系统模式、休眠和未知字节均保留。
- takeover 快照和 pending 指针在第一笔 HID 写入前原子落盘。
- 守护进程和所有直接命令共用跨进程排他锁；正常停止逐字节验证恢复。
- 强杀、断电或拔线会留下恢复依据；恢复中途断线时 `restore --watch` 会等待重连。
- 本地状态 watcher 以 SQLite `readOnly` + `query_only` 方式短查询，不修改 Codex 数据库，也不读取对话内容。
- 不要让 MCHOSE HUB 与本程序同时控制灯光。

协议依据和续接信息见 `PROGRESS.md`，实际验收结果及未验证项见 `TEST-REPORT.md`。
