# MCHOSE Codex Status LED

Turn your MCHOSE keyboard RGB into a real-time Codex status indicator, with automatic Windows startup, HID reconnect recovery, and customizable lighting states.

**v1.6.0** · Windows 键盘 RGB 控制器。已验证的设备范围为 Windows x64、有线 USB 的 `BY Tech / MCHOSE K99 V2`：VID/PID `258A:010C`、release `0x0200`、`FF00:1`、interface 1、Col06。其他型号、无线模式和系统尚未验证。

| 灯光 | 含义 |
|---|---|
| 粉色静态 `#FF69B4` | 空闲或等待输入/审批 |
| 蓝色呼吸 `#0060FF` | 执行或思考中 |
| 绿色 `#00FF00` | 成功，持续 2.5 秒 |
| 红色 `#FF0000` | 失败、中断或取消，持续 5 秒 |

终态提示结束后回到空闲灯效。v1.6.0 修复恢复指针覆盖、重装误删其他 hooks、迟到事件影响新批次、重复审批漏报，以及灯光通信失败改变 CLI 退出码的问题。详见 [CHANGELOG](CHANGELOG.md)。

## 安装与升级

准备 Git、带 npm 的 Node.js **24+** 和 Codex。脚本会检查 Node 版本与 `node:sqlite`，在可用的 Codex 自带运行时、系统安装和 PATH 中选择受支持版本。

在安装目录以外克隆仓库：

```powershell
git clone https://github.com/FxYaM/Mchose_Codex_Led.git
Set-Location Mchose_Codex_Led
npm.cmd --prefix vendor ci
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

依赖由 `vendor/package-lock.json` 固定，`node-hid` 版本为 3.1.2。安装前关闭 MCHOSE HUB 对灯光的控制并连接键盘。安装器会先检查依赖、停止并恢复旧实例，保留现有 `config.json`，再复制运行文件、合并 hooks、启动 daemon 并注册当前用户登录自启动。如果恢复未完成，安装会中止；连接键盘执行 `restore --watch` 后再试。

升级时在原源码目录执行 `git pull --ff-only`、`npm.cmd --prefix vendor ci`，然后重新运行 `install.ps1`。不要从已安装目录执行安装；脚本会拒绝复制到自身。

| 位置 | 用途 |
|---|---|
| `%USERPROFILE%\.codex\mchose-led` | 程序与 `config.json` |
| `%LOCALAPPDATA%\MCHOSECodexLED` | 默认运行目录：日志、状态、测试结果、恢复快照 |
| `%USERPROFILE%\.codex\hooks.json` | Codex hooks；保留本项目以外的条目，包括同组条目 |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MCHOSECodexLED` | 当前用户登录自启动 |

登录时隐藏执行 `mchose-led.ps1 autostart`。手动 `stop` 会持久禁用自动联动，重启后仍保持停止，执行 `start` 才重新启用。安装器不会修改 `config.toml` 的 `notify` 或代替用户信任 hooks。

## 常用命令

```powershell
$led = "$env:USERPROFILE\.codex\mchose-led\mchose-led.ps1"
& $led start
& $led status
& $led diagnose
& $led codex-info

& $led running     # 蓝色呼吸
& $led success     # 绿色提示
& $led error       # 红色提示
& $led waiting
& $led idle
& $led auto        # 退出手动覆盖

& $led stop        # 恢复接管前灯效，清空任务并持久禁用
```

仅保持 Codex 程序打开不会触发 running。多个任务并行时，running 优先于 waiting；同批任务全部结束后才显示终态，失败优先于成功。旧批次的迟到事件不会改变新批次的结果。

## 配置灯效

编辑已安装目录的 `config.json`：

| 字段 | 含义 |
|---|---|
| `states.idle` / `states.waiting` | 默认粉色静态，亮度 75% |
| `states.running` | 默认蓝色呼吸 |
| `states.success` / `states.error` | 终态颜色和提示时间 |
| `mode` | `static`、`breathing`；`preserve` 用于恢复接管前灯效 |
| `color` | `#RRGGBB` |
| `brightnessPercent` | 1–100，映射到硬件 1–4 档 |
| `breathingSpeed` | 呼吸速度 1–4 |
| `durationMs` | 成功/异常提示持续时间，毫秒 |
| `codex.stateDatabaseWatcher.enabled` | 本机状态 watcher，默认 `true` |
| `codex.stateDatabaseWatcher.codexHome` | watcher 读取的 Codex 数据目录，默认 `%USERPROFILE%\.codex` |
| `codex.stateDatabaseWatcher.pollIntervalMs` | 默认 350 ms |
| `codex.stateDatabaseWatcher.initialLookbackMs` | 启动时恢复活动任务的最大年龄，默认 6 小时 |
| `codex.stateDatabaseWatcher.includeSubagents` | 是否计入内部子代理，默认 `false` |

