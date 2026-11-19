// Unit tests for the pure merge logic (native Node, no host imports).
// Run: node --test test/sync-core.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import { computeSyncStep, dedupeRoutes, routeKey } from '../sync-core.js'

const r = (provider, model) => ({ provider, model })
const keys = routes => routes.map(routeKey)

test('first sync keeps manual entries and appends catalog models', () => {
  // The user's current manual list already contains openai/gpt-6.2-astra.
  const current = [
    r('openai', 'gpt-6.2-astra'),
    r('codex', 'gpt-6.1-sol'),
    r('claude', 'claude-opus-5-5'),
  ]
  const step = computeSyncStep({
    current,
    shadow: [],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    failed: [],
    exclude: [],
  })
  // Only gpt-6.2-sol is new; astra was already there manually.
  assert.deepEqual(step.added, [r('openai', 'gpt-6.2-sol')])
  assert.deepEqual(step.removed, [])
  // Order: manual entries first, then appended catalog routes.
  assert.deepEqual(keys(step.next), keys([
    r('openai', 'gpt-6.2-astra'),
    r('codex', 'gpt-6.1-sol'),
    r('claude', 'claude-opus-5-5'),
    r('openai', 'gpt-6.2-sol'),
  ]))
  // The shadow records only what this plugin wrote — never the manual astra.
  assert.deepEqual(step.nextShadow, [r('openai', 'gpt-6.2-sol')])
  assert.equal(step.unchanged, false)
})

test('a manual entry overlapping the catalog never becomes managed', () => {
  // First sync adds sol only; astra stays manual.
  const step = computeSyncStep({
    current: [r('openai', 'gpt-6.2-astra')],
    shadow: [],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    failed: [],
    exclude: [],
  })
  assert.deepEqual(step.nextShadow, [r('openai', 'gpt-6.2-sol')])

  // Later astra is disabled in the provider catalog. The plugin-managed sol
  // is withdrawn only if it also leaves; the manual astra must survive.
  const step2 = computeSyncStep({
    current: [r('openai', 'gpt-6.2-astra'), r('openai', 'gpt-6.2-sol')],
    shadow: step.nextShadow,
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra'] },
    failed: [],
    exclude: [],
  })
  assert.deepEqual(step2.removed, [r('openai', 'gpt-6.2-sol')])
  assert.deepEqual(step2.next, [r('openai', 'gpt-6.2-astra')])
  assert.deepEqual(step2.nextShadow, [])
})

test('model leaving the catalog withdraws only plugin-managed entries', () => {
  const step = computeSyncStep({
    current: [r('openai', 'gpt-6.2-astra'), r('openai', 'gpt-6.2-sol'), r('claude', 'claude-opus-5-5')],
    shadow: [r('openai', 'gpt-6.2-sol')],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra'] },
    failed: [],
    exclude: [],
  })
  assert.deepEqual(step.removed, [r('openai', 'gpt-6.2-sol')])
  assert.deepEqual(step.next, [r('openai', 'gpt-6.2-astra'), r('claude', 'claude-opus-5-5')])
  assert.deepEqual(step.nextShadow, [])
})

test('deselecting a provider withdraws only that provider\'s managed entries', () => {
  const step = computeSyncStep({
    current: [
      r('openai', 'gpt-6.2-astra'),
      r('openai', 'gpt-6.2-sol'),
      r('claude', 'claude-opus-5-5'),
    ],
    shadow: [r('openai', 'gpt-6.2-astra'), r('openai', 'gpt-6.2-sol'), r('claude', 'claude-opus-5-5')],
    selected: [],
    catalog: {},
    failed: [],
    exclude: [],
  })
  // Everything the plugin wrote is withdrawn, manual entries kept.
  assert.deepEqual(step.removed, [
    r('openai', 'gpt-6.2-astra'),
    r('openai', 'gpt-6.2-sol'),
    r('claude', 'claude-opus-5-5'),
  ])
  assert.deepEqual(step.next, [])
  assert.deepEqual(step.nextShadow, [])
})

test('a failed catalog read keeps that provider\'s entries untouched', () => {
  const step = computeSyncStep({
    current: [r('openai', 'gpt-6.2-sol'), r('local', 'huihui-qwen3.8-27b-abliterated')],
    shadow: [r('openai', 'gpt-6.2-sol'), r('local', 'huihui-qwen3.8-27b-abliterated')],
    selected: ['openai', 'local'],
    catalog: { local: ['huihui-qwen3.8-27b-abliterated'] },
    failed: ['openai'],
    exclude: [],
  })
  // openai is unknown: its managed entry stays in the list and in the shadow.
  assert.deepEqual(step.next, [r('openai', 'gpt-6.2-sol'), r('local', 'huihui-qwen3.8-27b-abliterated')])
  assert.deepEqual(step.nextShadow, [
    r('openai', 'gpt-6.2-sol'),
    r('local', 'huihui-qwen3.8-27b-abliterated'),
  ])
  assert.deepEqual(step.retainedUnknown, [r('openai', 'gpt-6.2-sol')])
  assert.deepEqual(step.removed, [])
})

