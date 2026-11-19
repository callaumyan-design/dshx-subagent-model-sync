// dshx-subagent-model-sync — sync engine.
//
// Orchestrates one sync pass: read the live catalog for the selected
// providers through `ctx.llm`, compute the next official allowlist with
// sync-core.js, and persist it through the SUPPORTED configuration path
// `ctx.settings.update()` (dsh-settings → configEditor → Loader reconcile +
// atomic YAML patch write). No host imports here, so component tests can
// drive the engine with plain stubs under native Node.
//
// Guarantees enforced here (mirroring the plugin contract):
//   * Only `allowedModels` of the official entry is ever written — never the
//     official `enabled` flag.
//   * Manual allowlist entries never enter the shadow and are never withdrawn.
//   * A provider whose catalog cannot be read (or is not registered) is
//     "unknown": its shadow entries are kept as-is. A transient catalog
//     failure is never mistaken for an empty catalog.
//   * One settings-revision conflict triggers exactly one re-read + recompute
//     + rewrite; a second conflict propagates.
//   * The engine never touches credentials, session events, or profile files.

import { computeSyncStep, dedupeRoutes, routeKey } from './sync-core.js'

/** Profile entry id of the official subagent model-selection setting. */
export const OFFICIAL_NS = 'subagent-model-selection-settings'

/** This plugin's own profile entry id (settings namespace for the shadow). */
export const OWN_NS = 'dshx-subagent-model-sync'

/**
 * Read a possibly-volatile config field (Cordis volatile fields expose
 * `.get()`; plain values are returned as-is so tests and direct applies work).
 * @param {unknown} field
 * @returns {unknown}
 */
function readVolatile(field) {
  return typeof field === 'object' && field !== null && typeof field.get === 'function'
    ? field.get()
    : field
}

/**
 * Human-readable route label.
 * @param {{provider: string, model: string}} route
 * @returns {string}
 */
export function routeLabel(route) {
  return `${route.provider}/${route.model}`
}

/** Recognize SettingsConflictError without importing host internals. */
function isSettingsConflict(error) {
  return typeof error === 'object' && error !== null && error.code === 'SETTINGS_CONFLICT'
}

