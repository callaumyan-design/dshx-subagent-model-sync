// Component tests for the sync engine (native Node, host services stubbed).
// Run: node --test test/engine.test.mjs
//
// The stubs mirror the verified contracts of dsh-settings (describe/update,
// SETTINGS_CONFLICT) and dsh-llm (listProviders/listModels) from
// @deepseek-ai/dsh 0.2.2-rc.3.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEngine, renderReport, OFFICIAL_NS, OWN_NS } from '../engine.js'

const r = (provider, model) => ({ provider, model })
const keys = routes => routes.map(x => `${x.provider}/${x.model}`)

function makeConfig(values) {
  const box = { enabled: false, providers: [], excludeModels: [], managedRoutes: [], ...values }
  return {
    __box: box,
    enabled: { get: () => box.enabled },
    providers: { get: () => box.providers },
    excludeModels: { get: () => box.excludeModels },
    managedRoutes: { get: () => box.managedRoutes },
  }
}

function makeCtx({
  catalog = {},
  registered = undefined,
  officialValue = { enabled: true, allowedModels: [] },
  ownValue = { managedRoutes: [] },
  officialMissing = false,
  conflictOnce = undefined,
} = {}) {
  const updates = []
  const logs = { info: [], warn: [] }
  let revision = 7
  let listModelsCalls = []
  const ctx = {
    logger: {
      info: (...args) => logs.info.push(args),
      warn: (...args) => logs.warn.push(args),
    },
    llm: {
      listProviders: () => (registered ?? Object.keys(catalog)).map(id => ({ id, name: id })),
      listModels: async id => {
        listModelsCalls.push(id)
        const models = catalog[id]
        if (models instanceof Error) throw models
        if (!Array.isArray(models)) throw new Error(`test stub: no catalog for provider "${id}"`)
        return models.map(mid => ({ id: mid, name: mid }))
      },
    },
    settings: {
      describe: () => officialMissing
        ? [{ ns: 'something-else', revision, value: {} }]
        : [
            { ns: OFFICIAL_NS, revision, value: officialValue },
            { ns: OWN_NS, revision: revision + 1, value: ownValue },
          ],
      update: async (ns, patch) => {
        if (ns === OFFICIAL_NS && conflictOnce !== undefined && !conflictOnce.consumed) {
          conflictOnce.consumed = true
          revision += 1
          officialValue = conflictOnce.mutate(officialValue)
          const error = new Error('settings namespace changed since it was read')
          error.code = 'SETTINGS_CONFLICT'
          throw error
        }
        updates.push({ ns, patch })
        if (ns === OFFICIAL_NS) officialValue = { ...officialValue, allowedModels: patch.allowedModels }
        else ownValue = { ...ownValue, managedRoutes: patch.managedRoutes }
      },
    },
  }
  return {
    ctx,
    updates,
    logs,
    listModelsCalls: () => listModelsCalls,
    officialValue: () => officialValue,
    ownValue: () => ownValue,
  }
}

test('sync merges the selected provider catalog and writes both entries', async () => {
  // Mirrors the user's real profile: astra is a manual entry, the plugin
  // selects openai whose catalog offers astra + sol.
  const official = {
    enabled: true,
    allowedModels: [
      r('openai', 'gpt-6.2-astra'),
      r('codex', 'gpt-6.1-sol'),
      r('claude', 'claude-opus-5-5'),
    ],
  }
  const host = makeCtx({
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    officialValue: official,
  })
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config, debounceMs: 0 })

  const report = await engine.syncOnce('test')

  assert.equal(report.kind, 'synced')
  assert.deepEqual(keys(report.added), ['openai/gpt-6.2-sol'])
  assert.deepEqual(report.removed, [])
  assert.deepEqual(report.warnings, [])
  // Official write: allowedModels only, manual entries preserved in order.
  const officialWrite = host.updates.find(u => u.ns === OFFICIAL_NS)
  assert.deepEqual(keys(officialWrite.patch.allowedModels), [
    'openai/gpt-6.2-astra',
    'codex/gpt-6.1-sol',
    'claude/claude-opus-5-5',
    'openai/gpt-6.2-sol',
  ])
  assert.deepEqual(Object.keys(officialWrite.patch), ['allowedModels'])
  // Shadow write: only the entry this plugin added.
  const ownWrite = host.updates.find(u => u.ns === OWN_NS)
  assert.deepEqual(ownWrite.patch.managedRoutes, [r('openai', 'gpt-6.2-sol')])

  // A second pass is a no-op.
  const report2 = await engine.syncOnce('test')
  assert.equal(report2.kind, 'unchanged')
})

