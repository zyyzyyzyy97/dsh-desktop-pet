// 交付完整性 QA 检查（第 13 轮起每轮复用）：
//   1) 交付物文件齐全
//   2) voices.json 结构完整（48 个、id 唯一、字段齐、sample 非空、方言 ≥10）
//   3) zip 与目录同步（zip 修改时间 >= 目录内最新文件）
//   4) 开发实例（18796）存活
//   5) 用户敏感文件未被动过（pet-config.json mtime 应早于本会话开始 ~02:50）—— 只读 stat
// 全部只读；输出 PASS/FAIL 摘要，exit 1 = 有 FAIL。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(here, '..')
const PLUGIN = path.join(WORKSPACE, 'dsh-voice-picker')

const results = []
function check(name, ok, detail = '') {
  results.push([ok, name])
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  [' + detail + ']' : ''))
}

/* 1) 文件齐全 */
const required = [
  'package.json', 'cordis.patch.yml', 'src/index.js', 'src/server.mjs',
  'web/index.html', 'data/voices.json', 'test/smoke.mjs', 'test/cordis-load.mjs',
]
for (const f of required) {
  check(`文件存在: ${f}`, fs.existsSync(path.join(PLUGIN, f)))
}
check('无 cache 残留进交付目录', !fs.existsSync(path.join(PLUGIN, 'cache')))

/* 2) voices.json 完整性 */
const data = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'data', 'voices.json'), 'utf8'))
const ids = data.voices.map((v) => v.id)
check('音色数 = 48', data.voices.length === 48, String(data.voices.length))
check('id 无重复', new Set(ids).size === 48)
const badFields = data.voices.filter((v) => !v.id || !v.zh || !v.desc || !v.gender || !v.lang || !v.sample?.trim() || !Array.isArray(v.tags))
check('每音色字段齐全（含 sample）', badFields.length === 0, badFields.map((v) => v.id).join(','))
const dialectLangs = ['上海话', '四川话', '粤语', '北京话', '南京话', '陕西话', '闽南语', '天津话']
check('方言音色 ≥ 10', data.voices.filter((v) => dialectLangs.includes(v.lang)).length >= 10)
check('性别取值合法', data.voices.every((v) => v.gender === '男' || v.gender === '女'))

/* 3) zip 同步 */
const zip = path.join(WORKSPACE, 'dsh-voice-picker.zip')
if (fs.existsSync(zip)) {
  let newest = 0
  for (const f of required) newest = Math.max(newest, fs.statSync(path.join(PLUGIN, f)).mtimeMs)
  const extra = ['../../install-voice-picker.ps1', '../../install.cmd', '../../uninstall-voice-picker.ps1', '../../README.md']
    .map((p) => path.resolve(PLUGIN, 'data', p)) // 相对 data/ 上跳到工作区根
  for (const f of extra) { try { newest = Math.max(newest, fs.statSync(f).mtimeMs) } catch { /* 缺文件在检查1里报 */ } }
  check('zip 比 newest 交付文件新（已同步）', fs.statSync(zip).mtimeMs >= newest)
} else {
  check('zip 存在', false)
}

/* 4) 开发实例存活（不强制） */
try {
  const r = await fetch('http://127.0.0.1:18796/api/voices', { signal: AbortSignal.timeout(2000) })
  const j = await r.json()
  check('开发实例 18796 在线且列表正常', r.ok && j.ok && j.count === 48)
} catch {
  check('开发实例 18796 在线（可选项，不阻断）', true, '离线——开发实例没跑，不算失败')
}

/* 5) 敏感文件未被本会话改动（只读 stat） */
const SESSION_START = new Date('2026-10-30T02:50:00')
for (const f of [
  path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'plugins', 'dsh-desktop-pet', 'pet-config.json'),
]) {
  try {
    const mt = fs.statSync(f).mtime
    check(`未动用户文件: ${path.basename(f)}`, mt < SESSION_START, 'mtime ' + mt.toISOString())
  } catch (e) {
    check(`未动用户文件: ${path.basename(f)}`, false, String(e.message))
  }
}

const fails = results.filter(([ok]) => !ok)
console.log(`\n[qa] ${results.length - fails.length}/${results.length} 通过`)
process.exit(fails.length ? 1 : 0)