/** Deduplicate a candidate string list. */
function dedupeStrings(values) {
  const out = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Ordered equality for two route lists. */
function sameRouteLists(left, right) {
  if (left.length !== right.length) return false
  return left.every((route, index) => routeKey(route) === routeKey(right[index]))
}

/**
 * Create the sync engine.
 * @param {object} input
 * @param {object} input.ctx - Cordis context providing `llm`, `settings`, `logger`.
 * @param {object} input.config - Plugin config (possibly volatile fields).
 * @param {number} [input.debounceMs] - event debounce (tests may shorten).
 * @returns {{schedule: (reason: string) => void, syncOnce: (reason: string) => Promise<object>, dispose: () => void}}
 */
export function createEngine({ ctx, config, debounceMs = 1500 }) {
  const log = ctx.logger
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  /** @type {Promise<object> | null} */
  let inflight = null
  let disposed = false
  /** Retries left when the official entry is not yet loaded (startup order). */
  let retryLeft = 3

  /** Current plugin config as a detached snapshot. */
  const readConfig = () => ({
    enabled: readVolatile(config.enabled) === true,
    providers: dedupeStrings(readVolatile(config.providers)),
    excludeModels: dedupeRoutes(readVolatile(config.excludeModels) ?? []),
    managedRoutes: dedupeRoutes(readVolatile(config.managedRoutes) ?? []),
  })

  /**
   * Read the live catalog for the selected providers. Every provider is
   * isolated: one failing read never blocks the others and never clears
   * that provider's entries.
   * @param {string[]} providers
   */
  const readCatalog = async (providers) => {
    const registered = new Set(ctx.llm.listProviders().map(provider => provider.id))
    /** @type {Record<string, string[]>} */
    const catalog = {}
    /** @type {string[]} */
    const failed = []
    /** @type {string[]} */
    const unregistered = []
    for (const provider of providers) {
      if (!registered.has(provider)) {
        unregistered.push(provider)
        failed.push(provider)
        continue
      }
      try {
        catalog[provider] = (await ctx.llm.listModels(provider)).map(model => model.id)
      } catch (error) {
        failed.push(provider)
        log.warn('dshx-subagent-model-sync: catalog read for provider "%s" failed; keeping its entries as-is',
          provider)
        log.warn(error)
      }
    }
    return { catalog, failed, unregistered }
  }

  /**
   * One full sync pass; concurrent callers share the in-flight pass.
   * When the official entry is not yet loaded (plugin mount order during
   * startup), a bounded retry is scheduled automatically — the startup
   * settle does not necessarily emit `app-boot/config-reload`.
   * @param {string} reason - trigger label for logs and the command report.
   * @returns {Promise<object>} structured report (see renderReport).
   */
  const syncOnce = async (reason) => {
    if (inflight !== null) return inflight
    inflight = run(reason).finally(() => { inflight = null })
    const report = await inflight
    if (report.kind === 'error' && report.retryable === true && retryLeft > 0 && !disposed) {
      retryLeft -= 1
      log.warn('dshx-subagent-model-sync: official settings entry not ready yet; retry %d of 3',
        3 - retryLeft)
      schedule('official-not-ready')
    }
    return report
  }

  const run = async (reason) => {
    const settings = ctx.settings
    const state = readConfig()
    const base = {
      reason,
      providers: state.providers,
      added: [],
      removed: [],
      retainedUnknown: [],
    }
    if (!state.enabled) {
      return { ...base, kind: 'disabled', warnings: ['插件未启用：在 dshx-subagent-model-sync 设置里打开 enabled'] }
    }

    // The official entry must be loaded and configurable; without it there is
    // nothing to sync into. Fail loud, write nothing, retry a bounded number
    // of times because plugin mount order during startup is not guaranteed.
    const official = settings.describe().find(descriptor => descriptor.ns === OFFICIAL_NS)
    if (official === undefined) {
      return {
        ...base,
        kind: 'error',
        retryable: true,
        warnings: [`未找到官方设置条目 ${OFFICIAL_NS}：请确认 dsh-tool-subagent 的 model-selection-settings 已加载`],
      }
    }
    const currentRoutes = dedupeRoutes(official.value?.allowedModels ?? [])
    const officialEnabled = official.value?.enabled === true
    const warnings = []

    const { catalog, failed, unregistered } = await readCatalog(state.providers)
    if (unregistered.length > 0) {
      warnings.push(`提供商 ${unregistered.map(id => `"${id}"`).join('、')} 当前未注册，本次跳过；请检查拼写或先在 DSH 里启用该提供商`)
    }

    const step = computeSyncStep({
      current: currentRoutes,
      shadow: state.managedRoutes,
      selected: state.providers,
      catalog,
      failed,
      exclude: state.excludeModels,
    })

    if (step.retainedUnknown.length > 0) {
      warnings.push(`目录读取失败，以下插件管理的条目按原样保留：${step.retainedUnknown.map(routeLabel).join('、')}`)
    }
    if (step.next.length === 0 && currentRoutes.length > 0) {
      warnings.push('名单将变为空：官方设置 enabled=true 时，空名单会让新会话的子代理模型选择退化为仅父路由（官方实现会拒绝空名单）。建议在官方设置里关掉 enabled，或保留至少一条路由')
    }
    if (!officialEnabled) {
      warnings.push('官方 subagent 模型选择当前是关闭状态（enabled=false）：名单已同步，但新会话不会应用它；请在 DSH 设置里开启后新会话才生效')
    }

    if (step.unchanged) {
      return {
        ...base,
        kind: 'unchanged',
        officialEnabled,
        nextCount: currentRoutes.length,
        retainedUnknown: step.retainedUnknown,
        warnings: dedupeStrings(warnings),
      }
    }

    // Write the official allowlist first (the user-visible goal), then the
    // shadow. Only volatile fields are touched — never the official `enabled`.
    const finalStep = await writeOfficial(settings, state, step, official.revision, warnings)

    // Shadow update failure is logged, not fatal: a stale shadow only makes a
    // future withdrawal more conservative (fewer removals, never wrong ones).
    if (!sameRouteLists(state.managedRoutes, finalStep.nextShadow)) {
      try {
        await settings.update(OWN_NS, { managedRoutes: finalStep.nextShadow })
      } catch (error) {
        if (isSettingsConflict(error)) {
          log.warn('dshx-subagent-model-sync: managedRoutes write hit a settings conflict; the shadow lags one sync behind')
        } else {
          log.warn('dshx-subagent-model-sync: managedRoutes write failed; the shadow lags one sync behind')
          log.warn(error)
        }
      }
    }

    if (finalStep.added.length > 0) {
      log.info('dshx-subagent-model-sync: added %s to the subagent allowlist',
        finalStep.added.map(routeLabel).join(', '))
    }
    if (finalStep.removed.length > 0) {
      log.info('dshx-subagent-model-sync: withdrew %s (plugin-managed only)',
        finalStep.removed.map(routeLabel).join(', '))
    }
    log.info('dshx-subagent-model-sync: allowlist synced (%s); applies to sessions created from now on', reason)

    return {
      ...base,
      kind: 'synced',
      officialEnabled,
      nextCount: finalStep.next.length,
      managedCount: finalStep.nextShadow.length,
      added: finalStep.added,
      removed: finalStep.removed,
      retainedUnknown: finalStep.retainedUnknown,
      warnings: dedupeStrings(warnings),
    }
  }

  /**
   * Write the official allowlist with one conflict retry. A retry re-reads
   * the live catalog (awaiting it properly) and recomputes the step from the
   * concurrently-changed list, so a retry can never mistake "we could not
   * read the catalog" for "the catalog is empty".
   * @returns the step actually written.
   */
  const writeOfficial = async (settings, state, step, revision, warnings) => {
    let currentStep = step
    let currentRevision = revision
    for (let attempt = 0; ; attempt++) {
      try {
        await settings.update(OFFICIAL_NS, { allowedModels: currentStep.next }, currentRevision)
        return currentStep
      } catch (error) {
        if (!isSettingsConflict(error) || attempt >= 1) throw error
        log.warn('dshx-subagent-model-sync: official allowlist write hit a settings conflict; retrying once with a fresh revision')
        const fresh = settings.describe().find(descriptor => descriptor.ns === OFFICIAL_NS)
        if (fresh === undefined) throw error
        const freshRoutes = dedupeRoutes(fresh.value?.allowedModels ?? [])
        const { catalog, failed } = await readCatalog(state.providers)
        currentStep = computeSyncStep({
          current: freshRoutes,
          shadow: state.managedRoutes,
          selected: state.providers,
          catalog,
          failed,
          exclude: state.excludeModels,
        })
        currentRevision = fresh.revision
        warnings.push('同步期间名单被并发修改，已按最新名单重算')
      }
    }
  }

  /** Debounced event entry point. */
  const schedule = (reason) => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (disposed) return
      void syncOnce(reason).then(report => {
        if (report.kind === 'error') log.warn('dshx-subagent-model-sync: sync failed: %s', report.warnings[0] ?? 'unknown error')
      })
    }, debounceMs)
  }

  const dispose = () => {
    disposed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return { schedule, syncOnce, dispose }
}

