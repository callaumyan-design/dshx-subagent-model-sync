# dshx-subagent-model-sync

把 DSH 官方子代理模型白名单（`subagent-model-selection-settings` 的 `allowedModels`）从"逐条手填 `provider/model`"改成"按提供商自动同步"。

在设置里选择允许子代理使用的**提供商**（例如 `openai`），该提供商在 DSH 里已注册、已启用的全部模型会自动进入**新会话**的子代理可选范围。以后在 `openai` 下新增或停用模型，不需要再维护第二份名单。

针对 `@deepseek-ai/dsh` **0.2.2-rc.3**（`@deepseek-ai/dsh-tool-subagent` 0.2.2-rc.3）开发并验证；使用其公开服务接口（`ctx.llm` 目录、`ctx.settings` 配置通道、`ctx.commands` 命令），不修改 app.asar、官方插件产物或会话历史。

## 工作机制

```
选中提供商 ──ctx.llm.listModels()──► 真实模型目录（精确 provider/model）
                                          │
官方 allowedModels（手工条目）──合并──────►┤
插件 managedRoutes（影子记录）──────────► next 名单 ──ctx.settings.update()──► 官方配置
```

- **手工条目永不丢失**：你自己在官方设置里加的条目从不进入插件的影子记录，也永远不会被插件撤掉。
- **只撤自己写的**：插件写入的条目（影子记录）只在三种情况下被撤——模型离开目录、路由被 `excludeModels` 排除、提供商被取消选择。
- **目录读取失败 ≠ 空目录**：某个提供商的目录暂时读不出来时，它视作"未知"，其条目原样保留，绝不清空。
- **去重幂等**：重复同步、并发触发都会收敛；名单内容无变化时不写配置。
- **写入走官方通道**：`ctx.settings.update()`（dsh-settings）→ `configEditor.edit()`（Loader 热载 + 原子写 + 失败回滚）。插件从不直接改 profile 的 YAML 文件、从不碰官方设置的 `enabled` 开关、从不读任何密钥。

### 触发时机

- 插件加载/配置变更（HMR）
- `llm/adapters-updated`：提供商注册集变化（新增/删除提供商）
- `app-boot/config-reload`：任何 profile 配置写入之后（例如你在提供商设置里增删模型）
- 手动命令 `/subagent-model-sync`

## 生效时机（重要）

官方实现在**新顶层会话创建时**（`agent/created`）采样配置并写入 `subagent/model-selection-policy`，子会话继承。因此：

- 同步完成后，**之后新建的对话**拿到新名单；
- **已有会话不会回填**——它们沿用创建时的名单，验证时请新建对话；
- "同步成功"不等于"路由已通"：子代理实际调用该模型时，仍要经过 DSH 的账号、模型可用性和计费检查。命令输出里会明确区分这两件事。

模型目录变化到插件完成同步之间有一个短暂的事件驱动窗口；等不及时可以手动执行 `/subagent-model-sync` 立即同步。

## 安装 / 卸载

安装（须先完全退出 DSH，托盘 → 退出）：

```
node install-profile.mjs          # 或 --dry-run 先看会改什么
```

默认在挂载条目里预填 `enabled: true` + `providers: [openai]`（装完即用）；加 `--no-preset` 只挂载、装完自己在设置里开启。

启动 DSH 后，插件在加载时自动完成首次同步。启动装载顺序不定时有两层自愈：官方设置条目暂未就绪会自动重试（至多 3 次），提供商注册完成的事件（`llm/adapters-updated`）也会再触发同步。也可以手动执行 `/subagent-model-sync` 立即同步并查看明细。

卸载（同样先退出 DSH）：

```
node uninstall-profile.mjs
```

默认保留官方名单里已由插件写入的条目（卸载后成为普通手工条目）。想彻底清掉：**先**在插件设置里清空 `providers`（或关掉 `enabled` 前跑一次 `/subagent-model-sync`），让插件撤掉自己管理的全部条目，**再**卸载。

## 配置（全部为 volatile 字段，可在 DSH 设置页编辑）

| 字段 | 说明 |
|---|---|
| `enabled` | 插件总开关。关闭 = 停止管理（不撤已有条目） |
| `providers` | 选中的提供商 id 列表，如 `["openai"]`。用内部 id，不是显示名 |
| `excludeModels` | 精确路由黑名单：只想排除某几个模型时用它，不必取消整个提供商 |
| `managedRoutes` | 影子记录（插件写入过哪些条目）。自动维护，请勿手工编辑 |

## 命令

```
/subagent-model-sync
```

立即同步一次，输出：新增/撤销明细、名单计数、警告（目录失败、官方开关状态、空名单提示）、生效时机说明。

## 设计边界与已知限制

- 官方 `allowedModels` 只接受精确 `provider/model`，没有通配符；本插件通过"目录 → 精确名单"的同步实现等价效果，而不是伪造通配符。
- 官方在 `agents.create` 时机注入 per-session policy 的社区做法（见 [deepseek-harness discussion #12836](https://github.com/deepseek-ai/deepseek-harness/discussions/12836) 的 Workaround）依赖 `dsh-agent-loop` 内部事件顺序与事件形状，**均非公开 API**，本插件刻意不用。
- 最小上游改动方案：官方支持提案 A（`model: "*"` 的 per-provider wildcard，见 discussion #12836），由官方在 child 路由检查时对照目录解析。届时本插件可整体退役。
- `app-boot/config-reload` 是宽信号（任何配置写入都触发）；插件靠幂等计算保证不产生多余写入。
- 官方实现在 `enabled=true` 且名单为空时会拒绝为新会话写入策略（新会话退化为仅父路由可显式选择）；本插件在写空名单前会给出警告，但尊重你的选择。
- 官方设置 `enabled=false` 时名单仍会被同步（作为你的配置一部分），但插件会警告"新会话不会应用"。

## 测试

```
node test/sync-core.test.mjs   # 纯合并逻辑：12 例
node test/engine.test.mjs      # 同步引擎（stub 服务）：12 例
```

覆盖：手工条目保留、目录停用只撤托管条目、取消选择、目录失败保留、exclude、幂等、去重、畸形输入、设置冲突重试、空名单警告、官方开关警告、并发收敛、HMR dispose。

## 版本兼容

- 在 `@deepseek-ai/dsh` 0.2.2-rc.3（Desktop、Windows）上验证。
- 依赖公开服务：`ctx.llm`（`listProviders`/`listModels`）、`ctx.settings`（`describe`/`update`）、`ctx.commands`（可选，缺失时仅命令不可用）。
- 升级 DSH 后若 `dsh-tool-subagent` 的设置入口（`subagent-model-selection-settings`）变化，插件会"fail loud"报错并停止写入，不会破坏名单。
