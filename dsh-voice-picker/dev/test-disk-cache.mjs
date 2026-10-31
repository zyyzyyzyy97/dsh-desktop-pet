// 开发期一次性验证：真实 API 走一遍「合成→落盘→磁盘命中」，本轮只花 1 次配额。
// 只读运行中的 pet 配置（GET），音频写进插件 cache/ 目录（我们自己的新文件）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', 'dsh-voice-picker')
const base = 'http://127.0.0.1:18796'
const body = { voice: 'Moon', text: '今天天气怎么样？要不要出去转转？' }

const t0 = Date.now()
const r1 = await fetch(base + '/api/preview', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const b1 = Buffer.from(await r1.arrayBuffer())
console.log('[1] 首次:', r1.status, `${b1.length}B`, `${Date.now() - t0}ms`, 'RIFF?', b1.slice(0, 4).toString('ascii') === 'RIFF')

const cacheDir = path.join(root, 'cache')
const files = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []
console.log('[2] cache/ 文件数:', files.length, files.map((f) => f + `(${fs.statSync(path.join(cacheDir, f)).size}B)`).join(', '))

const t1 = Date.now()
const r2 = await fetch(base + '/api/preview', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const b2 = Buffer.from(await r2.arrayBuffer())
console.log('[3] 二次:', r2.status, `${b2.length}B`, `${Date.now() - t1}ms`, '相同?', b1.equals(b2))
console.log(b2.length === b1.length && Date.now() - t1 < 500 ? '[OK] 磁盘缓存生效（亚 500ms 且内容一致）' : '[WARN] 请看服务端日志确认命中路径')