test('excluded routes are not desired; managed ones are withdrawn, manual kept', () => {
  const step = computeSyncStep({
    current: [r('openai', 'gpt-6.2-astra'), r('openai', 'gpt-6.2-sol')],
    shadow: [r('openai', 'gpt-6.2-sol')],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    failed: [],
    exclude: [r('openai', 'gpt-6.2-sol')],
  })
  assert.deepEqual(step.removed, [r('openai', 'gpt-6.2-sol')])
  assert.deepEqual(step.next, [r('openai', 'gpt-6.2-astra')])
  assert.deepEqual(step.nextShadow, [])

  // A manual entry the user also excluded stays: exclude only filters the
  // automatic desired set, it never removes manual entries. The non-excluded
  // catalog model still joins normally.
  const step2 = computeSyncStep({
    current: [r('openai', 'gpt-6.2-astra')],
    shadow: [],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    failed: [],
    exclude: [r('openai', 'gpt-6.2-astra')],
  })
  assert.deepEqual(step2.next, [r('openai', 'gpt-6.2-astra'), r('openai', 'gpt-6.2-sol')])
  assert.deepEqual(step2.nextShadow, [r('openai', 'gpt-6.2-sol')])
})

test('repeated sync is idempotent and reports unchanged', () => {
  const input = {
    current: [r('openai', 'gpt-6.2-astra'), r('openai', 'gpt-6.2-sol')],
    shadow: [r('openai', 'gpt-6.2-sol')],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    failed: [],
    exclude: [],
  }
  const first = computeSyncStep(input)
  assert.equal(first.unchanged, true)
  assert.deepEqual(first.added, [])
  assert.deepEqual(first.removed, [])
  assert.deepEqual(first.next, input.current)
  assert.deepEqual(first.nextShadow, input.shadow)
})

test('a manually deleted managed entry is re-added and stays managed', () => {
  const step = computeSyncStep({
    current: [r('openai', 'gpt-6.2-astra')],
    shadow: [r('openai', 'gpt-6.2-sol')],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra', 'gpt-6.2-sol'] },
    failed: [],
    exclude: [],
  })
  assert.deepEqual(step.added, [r('openai', 'gpt-6.2-sol')])
  assert.deepEqual(keys(step.next), keys([r('openai', 'gpt-6.2-astra'), r('openai', 'gpt-6.2-sol')]))
  // No duplicate in the shadow even though sol is both "old managed" and "added".
  assert.deepEqual(step.nextShadow, [r('openai', 'gpt-6.2-sol')])
})

test('malformed and duplicate inputs are normalized defensively', () => {
  const step = computeSyncStep({
    current: [
      r('openai', 'gpt-6.2-astra'),
      r('openai', 'gpt-6.2-astra'), // duplicate
      'garbage', // malformed
      null, // malformed
    ],
    shadow: [undefined, { provider: '', model: 'x' }],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra', 42, ''] },
    failed: [],
    exclude: [],
  })
  assert.deepEqual(step.next, [r('openai', 'gpt-6.2-astra')])
  assert.deepEqual(step.nextShadow, [])
})

test('unselected providers are never auto-added', () => {
  const step = computeSyncStep({
    current: [r('claude', 'claude-opus-5-5')],
    shadow: [],
    selected: ['openai'],
    catalog: { openai: ['gpt-6.2-astra'] },
    failed: [],
    exclude: [],
  })
  // claude is not selected: its models never enter, its entries never leave.
  assert.deepEqual(step.next, [r('claude', 'claude-opus-5-5'), r('openai', 'gpt-6.2-astra')])
})

test('dedupeRoutes preserves first-seen order and drops malformed entries', () => {
  assert.deepEqual(dedupeRoutes([r('a', '1'), 'x', r('a', '1'), r('b', '2')]), [r('a', '1'), r('b', '2')])
  assert.deepEqual(dedupeRoutes([]), [])
  assert.deepEqual(dedupeRoutes([undefined]), [])
})

test('routeKey matches the official modelRouteKey format', () => {
  // The official dsh-tool-subagent modelRouteKey is `${provider}\0${model`;
  // we mirror it exactly, NUL-collision caveat included (ids never contain
  // NUL in practice).
  assert.equal(routeKey(r('openai', 'gpt-6.2-astra')), 'openai\0gpt-6.2-astra')
  assert.equal(routeKey(r('x', 'y')), routeKey(r('x', 'y')))
})