修改前先执行 `stop`，修改完成后执行 `start`。例如可将 idle/waiting 的 `color` 改为 `#FFD0E8`、`brightnessPercent` 改为 50。安装器保留用户配置；旧版本的 idle/waiting `preserve` 会按既有迁移规则改为明确灯效。

## 快照、恢复与重连

```powershell
& $led stop
& $led snapshots
& $led restore --watch          # 有 pending 时先完成恢复；离线会继续等待
& $led read
& $led snapshot --kind before-customization
& $led device-test --duration-ms 5000
& $led restore --snapshot "<快照目录或 ID>"
& $led start
```

`restore` 不带快照参数时要求存在 pending；没有 pending 时可跳过该步骤。直接读取、拍快照、恢复和设备测试共用 HID 排他锁。设备测试要求先停止控制器，并在有待恢复快照时拒绝开始，防止覆盖原始恢复依据。

程序先保存完整快照和 pending 指针，再改变灯效。断线或异常退出时保留恢复数据，下次启动先恢复并逐字节验证，再重新接管。恢复命令保持控制器停用，完成后按需 `start`。

设备必须唯一匹配稳定身份字段；Windows 重启或 USB 重新枚举造成的 endpoint 路径变化可以接受。K99 V2 无序列号，无法区分先后换上的两把身份完全相同的键盘。恢复时请连接原设备。已移除无效的 `--accept-device` 参数；它不能用来绕过身份检查。

日志在约 1 MiB 时轮转，保留三个归档。成功恢复后，自动生成且已验证的快照保留最近 20 份；pending、手动、旧版、损坏和未验证的快照不会被自动删除。协议细节见 [协议说明](docs/PROTOCOL.md)。

## Codex 联动

**Desktop 本地状态 watcher** 默认只读查询 `thread_history_*.sqlite` 与 `state_*.sqlite` 的任务 ID、状态和时间，不读取对话正文、rollout 或 error_json：`inProgress` 对应 running，`completed` 对应 success，`failed`/`interrupted` 对应 error。启动时不重放历史终态，默认过滤子代理和陈旧活动任务。

SQLite 是 Codex 的内部结构化状态源，不是稳定官方接口。历史兼容环境为 Desktop `26.908.4834.0` / CLI `0.154.0-alpha.6.2`。数据库缺失、锁定或结构不兼容时，`status` 会报告 watcher 不健康并重试；hooks 仍可提供信号。

**Desktop hooks** 与 watcher 并行工作，安装事件为 `UserPromptSubmit`、`Stop`、`Interrupt`、`PermissionRequest`、`PreToolUse`、`PostToolUse`、`SessionEnd`。等待由审批/输入事件触发，对应工具完成后解除；无关工具完成不会清除等待。若源事件没有调用 ID，只能按工具名和参数关联，不能精确区分同时发生的相同工具调用。

等待/审批联动需要用户信任 hooks：

1. 在 PowerShell 启动交互式 `codex` CLI。
2. 在 CLI TUI 中输入 `/hooks`，审阅并信任命令指向本项目 `hook-handler.cjs` 的七个组。
3. 完全重启 Codex Desktop；VS Code 需要重载窗口或扩展宿主。

变更后的 hook 可能需要重新审阅。不要手工写入 `trusted_hash`。`hooks-snippet.example.json` 只是占位符参考，不能原样执行。普通 Stop 不包含可靠失败终态，hooks 单独无法区分所有一般错误或额度耗尽；watcher 的失败可以修正原批次的成功判断。参见 [Hooks 文档](https://learn.chatgpt.com/docs/hooks)。

**CLI JSONL 包装器** 仅覆盖经它启动的任务：

```powershell
& "$env:USERPROFILE\.codex\mchose-led\mchose-led-exec.ps1" --ephemeral --skip-git-repo-check "回复 OK"
```

包装器等待 stdout/stderr 关闭后判定灯光；只有看到 `turn.completed` 且退出码为 0 才显示成功。stdout 原样转发，退出码保留 Codex 的实际结果；LED 故障只写诊断到 stderr，不阻止任务执行。控制器停止时仍可运行任务，且不会自动重新启用灯光。它不能旁听 Desktop 已独占的 app-server stdio。

## 卸载

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.codex\mchose-led\uninstall.ps1"
```

卸载器先停止并确认恢复完成，再移除当前安装的 hooks、自启动项和程序目录，保留其他 hooks。配置备份和所有运行/恢复数据保留在配置指定的 runtimeDirectory。若键盘离线、恢复未完成或路径不符合预期，卸载中止；先恢复后再重试。

## 开发与验证

```powershell
npm.cmd run check
npm.cmd test
```

软件测试不需要真实键盘、Codex 安装或私人快照，使用合成协议数据、临时 SQLite 和模拟子进程。Windows CI 验证锁文件安装、语法和回归测试。测试范围及实机边界见 [验证说明](docs/VALIDATION.md)。

## 许可

本项目当前为 **UNLICENSED，保留所有权利**，未授予开源复用许可。公开源码不等同于开源授权。第三方依赖保留各自许可证；本仓库不包含其安装目录。
