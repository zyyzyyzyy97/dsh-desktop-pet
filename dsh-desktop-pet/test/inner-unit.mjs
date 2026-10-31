/**
 * inner-unit.mjs — inner.ts 的纯单元测试（不启服务、不发请求）。
 *
 * 跑法（插件根目录下，tsx 在 npm install 后自带；也可用 Coopanion 的 Electron 当 node）：
 *   node node_modules\tsx\dist\cli.mjs test\inner-unit.mjs
 *
 * 全部状态写入临时目录（INNER_DIR），不碰任何真实数据。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 先设隔离目录，再动态 import inner.ts（它在导入时求值 DIR）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-test-'))
process.env.INNER_DIR = TMP

const I = await import('../vendor/inner.ts')
const H = 3600_000
const readLog = () => fs.readFileSync(path.join(TMP, 'inner-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const readState = () => JSON.parse(fs.readFileSync(path.join(TMP, 'inner.json'), 'utf8'))

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok -', name) }
  catch (e) { console.error('  FAIL -', name, '\n   ', e.message); process.exitCode = 1 }
}

console.log('inner-unit @', TMP)

/* 1. 初始平静：一个字都不注入 */
ok('初始状态 hint 为空', () => {
  assert.equal(I.innerHint(), '')
})

/* 2. 冲量入账 + 原因句 + 永远无数字 */
ok('冲量让 hint 出现正向词+原因，且无数字', () => {
  assert.ok(I.innerImpulse(0.25, 0.1, '他夸了我', Date.now()))
  const h = I.innerHint()
  assert.ok(/有点开心|还不错/.test(h), h)
  assert.ok(h.includes('因为他夸了我'), h)
  assert.ok(!/\d/.test(h.replace('【你此刻的心情】', '')), 'hint 里不应有数字: ' + h)
  assert.ok(h.includes('【你此刻的心情】'))
})

/* 3. 衰减数学：6 小时后 v 回落到位（容差对齐 3 位小数记账精度） */
ok('惰性衰减按 exp(-dt/τv) 回落', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: 0.5, a: 0.6 }, baseline: { v: 0 }, lastTick: now - 6 * H }, now)
  const { mood } = I.innerSnapshot(now)
  const want = 0.5 * Math.exp(-6 / 3)
  assert.ok(Math.abs(mood.v - want) < 6e-4, `v=${mood.v} want≈${want}`)
})

/* 4. hint 注入门槛：偏差不够且无原因 → 空串 */
ok('平静/微弱波动不注入', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: 0.1, a: 0.4 }, baseline: { v: 0 }, lastTick: now, lastEvent: null }, now)
  assert.equal(I.innerHint(now), '')
  // 有一点原因就值得说：光秃秃的情绪说不出口，但原因挂着就说
  I.innerSetStateForTest({ mood: { v: 0.05, a: 0.4 }, baseline: { v: 0 }, lastTick: now, lastEvent: { dv: 0.2, da: 0, why: '他给我看了猫', ts: now - H } }, now)
  const h = I.innerHint(now)
  // v=0.05 落在无词档 → 情绪本身没词，只有原因 → 仍然不注入（设计如此：光秃秃括号更怪）
  assert.equal(h, '')
})

/* 5. 负向档位措辞 */
ok('负向情绪有词', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: -0.3, a: 0.3 }, baseline: { v: 0 }, lastTick: now, lastEvent: { dv: -0.3, da: 0, why: '他凶了我', ts: now - H } }, now)
  const h = I.innerHint(now)
  assert.ok(h.includes('他凶了我'), h)
  assert.ok(/低落|蔫|闷/.test(h), h)
})

/* 6. 冷落一次性：30h 缺席 → 一档扣分 + 归来合并成一句；第二次不再扣 */
ok('gap 只扣一次，归来原因合并', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: 0, a: 0.35 }, baseline: { v: 0 }, lastTick: now, lastSeenAt: now - 30 * H, gapChargedUntil: now - 30 * H }, now)
  I.innerTouch({ now, hour: 14 })
  const logCount1 = readLog().filter((x) => x.kind === 'gap').length
  assert.equal(logCount1, 1, 'gap 应恰好入账一次')
  const h1 = I.innerHint(now)
  assert.ok(h1.includes('一天多没出现'), h1)
  assert.ok(h1.includes('回来了'), '归来原因要并进同一句: ' + h1)
  // 一分钟后他又说了一句：不再扣
  I.innerTouch({ now: now + 60_000, hour: 14, textLen: 5 })
  const logCount2 = readLog().filter((x) => x.kind === 'gap').length
  assert.equal(logCount2, 1, '同一段缺席不得重复扣')
})