/**
 * Render a sync report for the command result.
 * @param {object} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = []
  if (report.kind === 'disabled') {
    lines.push('dshx-subagent-model-sync 未启用。')
    lines.push('在 DSH 设置 → dshx-subagent-model-sync 里打开 enabled 并选择 providers（如 openai）。')
    return lines.join('\n')
  }
  if (report.kind === 'error') {
    lines.push('同步失败：')
    lines.push(...(report.warnings ?? ['未知错误']))
    return lines.join('\n')
  }
  if (report.kind === 'unchanged') {
    lines.push(`名单已是最新（共 ${report.nextCount} 条，触发：${report.reason}），无需写入。`)
  } else {
    const added = report.added.map(routeLabel)
    const removed = report.removed.map(routeLabel)
    lines.push(`已写入官方白名单（触发：${report.reason}）：`)
    lines.push(added.length > 0 ? `新增 ${added.length} 条：${added.join('、')}` : '本次无新增')
    lines.push(removed.length > 0 ? `撤销 ${removed.length} 条（仅插件管理的条目）：${removed.join('、')}` : '本次无撤销')
    lines.push(`名单现共 ${report.nextCount} 条，其中插件自动管理 ${report.managedCount} 条，其余为手工条目。`)
  }
  if (report.providers.length === 0) {
    lines.push('当前未选择任何提供商：插件只撤掉自己管理的条目，手工条目保持原样。')
  }
  for (const warning of report.warnings ?? []) lines.push(`注意：${warning}`)
  lines.push('生效时机：本名单只对之后新建的会话生效；已有会话沿用创建时的名单，请新建对话验证。')
  return lines.join('\n')
}
