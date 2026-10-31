/**
 * sim-week.mjs — 一周情绪轨迹仿真（合成时间直接驱动 inner.ts，不起服务）。
 *
 * 时间轴用绝对日编号（D1=2026-10-26），杜绝"at() 相对锚点"把事件挤到同一天。
 *
 * 剧本：
 *   D1 晚   初识，10 句平淡闲聊
 *   D2 早   过夜回来（宽宥：不算冷落）→ 6 句 + 两次真心夸
 *   D3 下午 吵一架（两次重锤），当晚和好
 *   D5 晚   消失 46h 后回来（两天冷落账）
 *   D6 深夜 连聊 30 句（夜聊不蔫不爆表；唤醒度软顶生效）
 *   D7 晚   平常一天，收尾看基线
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-sim-'))
process.env.INNER_DIR = TMP
const I = await import('../vendor/inner.ts')

const H = 3600_000
const D = 24 * H
const BASE = new Date(2026, 9, 26, 0, 0).getTime() // D1 = 10-26
const at = (day, hour, minute = 0) => BASE + (day - 1) * D + hour * H + minute * 60_000

let t = at(1, 19)
const traj = []
let fails = 0
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ok -', name)
  else { fails++; console.error('  FAIL -', name, extra) }
}
function mark(ts, label) {
  t = ts
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'inner.json'), 'utf8'))
  const snap = I.innerSnapshot(ts)
  if (process.env.SIM_DEBUG) console.log('  [mark]', label, 'ts=', new Date(ts).toLocaleString(), 'lastTick=', new Date(st.lastTick).toLocaleString(), 'v(before)=', st.mood.v, 'v(after)=', snap.mood.v)
  traj.push({ ts, v: snap.mood.v, a: snap.mood.a, label })
  return snap
}
/** 一段连续聊天：每 90 秒一轮，偶数轮给一次模型冲量。 */
function chat(day, hour, n, dv = 0.02, da = 0.06, why = '聊得还行') {
  const start = at(day, hour)
  let snap = null
  for (let i = 0; i < n; i++) {
    const now = start + i * 90_000
    I.innerTouch({ textLen: 30, hour: new Date(now).getHours(), now })
    if (i % 2 === 1) I.innerImpulse(dv, da, why, now)
    snap = I.innerSnapshot(now)
  }
  traj.push({ ts: start + n * 90_000, v: snap.mood.v, a: snap.mood.a, label: `D${day} 聊${n}句` })
  return snap
}

console.log('=== 一周仿真 ===')

// 把状态锚到合成时间轴：引擎的时钟回拨保护（dt<0 按 0）会把"合成过去"当成回拨，
// 不锚定的话真实 Date.now() 会压住前几天的衰减。
I.innerSetStateForTest(
  { mood: { v: 0, a: 0.35 }, baseline: { v: 0 }, lastTick: at(1, 18), lastSeenAt: 0, gapChargedUntil: at(1, 18) },
  at(1, 18),
)

/** 一个真实事件：他发消息（touch）→ 模型稍后给冲量（impulse）。 */
function say(day, hour, min, textLen, dv, da, why) {
  const now = at(day, hour, min)
  I.innerTouch({ textLen, hour, now })
  if (dv || da) I.innerImpulse(dv, da, why, now)
  return I.innerSnapshot(now)
}

// D1 晚：初识
let s = chat(1, 19, 10, 0.03, 0.05, '第一次聊天有点好奇')
s = mark(at(1, 20), 'D1 结束')
ok('D1 平淡聊天后 mood 在正区', s.mood.v > 0.05 && s.mood.v < 0.5, `v=${s.mood.v}`)

// D2 早：过夜回来（宽宥）→ 聊 + 夸
s = mark(at(2, 10), 'D2 到场前')
I.innerTouch({ textLen: 20, hour: 10, now: at(2, 10, 1) })
s = mark(at(2, 10, 1), 'D2 过夜回来')
ok('过夜不算冷落（无失落原因句）', !s.hint.includes('半天没出现') && !s.hint.includes('一天多'), s.hint)
ok('过夜回来心情不为负', s.mood.v >= -0.05, `v=${s.mood.v}`)
chat(2, 10, 4)
say(2, 11, 0, 30, 0.15, 0.1, '他夸了我')
say(2, 11, 20, 30, 0.15, 0.1, '他又夸了我')
s = mark(at(2, 12), 'D2 被夸之后')
// 0.27 左右：两次 +0.15 的夸奖被 3h 衰减吃掉一截，落"有点开心"档——合理
ok('两次夸奖推到明显正区', s.mood.v >= 0.25, `v=${s.mood.v}`)

