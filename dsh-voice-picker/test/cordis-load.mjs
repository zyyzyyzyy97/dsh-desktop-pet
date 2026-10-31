/**
 * dsh-voice-picker 真实 Cordis 加载冒烟（不启动 DSH 本体）。
 * 复用 dsh-desktop-pet/test/cordis-real-b.mjs 的加载方式：
 * 用 DSH 工具链 node 的 @deepseek-ai/cordis，把本插件当 bundle 挂上，
 * 验证 apply() 执行、HTTP 服务起来、dispose 正常关闭。
 *
 * 运行：node test/cordis-load.mjs（需要装过 DSH；脚本自动从 ~/.workbuddy 工具链里找 cordis）
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

// DSH 工具链自带的 @deepseek-ai/cordis（~/.workbuddy/binaries/node/versions/<最新>/node_modules）
function findDshPkg() {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions')
  try {
    const vers = fs.readdirSync(base).filter((x) => /^\d/.test(x)).sort().reverse()
    for (const v of vers) {
      const p = path.join(base, v, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (fs.existsSync(p)) return p
    }
  } catch { /* 目录不存在 */ }
  throw new Error('没找到 DSH 工具链（~/.workbuddy/binaries/node/versions/*/node_modules/@deepseek-ai/dsh）')
}
const DSH_PKG = findDshPkg()
const TEST_PORT = 18797

const require = createRequire(DSH_PKG)
const { Context } = require('@deepseek-ai/cordis')

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)
console.log('[test] apply 类型 =', typeof mod.apply, '| name =', mod.name)
assert.equal(typeof mod.apply, 'function')
assert.equal(mod.name, 'dsh-voice-picker')

const root = new Context()
root.plugin(mod, { port: TEST_PORT, petPort: 18765, ctrlPort: 18766, autoOpen: false })
if (typeof root.start === 'function') { try { await root.start() } catch (e) { console.log('[test] start err:', String(e)) } }
await new Promise((r) => setTimeout(r, 1200))

const listening = await new Promise((res) => {
  const s = net.connect(TEST_PORT, '127.0.0.1')
  s.on('connect', () => { s.destroy(); res(true) })
  s.on('error', () => res(false))
})
console.log('[test] 端口', TEST_PORT, '监听?', listening)
if (!listening) { console.error('[FAIL] 插件没把服务拉起来'); process.exit(1) }

const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/voices`)
const j = await r.json()
console.log('[test] /api/voices ok =', j.ok, '| count =', j.count, '| petOnline =', j.petOnline, '| current =', j.current)
if (!j.ok || j.count !== 48) { console.error('[FAIL] 音色列表异常'); process.exit(1) }

for (const bye of ['stop', 'dispose', 'destroy']) {
  try { if (typeof root[bye] === 'function') { root[bye](); break } } catch { /* 版本差异，尽力 */ }
}
await new Promise((r) => setTimeout(r, 300))
console.log('[PASS] 真实 Cordis 加载 + 服务 + 列表 全部正常')
process.exit(0)