test('disabled plugin writes nothing and reads no catalog', async () => {
  const host = makeCtx({ catalog: { openai: ['gpt-6.2-astra'] } })
  const config = makeConfig({ enabled: false, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config })
  const report = await engine.syncOnce('test')
  assert.equal(report.kind, 'disabled')
  assert.deepEqual(host.updates, [])
  assert.deepEqual(host.listModelsCalls(), [])
})

test('missing official entry fails loud without writing', async () => {
  const host = makeCtx({ catalog: { openai: ['gpt-6.2-astra'] }, officialMissing: true })
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config })
  const report = await engine.syncOnce('test')
  assert.equal(report.kind, 'error')
  assert.match(report.warnings[0], /subagent-model-selection-settings/)
  assert.deepEqual(host.updates, [])
  engine.dispose()
})

test('missing official entry at startup retries automatically until it loads', async () => {
  const host = makeCtx({
    catalog: { openai: ['gpt-6.2-astra'] },
    officialValue: { enabled: true, allowedModels: [] },
  })
  const originalDescribe = host.ctx.settings.describe
  let missing = 2
  host.ctx.settings.describe = () => {
    if (missing > 0) {
      missing -= 1
      return [{ ns: 'something-else', revision: 1, value: {} }]
    }
    return originalDescribe()
  }
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config, debounceMs: 5 })

  const first = await engine.syncOnce('load')
  assert.equal(first.kind, 'error')
  assert.equal(first.retryable, true)
  assert.deepEqual(host.updates, [])

  // The engine schedules bounded retries on its own; after the official
  // entry appears the third pass syncs for real.
  await new Promise(resolve => setTimeout(resolve, 200))
  const officialWrites = host.updates.filter(u => u.ns === OFFICIAL_NS)
  assert.equal(officialWrites.length, 1)
  assert.deepEqual(officialWrites[0].patch.allowedModels, [r('openai', 'gpt-6.2-astra')])
  engine.dispose()

  // After dispose no further retries fire.
  const before = host.updates.length
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(host.updates.length, before)
})

test('a failing catalog read keeps the provider\'s entries and warns', async () => {
  const host = makeCtx({
    catalog: { openai: new Error('catalog temporarily unavailable') },
    officialValue: {
      enabled: true,
      allowedModels: [r('openai', 'gpt-6.2-sol'), r('claude', 'claude-opus-5-5')],
    },
  })
  const config = makeConfig({
    enabled: true,
    providers: ['openai'],
    managedRoutes: [r('openai', 'gpt-6.2-sol')],
  })
  const engine = createEngine({ ctx: host.ctx, config })
  const report = await engine.syncOnce('test')

  // Nothing is withdrawn and nothing is written: a failed read is not an
  // empty catalog.
  assert.equal(report.kind, 'unchanged')
  assert.deepEqual(keys(report.retainedUnknown), ['openai/gpt-6.2-sol'])
  assert.match(report.warnings.join('\n'), /gpt-6.2-sol/)
  assert.deepEqual(host.updates, [])
  assert.ok(host.logs.warn.length > 0)
})

test('an unregistered provider is reported, not fatal', async () => {
  const host = makeCtx({
    catalog: { openai: ['gpt-6.2-astra'] },
    registered: ['openai'],
    officialValue: { enabled: true, allowedModels: [] },
  })
  const config = makeConfig({ enabled: true, providers: ['openai', 'ghost'] })
  const engine = createEngine({ ctx: host.ctx, config })
  const report = await engine.syncOnce('test')
  assert.equal(report.kind, 'synced')
  assert.deepEqual(keys(report.added), ['openai/gpt-6.2-astra'])
  assert.match(report.warnings.join('\n'), /"ghost" 当前未注册/)
  assert.deepEqual(host.listModelsCalls(), ['openai'])
})