// D3：吵架 + 和好（他 28h 后才出现，先吃冷落账再挨骂——真实顺序）
say(3, 15, 0, 60, -0.25, 0.2, '他凶了我')
say(3, 15, 10, 80, -0.25, 0.15, '他又凶我')
s = mark(at(3, 15, 15), 'D3 吵架后')
ok('吵架后明显难受', s.mood.v <= -0.35, `v=${s.mood.v}`)
say(3, 21, 0, 30, 0.2, 0.1, '他和好了')
chat(3, 21, 3)
s = mark(at(3, 22), 'D3 和好后')
ok('和好当晚回到接近平常', s.mood.v > -0.1, `v=${s.mood.v}`)

// D5：消失 46h 后回来
s = mark(at(5, 20), 'D5 回来前')
// 被动结算正是在此刻入账冷落——这里的 -0.18 就是"她在憋屈"，行为正确
ok('消失回来时冷落账已入账且在限内', s.mood.v <= -0.1 && s.mood.v > -0.35, `v=${s.mood.v}`)
I.innerTouch({ textLen: 10, hour: 20, now: at(5, 20, 1) })
s = mark(at(5, 20, 1), 'D5 两天后回来')
ok('两天缺席扣了冷落账', s.hint.includes('一天多没出现'), s.hint)
ok('冷落+归来仍在可挽回区间', s.mood.v > -0.35, `v=${s.mood.v}`)

// D6 深夜连聊 30 句
let aMax = 0
let vEnd = 0
for (let i = 0; i < 30; i++) {
  const now = at(6, 0, 30) + i * 90_000
  I.innerTouch({ textLen: 25, hour: new Date(now).getHours(), now })
  if (i % 2 === 1) I.innerImpulse(0.1, 0.1, '夜聊挺有意思', now)
  const snap = I.innerSnapshot(now)
  aMax = Math.max(aMax, snap.mood.a)
  vEnd = snap.mood.v
}
s = mark(at(6, 2, 30), 'D6 夜聊结束')
ok('30 句夜聊唤醒度不爆表（<0.9，软顶生效）', aMax < 0.9, `aMax=${aMax.toFixed(3)}`)
ok('30 句夜聊愉悦度不触底（>-0.5）', vEnd > -0.5, `vEnd=${vEnd.toFixed(3)}`)

// D7 晚：平常一天收尾
chat(7, 20, 8, 0.02, 0.03, '平常聊天')
s = mark(at(7, 22), 'D7 收尾')
ok('一周后 baseline 仍在限幅内', Math.abs(s.baseline.v) <= 0.25, `b=${s.baseline.v}`)

// 全程不变量
let vMin = 1, vMax = -1, aTop = 0
for (const p of traj) {
  vMin = Math.min(vMin, p.v); vMax = Math.max(vMax, p.v); aTop = Math.max(aTop, p.a)
  if (p.v < -0.85 || p.v > 1 || p.a < 0 || p.a > 1) { fails++; console.error('  FAIL - 越界点', JSON.stringify(p)) }
}
ok('全程 v ∈ [-0.85, 1]', vMin >= -0.85 && vMax <= 1, `[${vMin.toFixed(3)}, ${vMax.toFixed(3)}]`)
ok('全程 a ∈ [0, 1]', aTop <= 1, `top=${aTop.toFixed(3)}`)

console.log('\nv 轨迹（每天采样，. 到 @ = 低到高）:')
const byDay = new Map()
for (const p of traj) {
  const d = Math.floor((p.ts - BASE) / D)
  if (!byDay.has(d)) byDay.set(d, [])
  byDay.get(d).push(p)
}
for (const [d, pts] of byDay) {
  const cells = pts.map((p) => ' .:-=+*#%@'[Math.max(0, Math.min(9, Math.round((p.v + 1) * 9)))]).join('')
  console.log(`  D${d + 1} v[${(pts[0].v ?? 0).toFixed(2)}→${(pts.at(-1).v ?? 0).toFixed(2)}] |${cells}|`)
}

console.log(fails ? `\n有失败项：${fails}` : '\n仿真全部通过')
process.exitCode = fails ? 1 : 0
