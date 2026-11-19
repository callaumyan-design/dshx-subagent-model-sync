// Uninstall dshx-subagent-model-sync from the desktop profile.
// Run only while DSH is NOT running.
//
//   node uninstall-profile.mjs            # remove plugin, keep its entries
//   node uninstall-profile.mjs --dry-run  # show what would change
//
// The official subagent allowlist is NOT touched by default: entries this
// plugin wrote stay in the official list as ordinary (now manual) entries.
// To remove them cleanly, FIRST run /subagent-model-sync with an empty
// provider list (or disable `enabled`) while the plugin is still active,
// THEN uninstall.
//
// What it changes (backups first, BOM-safe, all validated after write):
//   <profile>/package.json                 dependencies[NAME] removed,
//                                          dsh.profile.bundles loses NAME
//   <profile>/cordis.patch.yml             removes the whole NAME entry
//                                          (including any config DSH stored)
//   <profile>/node_modules/<NAME>/         deleted

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const NAME = 'dshx-subagent-model-sync'
const here = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')
const dry = process.argv.includes('--dry-run')
const log = (...a) => console.log(dry ? '[dry-run]' : '', ...a)

let running = ''
try { running = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8' }) } catch { console.warn('cannot run tasklist (sandbox?) — make sure DSH is closed') }
if (/DeepSeek Harness\.exe/i.test(running)) {
  console.error('DSH is running — quit it first (tray → 退出).')
  if (!dry) process.exit(2)
}

const d = new Date()
const p2 = (n) => String(n).padStart(2, '0')
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
const pkgPath = path.join(PROFILE, 'package.json')
const patchPath = path.join(PROFILE, 'cordis.patch.yml')
const hasBom = (p) => { const b = fs.readFileSync(p); return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf }
for (const p of [pkgPath, patchPath]) if (hasBom(p)) throw new Error('BOM already present before uninstall: ' + p)

for (const p of [pkgPath, patchPath]) {
  const to = `${p}.bak-uninstall-subagent-model-sync-${stamp}`
  log('backup', path.basename(p), '->', path.basename(to))
  if (!dry) fs.copyFileSync(p, to)
}

// package.json: drop dependency + bundle row.
const text = fs.readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(text)
delete pkg.dependencies[NAME]
const bundles = pkg.dsh.profile.bundles
const at = bundles.indexOf(NAME)
if (at !== -1) bundles.splice(at, 1)
const nextText = JSON.stringify(pkg, null, 2) + '\n'
log('package.json: remove dependency + bundle', NAME)
if (!dry && nextText !== text) fs.writeFileSync(pkgPath, nextText)

// cordis.patch.yml: remove the whole `- id: NAME` block (top-level YAML list
// item, including nested config lines) via a line scan, keeping comments and
// every other entry byte-identical.
const yaml = createRequire(pkgPath)('js-yaml')
const patchText = fs.readFileSync(patchPath, 'utf8')
const lines = patchText.split('\n')
const out = []
let skipping = false
let removed = 0
for (const line of lines) {
  if (/^- (?:id|insert):(?=$|\s)/.test(line)) {
    if (line === `- id: ${NAME}`) { skipping = true; removed += 1; continue }
    skipping = false
  }
  if (skipping) { removed += 1; continue }
  out.push(line)
}
if (removed === 0) {
  log('cordis.patch.yml: no entry found (nothing to remove)')
} else {
  const nextPatch = out.join('\n')
  const after = yaml.load(nextPatch)
  if (after !== null && after.some((e) => e && e.id === NAME)) throw new Error('entry still parses as present; aborting')
  log(`cordis.patch.yml: removed entry block (${removed} lines)`)
  if (!dry) fs.writeFileSync(patchPath, nextPatch)
}

// node_modules copy.
const target = path.join(PROFILE, 'node_modules', NAME)
if (fs.existsSync(target)) {
  log('rm -r', target)
  if (!dry) fs.rmSync(target, { recursive: true, force: true })
} else log('node_modules: no copy present')

if (!dry) {
  for (const p of [pkgPath, patchPath]) if (hasBom(p)) fs.writeFileSync(p, fs.readFileSync(p).subarray(3))
  JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  yaml.load(fs.readFileSync(patchPath, 'utf8'))
}
console.log(dry ? 'dry run done' : 'uninstalled — start DSH')
console.log('官方 subagent 白名单里由本插件写入的条目仍保留（现为普通手工条目）。')
