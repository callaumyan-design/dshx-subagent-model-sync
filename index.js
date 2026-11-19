// dshx-subagent-model-sync — host half (thin shell).
//
// Problem: `@deepseek-ai/dsh-tool-subagent/model-selection-settings` only
// accepts an exact `{provider, model}` allowlist (no wildcards). Every time a
// provider ships, enables, or disables a model, the user has to maintain that
// list by hand.
//
// What this plugin does: the user selects PROVIDERS (e.g. `openai`) in this
// plugin's settings. The plugin reads the real route ids from the DSH model
// catalog (`ctx.llm.listProviders()` / `ctx.llm.listModels()`), merges every
// model of those providers into the official allowlist, and keeps a "shadow"
// record of the entries it wrote itself:
//
//   * Manual entries never enter the shadow and are never withdrawn.
//   * Only plugin-written entries are withdrawn, and only when their model
//     left the catalog, they were excluded, or their provider was deselected.
//   * A provider whose catalog cannot be read is treated as "unknown": its
//     entries are kept untouched. A transient catalog failure is never
//     mistaken for an empty catalog.
//
// Writes go through the SUPPORTED configuration path only:
// `ctx.settings.update()` (dsh-settings) → `ctx.configEditor.edit()`
// (Loader reconcile + atomic YAML patch write with lock and rollback). This
// plugin never edits the profile YAML itself, never touches the official
// `enabled` flag, never reads credentials, and never appends session events.
//
// WHEN CHANGES TAKE EFFECT (official behavior, verified against
// @deepseek-ai/dsh-tool-subagent 0.2.2-rc.3):
//   * The official service samples its volatile config when a NEW top-level
//     session is created (`agent/created`) and records
//     `subagent/model-selection-policy`; child sessions inherit it.
//   * So: after this plugin finishes a sync, the updated list applies to
//     sessions created AFTER that point. Existing sessions keep the list
//     they were created with — start a new conversation to pick it up.
//   * "Sync completed" is not "route authorized": the child LLM route is
//     still subject to DSH's account, availability, and billing checks when
//     a subagent actually calls it.
//
// Triggers: plugin load/config change (HMR), `llm/adapters-updated`
// (provider topology), `app-boot/config-reload` (any profile config write,
// e.g. editing provider models), and the manual `/subagent-model-sync`
// command. All merge logic lives in sync-core.js (pure); the orchestration
// in engine.js (host-service stubs in tests); this file only declares the
// plugin surface.

import z from '@deepseek-ai/schemastery'

import { createEngine, renderReport } from './engine.js'

export const name = 'dshx-subagent-model-sync'

// `llm` — model catalog reads; `settings` — the supported write path for the
// official allowlist. Both are composed in the desktop profile this plugin
// targets. The command registry is optional and probed at runtime.
export const inject = ['llm', 'settings']

const RouteSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** All fields are volatile so they are editable in the DSH settings UI. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile().description(
    '启用自动同步：把“提供商”里每个模型自动加入官方子代理白名单（仅对新会话生效）'),
  providers: z.array(z.string().min(1)).default([]).volatile().description(
    '允许子代理使用的提供商 id 列表（如 openai）。这些提供商目录里的全部模型会自动进入白名单'),
  excludeModels: z.array(RouteSchema).default([]).volatile().description(
    '从自动同步中排除的精确路由（provider/model）。只想排除某几个模型时用它，不必取消整个提供商'),
  managedRoutes: z.array(RouteSchema).default([]).volatile().description(
    '影子记录：本插件写入过哪些白名单条目。自动维护，请不要手工编辑；手工加的条目不会出现在这里，也永不会被插件撤掉'),
})

/**
 * Register the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 */
export function apply(ctx, config) {
  const log = ctx.logger
  const engine = createEngine({ ctx, config })

  ctx.on('llm/adapters-updated', () => engine.schedule('llm/adapters-updated'))
  ctx.on('app-boot/config-reload', () => engine.schedule('config-reload'))
  // Our own writes trigger `app-boot/config-reload`; the sync is idempotent
  // and a no-change pass writes nothing, so the loop converges immediately.
  engine.schedule('load')

  // Optional manual command — present whenever the host command registry is.
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'subagent-model-sync',
      description: '立即按已选提供商的模型目录同步子代理白名单（只对之后新建的会话生效）',
      handler: async () => {
        const report = await engine.syncOnce('command')
        return { kind: report.kind === 'error' ? 'error' : 'success', text: renderReport(report) }
      },
    }))
  } else {
    log.warn('dshx-subagent-model-sync: the commands service is unavailable; /subagent-model-sync is not registered')
  }

  ctx.effect(() => () => engine.dispose())
}
