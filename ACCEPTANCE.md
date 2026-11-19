# 验收记录（ACCEPTANCE）

逐项验收此插件的目标行为。**已实际跑通的步骤标 ✅ 并附证据；尚未跑通的明确标 ⏳ 待验证。**

目标版本：`@deepseek-ai/dsh` 0.2.2-rc.3（Desktop，Windows）；`@deepseek-ai/dsh-tool-subagent` 0.2.2-rc.3（实际加载版本已核对）。

## A. 静态交付（已完成）

| 项 | 结果 | 证据 |
|---|---|---|
| 源码交付 | ✅ | `sync-core.js`（纯合并算法）、`engine.js`（同步引擎）、`index.js`（插件壳：volatile Config / 事件 / 命令） |
| 测试 | ✅ | `npm test`（PowerShell 用 `npm.cmd test`）：25/25 通过（12 合并算法 + 13 引擎） |
| 安装/卸载说明 | ✅ | `README.md` + `install-profile.mjs` / `uninstall-profile.mjs`（备份、BOM 防护、写后校验、`--dry-run`） |
| 命名验证 | ✅ | `validate-names.mjs` 兼容通过（2 条社区风格 warning 为本机 `dshx-*` 惯例让位）；registry 查重无已审阅冲突 |
| 路线合规 | ✅ | 只用公开接口（`ctx.llm` 目录、`ctx.settings.update`、`ctx.commands`）；不改 app.asar、官方插件产物、会话历史；不读密钥；无运行时猴子补丁（对比社区 workaround 依赖 `dsh-agent-loop` 内部事件顺序，见 README 设计边界） |

## B. 路由可用性预验收（2026-11-18，在既有老会话、手工名单下完成）

目的：把"OpenAI 路由本身可调"与"插件同步效果"两个变量分开。手工名单里已有 `openai/gpt-6.2-astra` 条目，本节不依赖插件。

| 项 | 结果 | 证据 |
|---|---|---|
| `list_subagent_models` 解析 `openai/gpt-6.2-astra` | ✅ | 返回 `openai/gpt-6.2-astra — GPT-6.2 Astra`；该模型无 advertised reasoning efforts（调用时不传 `reasoning_effort`） |
| `subagent` 显式选择该路由实际返回 | ✅ | 子代理 `astra-probe`（provider=openai, model=gpt-6.2-astra，prompt“只回复 OK”）完成，最终回复 **`OK`** —— OpenAI 实际返回 |
| 主对话当前模型未被改变 | ✅ | 主对话仍为 `openai/gpt-6.2-sol` |

## C. 安装后正式验收（进行中）

1. **名单写入 ✅**（2026-11-19 00:09 核验 `cordis.patch.yml`）：
   - 官方 `subagent-model-selection-settings.allowedModels` = 10 条 = 原 9 条手工条目（原样、原顺序：openai/gpt-6.2-astra、codex/gpt-6.1-sol、codex/gpt-6-astra、claude/claude-opus-5-5、antigravity/gemini-3.8-flash-tiered、workbuddy-ai/deepseek-v4.1-flash、workbuddy-ai/step-5-preview、grok/grok-4.7）+ **`openai/gpt-6.2-sol`（插件新增，追加尾部）**。
   - 插件 `managedRoutes` 影子 = **仅 `[openai/gpt-6.2-sol]`** —— 手工的 astra 未被接管（"手工条目永不成为插件管理条目"的直接证据）。
   - `enabled: true` / `providers: [openai]` 持久化正确。插件的首次同步在重启后自动完成（无需手动命令）。
2. **全新会话授权 ⏳**：已排定自动化验收会话（00:13 触发的 schedule，新顶层会话），执行 `list_subagent_models`（openai 全量 + 精确 astra）并把逐字结果写入 `test/acceptance-new-session.md`。注意：**已有会话沿用创建时的名单**，本项必须在新建对话验证。
3. **全新会话子代理实跑 ⏳**：同一验收会话内 `subagent provider=openai model=gpt-6.2-astra`（prompt“只回复 OK”，不传 reasoning_effort），记录子代理最终回复。
4. **主对话模型不变 ⏳**：验收会话记录其自身主对话模型，确认显式子代理选路不影响主对话。

## 已知边界（如实说明，不算通过项）

- 官方实现在新会话创建时采样名单；**已有会话不会回填**——需要新建对话才能拿到新名单。
- 官方 `enabled=false` 时名单仍会被同步（作为用户配置一部分），但新会话不应用；插件会警告。
- 模型目录变化到插件完成同步之间有事件驱动的短窗口；`/subagent-model-sync` 可立即收敛。
- 官方空名单 + enabled=true 会让新会话模型选择退化为仅父路由；插件写空名单前会警告。
