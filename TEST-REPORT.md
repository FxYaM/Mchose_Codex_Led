# 验收报告

更新时间：2026-09-15（Asia/Shanghai）

## 已实际通过

| 项目 | 结果与证据 |
|---|---|
| JS 语法、PowerShell 和 JSON | 所有非 vendor CJS 通过 `node --check`；3 个 PowerShell 脚本通过 AST 解析；配置与 hooks snippet 可解析 |
| 协议、排他锁、快照、hooks 映射、wrapper 路径、状态机、SQLite watcher | Node 测试 **35/35** 通过，0 failed |
| original.bin 保全 | 两文件仍为只读，SHA-256 分别为 `77FC8098...6DA4`、`C45198B3...953C`，与最初基线一致 |
| 安全读取脚本 | 最新创建 `diagnostic-read-20260914T150402Z-ee34803e`，没有覆盖 original.bin，也没有泄漏排他锁 |
| HID 稳定读取 | 修复瞬态响应后，实机 100 次完整状态读取全部匹配基线哈希 |
| 最终可逆实机测试 | `device-test-20260914T150909Z-edec1d.json`：蓝色呼吸读回 mode 2、RGB `0,96,255`、亮度 3、速度 4、multiColor 0；随后恢复全包逐字节相同；四类 error 均为 null，original 哈希未变，pending 与 operation lock 均已清除 |
| 测试失败仍执行恢复 | 两份历史故障注入/旧协议结果中 testError 非空，但 restoreError、mismatch、closeError 均为空且 `restoredAndVerified=true`，证明主错误不会跳过恢复报告 |
| 单实例与启停 | 第二次 start 返回 already-running；stop 恢复并释放锁。持久 stop 后模拟 hook 返回 `{}`、不启动 daemon；再次 start 明确启用 |
| stop 清除旧任务 | 实机加入 running task 后 stop，machine task 数为 0；重新 start 保持 idle，不再复活停用前任务 |
| HID 跨进程排他 | daemon 持有 `hid-operation.lock.json`；运行中直接 read 被拒绝；stop 后直接 read 和安全 reader 成功；退出后锁删除；单元测试验证第二持有者被拒绝 |
| 恢复中途断线分类 | 单元测试注入打开设备后的 offline 错误；`restore --watch` 保留 pending、重试后恢复并清除。身份不匹配仍不会重试 |
| 多任务冲突 | A+B 同时运行时为蓝色；A 完成后 B 仍保持 running；B waiting 时释放接管；B resume 后再变蓝；全部成功后才变绿 |
| 成功与异常提示 | 成功读回静态 `0,255,0`，2.5 秒后恢复；失败和 Interrupt 读回静态 `255,0,0`，5 秒后恢复；最终 pending 均为空 |
| hook 适配器模拟 | 实际运行已安装 handler：UserPromptSubmit → running、PermissionRequest → waiting、PostToolUse → running、Stop → success、Interrupt → error；同一 turn 的不同审批不再错误去重 |
| 强杀恢复 | 核对目标 PID 是 node daemon 后强制结束；pending 保留且键盘读回仍为蓝色。下次 start 先精确恢复旧 takeover，再建立新 takeover；终态过期后恢复基线并清 pending |
| 真实 CLI 成功联动 | 新版安装 wrapper 调用 Desktop 内置 `codex-cli 0.154.0-alpha.6.2`；运行中观察到 running，JSONL 为 `thread.started`、`turn.started`、`item.completed`、`turn.completed`；等 stdio close 后判成功，绿色再恢复，task 0、pending 空 |
| 真实 CLI 异常联动 | 新版 wrapper 传入无效参数，实际 exit 2、turn_failed、静态 RGB `255,0,0`；5 秒后恢复 idle，pending 空 |
| 安装升级 | 旧实例先恢复并完全退出；现有 config 被保留；hooks.json 备份后合并。Stop 保留原飞书组，MCHOSE 各目标组不重复 |
| 用户肉眼灯效 | 用户确认手动 `running → success → error → idle` 的蓝色呼吸、绿色、红色与恢复均符合预期 |
| Desktop 未触发根因审计 | app-server `hooks/list` 证实 7 个 MCHOSE 组全为 `untrusted`；`config.toml` 唯一 trusted_hash 属于飞书 Stop；旧 Desktop app-server 又早于 hooks 写入，controller 日志无真实 hook 事件 |
| SQLite watcher fixture | 覆盖 fresh/stale active、历史终态不重放、completed、failed、interrupted、短任务、重复轮询、子代理/未知线程过滤、缺库、schema 不兼容和最高兼容版本回退 |
| 双源竞态 | 状态机 tombstone 测试证实重复终态不延长提示、迟到 resume 不复活、failed 可把 success 升为 error、success 不能覆盖 error，且 tombstone 可持久化 |
| 真实 Desktop 执行中联动 | 安装后 watcher 从当前真实主对话读到唯一根任务 `inProgress`；daemon desired=`running`，实机读回 mode 2、RGB `0,96,255`、brightness 3、speed 4、multiColor 0；3 个内部子代理被过滤 |
| watcher 下的停止/恢复/重启 | 当前真实任务运行中执行 stop，daemon 完全退出、pending 清空，直接读回原 mode 1 / 静态 `255,241,241`；再次 start 后自动重建任务并读回蓝色呼吸，watcher healthy、lastError=null |
| watcher 健康时 hook 降级策略 | 注入假的 UserPromptSubmit hook 后任务数仍为 1 且唯一来源为 `codex-local-state`，证明结构化终态源优先；waiting/resume hooks 仍保留 |