test('a settings conflict is retried once against the fresh list', async () => {
  const host = makeCtx({
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    officialValue: { enabled: true, allowedModels: [] },
    conflictOnce: {
      consumed: false,
      // A concurrent editor removes a manual entry between read and write.
      mutate: value => ({ ...value, allowedModels: [r('claude', 'claude-opus-5-5')] }),
    },
  })
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config })
  const report = await engine.syncOnce('test')

  assert.equal(report.kind, 'synced')
  // The retried write contains the concurrent editor's entry plus the sync.
  const officialWrite = host.updates.find(u => u.ns === OFFICIAL_NS)
  assert.deepEqual(keys(officialWrite.patch.allowedModels), [
    'claude/claude-opus-5-5',
    'openai/gpt-6.2-astra',
    'openai/gpt-6.2-sol',
  ])
  assert.match(report.warnings.join('\n'), /并发修改/)
})

test('official enabled=false still writes the list and warns about effect', async () => {
  const host = makeCtx({
    catalog: { openai: ['gpt-6.2-astra'] },
    officialValue: { enabled: false, allowedModels: [] },
  })
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config })
  const report = await engine.syncOnce('test')
  assert.equal(report.kind, 'synced')
  assert.deepEqual(keys(report.added), ['openai/gpt-6.2-astra'])
  assert.match(report.warnings.join('\n'), /enabled=false/)
  // The official enabled flag is never part of the patch.
  const officialWrite = host.updates.find(u => u.ns === OFFICIAL_NS)
  assert.deepEqual(Object.keys(officialWrite.patch), ['allowedModels'])
})

test('writing an empty list warns about the official empty-list rejection', async () => {
  const host = makeCtx({
    catalog: {},
    officialValue: { enabled: true, allowedModels: [r('openai', 'gpt-6.2-sol')] },
  })
  const config = makeConfig({
    enabled: true,
    providers: [],
    managedRoutes: [r('openai', 'gpt-6.2-sol')],
  })
  const engine = createEngine({ ctx: host.ctx, config })
  const report = await engine.syncOnce('test')
  assert.equal(report.kind, 'synced')
  assert.deepEqual(keys(report.removed), ['openai/gpt-6.2-sol'])
  assert.deepEqual(report.nextCount, 0)
  assert.match(report.warnings.join('\n'), /名单将变为空/)
})

test('concurrent syncOnce calls share one in-flight pass', async () => {
  const host = makeCtx({
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    officialValue: { enabled: true, allowedModels: [] },
  })
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config })

  const [a, b] = await Promise.all([engine.syncOnce('one'), engine.syncOnce('two')])
  assert.equal(a, b)
  assert.equal(host.updates.filter(u => u.ns === OFFICIAL_NS).length, 1)
})

test('dispose cancels the pending debounce', async () => {
  const host = makeCtx({ catalog: { openai: ['x'] }, officialValue: { enabled: true, allowedModels: [] } })
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config })
  engine.schedule('event')
  engine.dispose()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(host.updates, [])
})

test('schedule runs the debounced sync', async () => {
  const host = makeCtx({
    catalog: { openai: ['gpt-6.2-astra'] },
    officialValue: { enabled: true, allowedModels: [] },
  })
  const config = makeConfig({ enabled: true, providers: ['openai'] })
  const engine = createEngine({ ctx: host.ctx, config, debounceMs: 5 })
  engine.schedule('event')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(host.updates.filter(u => u.ns === OFFICIAL_NS).length, 1)
  engine.dispose()
})

test('renderReport states the effect window explicitly', () => {
  const synced = renderReport({
    kind: 'synced',
    reason: 'command',
    providers: ['openai'],
    added: [r('openai', 'gpt-6.2-sol')],
    removed: [],
    retainedUnknown: [],
    warnings: [],
    nextCount: 4,
    managedCount: 1,
  })
  assert.match(synced, /新增 1 条：openai\/gpt-6.2-sol/)
  assert.match(synced, /生效时机：本名单只对之后新建的会话生效/)

  const unchanged = renderReport({
    kind: 'unchanged', reason: 'load', providers: ['openai'], added: [], removed: [], retainedUnknown: [], warnings: [],
    nextCount: 3,
  })
  assert.match(unchanged, /名单已是最新（共 3 条/)

  const disabled = renderReport({
    kind: 'disabled', reason: 'load', providers: [], added: [], removed: [], retainedUnknown: [], warnings: [],
  })
  assert.match(disabled, /未启用/)

  const error = renderReport({
    kind: 'error', reason: 'load', providers: [], added: [], removed: [], retainedUnknown: [],
    warnings: ['未找到官方设置条目 subagent-model-selection-settings'],
  })
  assert.match(error, /同步失败/)
  assert.match(error, /subagent-model-selection-settings/)
})