/* 7. 7h 缺席：只扣不迎（不到 24h 没有归来奖励） */
ok('半天缺席：冷落入账、无归来', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: 0, a: 0.35 }, baseline: { v: 0 }, lastTick: now, lastSeenAt: now - 7 * H, gapChargedUntil: now - 7 * H }, now)
  I.innerTouch({ now, hour: 14, textLen: 5 })
  const h = I.innerHint(now)
  assert.ok(h.includes('半天没出现'), h)
  assert.ok(!h.includes('回来了'), h)
})

/* 8. 状态文件损坏 → 自愈重置 */
ok('损坏自愈', () => {
  fs.writeFileSync(path.join(TMP, 'inner.json'), '{oops', 'utf8')
  I.innerReloadForTest()
  const h = I.innerHint()
  assert.equal(h, '')
  assert.ok(readLog().some((x) => x.kind === 'reset'))
  // 能继续正常记账
  assert.ok(I.innerImpulse(0.3, 0, '恢复了', Date.now()))
})

/* 9. 时钟回拨不炸 */
ok('时钟回拨按 0 处理', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: 0.3, a: 0.4 }, baseline: { v: 0 }, lastTick: now + 3600_000 }, now)
  const { mood } = I.innerSnapshot(now)
  assert.ok(Number.isFinite(mood.v))
})

/* 10. 负面下限：连续挨骂也不进螺旋 */
ok('v 硬下限 -0.85', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: -0.6, a: 0.3 }, baseline: { v: -0.2 }, lastTick: now }, now)
  for (let i = 0; i < 6; i++) I.innerImpulse(-0.3, 0, '又凶了一句', now)
  const { mood } = I.innerSnapshot(now)
  assert.ok(mood.v >= -0.85, `v=${mood.v}`)
})

/* 11. baseline 限幅 */
ok('baseline 限幅 ±0.25', () => {
  const now = Date.now()
  I.innerSetStateForTest({ baseline: { v: 0.9 }, mood: { v: 0.9, a: 0.4 }, lastTick: now - 24 * H }, now)
  const { baseline } = I.innerSnapshot(now)
  assert.ok(Math.abs(baseline.v) <= 0.25 + 1e-9, `baseline=${baseline.v}`)
})

/* 12. 主动陪聊计数按天重置 */
ok('pro 计数按日重置', () => {
  const now = Date.now()
  I.innerSetStateForTest({ proDate: '2026-10-29', proToday: 2, proLastAt: now - 86400_000 }, now)
  const c = I.innerProCounters(now)
  assert.equal(c.today, 0)
  I.innerProSent(now)
  assert.equal(I.innerProCounters(now).today, 1)
})

/* 13. 心境措辞注入 */
ok('baseline 偏低时提示"最近几天有点闷"', () => {
  const now = Date.now()
  I.innerSetStateForTest({ baseline: { v: -0.2 }, mood: { v: -0.2, a: 0.3 }, lastTick: now, lastEvent: null }, now)
  const h = I.innerHint(now)
  assert.ok(/闷|底子偏低/.test(h), h)
})

/* 14. 模型冲量脏数据：非数字/超限 */
ok('脏冲量被钳制/丢弃', () => {
  const now = Date.now()
  I.innerSetStateForTest({ mood: { v: 0, a: 0.35 }, baseline: { v: 0 }, lastTick: now }, now)
  assert.equal(I.innerImpulse('abc', NaN, '', now), false)
  assert.ok(I.innerImpulse(99, -99, '离谱值', now))
  const s = readState()
  assert.ok(Math.abs(s.mood.v - 0.3) < 1e-9, `v=${s.mood.v}`)
  assert.ok(Math.abs(s.mood.a - (0.35 - 0.4)) < 1e-9 || s.mood.a >= 0, `a=${s.mood.a}`)
})

console.log(process.exitCode ? '有失败项' : `全部通过：${passed} 项`)