最新实机结果：

`%LOCALAPPDATA%\MCHOSECodexLED\test-results\device-test-20260914T150909Z-edec1d.json`

最新真实 wrapper 结果：

- `work\final2-codex-wrapper-success.jsonl`
- `work\final2-codex-wrapper-success.stderr.txt`
- `work\final2-codex-wrapper-failure.jsonl`
- `work\final2-codex-wrapper-failure.stderr.txt`

## 未验证或受限

| 项目 | 状态 / 具体原因 |
|---|---|
| 当前真实 Desktop 终态 | 当前对话的 running 与实机蓝色读回已通过；本次回复结束后才会产生它的真实 completed 事件，因此绿色终态需用户观察，不能提前冒充已通过 |
| 官方 Codex Desktop hooks | handler 模拟通过，但 7 个 MCHOSE hooks 仍未信任。必须在交互式 Codex CLI TUI 使用 `/hooks` 信任，再完全重启 Desktop/VS Code；Desktop 聊天框中的 `/hooks` 无效 |
| Desktop 一般失败 / 额度耗尽 | 本机历史投影中真实额度耗尽均为 `failed`，watcher fixture 的 failed→红色状态路径已通过；尚未为实机验收刻意再次消耗额度。官方 hooks 本身仍无法可靠分类 |
| 物理拔线再重插 | 尚未实际拔线；恢复机制已用 daemon 强杀端到端验证、用注入 offline 验证 `restore --watch` 重试。物理 USB 重连仍需用户配合 |
| 换 USB 口恢复 | 未测试。设备无序列号，默认会因 endpoint 变化拒绝；需用户确认设备后显式 `--accept-device` |
| 普通文本等待输入 | PermissionRequest 与可识别工具路径已覆盖；Desktop 中不经过这些 hook 的普通追问只能尽力判断 |

当前交付状态：daemon 已启用并运行、watcher healthy、当前真实根任务 1、desired=running、pending 指向本次安全 takeover。该任务结束后预期绿色 2.5 秒，再恢复接管前灯效并清 pending；若终态未发生，可用 `status` 和 controller 日志继续定位。

## v1.5 PID reuse regression

- PASS: exclusive lock/release behavior remains intact.
- PASS: a lock created before the current system boot is reaped even when its recorded PID now belongs to a live process.
- Full Linux/container run: 37/38 pass; the single failure is the existing automatic Codex CLI discovery test because Codex CLI is not installed in this environment.
