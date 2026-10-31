// 开发实例长时运行后的端到端抽查（第 17 轮，本轮唯一一次真实 API 调用）：
// 试听一条全新短句 → 200 + RIFF → 清掉 cache（保持交付目录干净）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cacheDir = path.resolve(here, '..', 'dsh-voice-picker', 'cache')

const t0 = Date.now()
const r = await fetch('http://127.0.0.1:18796/api/preview', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ voice: 'Cherry', text: '巡查哨兵句，听见我就放心了。' }),
})
const buf = Buffer.from(await r.arrayBuffer())
const ok = r.status === 200 && buf.length > 1000 && buf.slice(0, 4).toString('ascii') === 'RIFF'
console.log(`[patrol] ${ok ? 'OK' : 'FAIL'} HTTP ${r.status} ${buf.length}B ${Date.now() - t0}ms`)
try { fs.rmSync(cacheDir, { recursive: true, force: true }); console.log('[patrol] cache 已清') } catch { /* noop */ }
process.exit(ok ? 0 : 1)
