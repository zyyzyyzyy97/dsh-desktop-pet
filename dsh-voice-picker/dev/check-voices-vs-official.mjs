// 音色数据交叉验证（第 3 次，2026-10-30 06:34 从官方页面重新抓取）：
// 官方 48 个 id 与本地 data/voices.json 完全一致则 PASS。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OFFICIAL = 'Cherry, Serena, Ethan, Chelsie, Momo, Vivian, Moon, Maia, Kai, Nofish, Bella, Jennifer, Ryan, Katerina, Aiden, Eldric Sage, Mia, Mochi, Bellona, Vincent, Bunny, Neil, Elias, Arthur, Nini, Seren, Pip, Stella, Bodega, Sonrisa, Alek, Dolce, Sohee, Ono Anna, Lenn, Emilien, Andre, Radio Gol, Jada, Dylan, Li, Marcus, Roy, Peter, Sunny, Eric, Rocky, Kiki'
  .split(',').map((s) => s.trim()).filter(Boolean)

const here = path.dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'dsh-voice-picker', 'data', 'voices.json'), 'utf8'))
const local = new Set(data.voices.map((v) => v.id))
const official = new Set(OFFICIAL)

const missing = OFFICIAL.filter((id) => !local.has(id))
const extra = [...local].filter((id) => !official.has(id))

console.log('[check] 官方:', official.size, '个 | 本地:', local.size, '个')
if (missing.length) console.log('[FAIL] 本地缺少:', missing.join(', '))
if (extra.length) console.log('[FAIL] 本地多出:', extra.join(', '))
if (!missing.length && !extra.length && official.size === 48 && local.size === 48) {
  console.log('[PASS] 本地 48 音色与官方列表（第 3 次独立抓取）完全一致')
} else {
  process.exit(1)
}
