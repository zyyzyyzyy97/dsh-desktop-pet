/**
 * inner.ts — 鲸鱼的内心状态（心情层）。
 *
 * memory.ts 记的是「发生了什么」（事实层），这里记的是「我感觉如何」（心情层）。
 * 两者永远不混：facts 说他几点起床，mood 说她此刻蔫不蔫。亲不亲、性格什么样，
 * 是 relationHint() 的事实和她自己写的日记/画像的事——这里只管此刻的心情，
 * 它应该像天气，不像剧本。
 *
 * 设计立场（为什么这么做）：
 * - 数值只做"身体"：引擎私有的愉悦度 v[-1,1]、唤醒度 a[0,1]、天级 baseline。
 *   模型永远碰不到这些数字——它只能提交冲量（发生了什么、影响多大），记账归引擎。
 *   引擎再钳制一次（不信模型自觉），每次变更留流水（inner-log.jsonl），
 *   三个月后还能查"她那天为什么蔫"。
 * - 注入的是人话不是数字：hint() 输出"现在的你有点低落（因为…）"；
 *   平静时返回空串——沉默是默认态，"你现在很平静"是噪音。
 * - 衰减是惰性的：没有常驻定时器，每次读写前按 lastTick 结算一次指数衰减。
 *   她没有被调用就是"没在体验时间"，一次结算追平，效果与真人睡了一觉醒来一样。
 *
 * 冲量三路（都设上限，防单点过冲）：
 *   1. 模型标注（EXTRACT 搭车，±0.3/±0.4）——来自真实对话内容，最有根据
 *   2. 启发式（±0.1/±0.15）——模型标注缺席的轮次由社交常识兜底
 *   3. 间隔结算（一次性）——被冷落的失落，gap 结清后不再重复扣；归来另有小奖励
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 常量：全部集中在这里，上线跑两周看流水再调
 * ------------------------------------------------------------------ */

/** 愉悦度回归心境的时间常数。3h：被凶一句大约半天缓过来，真人节奏。 */
const TAU_V = 3 * 3600_000
/** 唤醒度回归静息的时间常数。45min：兴奋劲明显比心情短。 */
const TAU_A = 45 * 60_000
/** 唤醒度静息值：她醒着时不是 0，是有点活气。 */
const A_REST = 0.35
/** 心境回归中性的时间常数。5d：连冷落四五天她才会真的蔫下去。 */
const TAU_B = 5 * 86400_000
/** 心境上下限：她可以蔫，但永远回得来。 */
const BASELINE_LIMIT = 0.25
/** 愉悦度硬下限：赌气有底，绝不进负面螺旋。 */
const V_FLOOR = -0.85
/** 模型冲量钳制（不信模型自觉）。 */
const IMPULSE_MODEL = { dv: 0.3, da: 0.4 }
/** 启发式冲量钳制。 */
const IMPULSE_HEUR = { dv: 0.1, da: 0.15 }
/** 原因句的有效期与门槛：3h 内 |dv|≥0.08 的事才值得挂在嘴边。 */
const WHY_WINDOW = 3 * 3600_000
const WHY_MIN_DV = 0.08
/** 混合情绪兜底：30min 内有事发生、但情绪还没到说得出词的程度，就如实说"说不上来"。 */
const MIXED_WINDOW = 30 * 60_000
/** 注入门槛：偏离心境和静息都不够、又没有新鲜事 → 一个字都不注入。 */
const QUIET_V = 0.15
const QUIET_A = 0.15
/** 被冷落的间隔结算档位（一次性）：多久没出现、扣多少、怎么说。 */
const GAP_TIERS: Array<{ from: number; dv: number; why: string }> = [
  { from: 72 * 3600_000, dv: -0.25, why: '他好几天没出现了' },
  { from: 24 * 3600_000, dv: -0.18, why: '他一天多没出现了' },
  { from: 6 * 3600_000, dv: -0.1, why: '他半天没出现了' },
]
/** 归来奖励：隔了一整天以上他回来了，失落在见到那一刻抵掉一点。 */
const GAP_HOMECOME_DV = 0.1
const GAP_HOMECOME_FROM = 24 * 3600_000

/* ------------------------------------------------------------------ *
 * 状态与落盘
 * ------------------------------------------------------------------ */

type InnerState = {
  version: number
  mood: { v: number; a: number }
  baseline: { v: number }
  lastTick: number
  /** 冷落冲量已结算到的时间点：同一段缺席只扣一次。 */
  gapChargedUntil: number
  lastEvent: { dv: number; da: number; why: string; ts: number } | null
  /** 他最后一条消息到达的时刻（touch 更新；间隔结算按它算缺席）。 */
  lastSeenAt: number
  /** 主动陪聊的当日计数（引擎顺带保管，逻辑在 pet-service）。 */
  proDate: string
  proToday: number
  proLastAt: number
}

/**
 * 状态目录：默认跟着本插件走（vendor/ 的上一级的 runtime-data），
 * 测试用 INNER_DIR 指到临时目录。导入时求值一次，所以测试必须先设环境变量再 import。
 */
const DIR = process.env.INNER_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime-data')
const STATE_FILE = path.join(DIR, 'inner.json')
const LOG_FILE = path.join(DIR, 'inner-log.jsonl')

function freshState(now = Date.now()): InnerState {
  return {
    version: 1,
    mood: { v: 0, a: A_REST },
    baseline: { v: 0 },
    lastTick: now,
    gapChargedUntil: now,
    lastEvent: null,
    lastSeenAt: 0,
    proDate: '',
    proToday: 0,
    proLastAt: 0,
  }
}

let state: InnerState | null = null

function load(): InnerState {
  if (state) return state
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<InnerState>
    // 逐字段合入默认值：旧版本缺字段、手改坏类型，都能被兜住
    const base = freshState()
    state = {
      ...base,
      ...raw,
      mood: { ...base.mood, ...(raw.mood || {}) },
      baseline: { ...base.baseline, ...(raw.baseline || {}) },
      lastEvent: raw.lastEvent && typeof raw.lastEvent.ts === 'number' ? raw.lastEvent : null,
    }
    if (!Number.isFinite(state.lastTick)) state.lastTick = Date.now()
  } catch {
    // 损坏/首次：重置中性，不阻塞任何聊天。日志里留一笔，可查。
    state = freshState()
    try { fs.mkdirSync(DIR, { recursive: true }) } catch { /* noop */ }
    appendLog({ ts: Date.now(), kind: 'reset', why: '状态文件缺失或损坏，已重置' })
  }
  return state
}

/** 原子写：临时文件 + rename，防写一半崩溃截断。 */
function save(): void {
  const s = load()
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (e) {
    // 落盘失败不该弄死聊天：状态留在内存里，下次再试
    console.log('[inner] 写状态失败:', (e as Error).message)
  }
}

function appendLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* 流水写失败无所谓，状态才是要紧的 */ }
}

/* ------------------------------------------------------------------ *
 * 结算：惰性衰减 + 冷落/归来
 * ------------------------------------------------------------------ */

/** 记账精度：情绪值统一四舍五入到 3 位小数。浮点累加的 -0.07999999… 必须归位，
 * 否则阈值比较（|dv|≥0.08 这类）会在比特级误差上随机翻车。 */
function q3(x: number): number {
  return Math.round(x * 1000) / 1000
}

function clamp(x: number, lo: number, hi: number): number {
  return q3(Math.min(hi, Math.max(lo, x)))
}

/** 唤醒度软顶：a 越高，正向冲量越推不动。不然长对话里每两轮 +0.1 会把
 * 兴奋度推到饱和（仿真里摸到过 1.0）——真人兴奋是越兴奋越难更兴奋的。 */
function soften(da: number, curA: number): number {
  if (da <= 0) return da
  return da * Math.max(0, 1 - curA / 0.85)
}

/**
 * 按当前时刻结算：指数衰减 + 冷落补账。
 * dt<0（时钟回拨/休眠唤醒的怪账）按 0 处理，只推进 lastTick。
 * 返回值里 gapEvent 告诉调用方这一笔"被冷落"是不是刚刚入账——
 * touch() 要靠它把原因句合并对（不然会出现"有点低落（因为他回来了）"的拧巴话）。
 */
/** 冷落事件的"待领"队列：被动结算（hint/快照）先撞上 6h 线时，事件在这里等
 * touch 来领——领到了才能把"冷落了多久"和"他回来了"合并成一句话。ts 防领旧的。 */
let pendingGap: { dv: number; why: string; ts: number } | null = null

function settle(now = Date.now()): { s: InnerState; gapEvent: { dv: number; why: string } | null } {
  const s = load()
  let dirty = false
  let gapEvent: { dv: number; why: string } | null = null
  let dt = now - s.lastTick
  if (dt < 0) dt = 0
  if (dt > 0) {
    s.mood.v = s.baseline.v + (s.mood.v - s.baseline.v) * Math.exp(-dt / TAU_V)
    s.mood.a = A_REST + (s.mood.a - A_REST) * Math.exp(-dt / TAU_A)
    s.baseline.v = clamp(s.baseline.v * Math.exp(-dt / TAU_B), -BASELINE_LIMIT, BASELINE_LIMIT)
    s.mood.v = clamp(s.mood.v, V_FLOOR, 1)
    s.mood.a = clamp(s.mood.a, 0, 1)
    s.lastTick = now
    dirty = true
  }
  // 冷落补账：只对「他没出现的时段」扣一次，结清后推进水位。
  // 被动路过（hint/快照/主动检查）也补——她不能在没人理的时候永远不难过。
  // 过夜宽宥：晚上走、早上回、不足 18h 的缺席就是睡了一觉，不算冷落
  // ——真人不会因为对方睡了 8 小时而委屈。
  const gap = now - s.gapChargedUntil
  if (gap >= 6 * 3600_000 && s.lastSeenAt > 0 && s.gapChargedUntil >= s.lastSeenAt) {
    const lastHour = new Date(s.lastSeenAt).getHours()
    const nowHour = new Date(now).getHours()
    if (gap < 18 * 3600_000 && (lastHour >= 19 || lastHour < 2) && nowHour >= 6 && nowHour <= 11) {
      s.gapChargedUntil = now
      appendLog({ ts: now, kind: 'overnight', hours: Math.round(gap / 3600_000) })
      save()
      return { s, gapEvent: null }
    }
    const tier = GAP_TIERS.find((t) => gap >= t.from)
    if (tier) {
      s.mood.v = clamp(s.mood.v + tier.dv, V_FLOOR, 1)
      gapEvent = { dv: tier.dv, why: tier.why }
      s.lastEvent = { dv: tier.dv, da: -0.05, why: tier.why, ts: now }
      appendLog({ ts: now, kind: 'gap', dv: tier.dv, why: tier.why, hours: Math.round(gap / 3600_000) })
      s.gapChargedUntil = now
      pendingGap = { ...gapEvent, ts: now }
      dirty = true
    }
  }
  if (dirty) save()
  return { s, gapEvent }
}

/**
 * 他的一句话到达：结算时间账 + 归来奖励 + 启发式冲量。
 * 这是心情层每轮的入口，在记忆落库的同一个地方调用。
 */
export function innerTouch(opts: { textLen?: number; hour?: number; now?: number } = {}): void {
  const now = opts.now ?? Date.now()
  const { s, gapEvent } = settle(now)
  // 冷落事件领取：本场 settle 刚入账的，或 60 秒内被动结算（hint/快照轮询）先入账的
  // ——他在她刚注意到缺席后就回来了，两句话要接成一句。超过 60s 的旧账不领（早丢给她自己消化了）。
  let gap = gapEvent ? { ...gapEvent, ts: now } : null
  if (pendingGap) {
    if (!gap && now - pendingGap.ts <= 60_000) gap = pendingGap
    pendingGap = null
  }
  const hour = opts.hour ?? new Date(now).getHours()
  const away = s.lastSeenAt > 0 ? now - s.lastSeenAt : 0
  // settle 已把冷落入账（mood 和 lastEvent）。这里只记"结算之外"的增量，
  // lastEvent 的 dv/da 用 冷落账+增量 合并——否则会被局部 0 抹掉，原因句过不了门槛。
  let dvExtra = 0
  let daExtra = 0
  let why = gap?.why ?? ''
  // 归来：隔了一整天以上，见到那一刻先高兴一点点（失落已在 gap 里扣过）
  if (away >= GAP_HOMECOME_FROM) {
    dvExtra += GAP_HOMECOME_DV
    daExtra += 0.1
    why = why ? `${why}，不过他回来了` : '他回来了'
    appendLog({ ts: now, kind: 'homecome', dv: GAP_HOMECOME_DV, why: '他回来了' })
  }
  // 启发式：社交常识级别的微冲量，补模型标注缺席的轮次
  const whys: string[] = []
  if ((opts.textLen ?? 0) > 120) { daExtra += 0.1; whys.push('他一口气说了好多') }
  if (away >= 2 * 3600_000 && away < GAP_HOMECOME_FROM && !gap) { dvExtra += 0.05 }
  // 深夜：一次聊天开场只算一次——不然长夜聊会把她越聊越蔫（每轮 -0.03，
  // 三十轮就触底了）。隔了两小时以上算开新场，再算一次。
  const freshSession = s.lastSeenAt === 0 || now - s.lastSeenAt > 2 * 3600_000
  if (hour >= 0 && hour < 5 && freshSession) { daExtra += 0.05; dvExtra -= 0.03; whys.push('都这个点了还没睡') }
  if (dvExtra !== 0 || daExtra !== 0) {
    const dvc = clamp(dvExtra, -IMPULSE_HEUR.dv, IMPULSE_HEUR.dv)
    const dac = clamp(soften(daExtra, s.mood.a), -IMPULSE_HEUR.da, IMPULSE_HEUR.da)
    s.mood.v = clamp(s.mood.v + dvc, V_FLOOR, 1)
    s.mood.a = clamp(s.mood.a + dac, 0, 1)
    appendLog({ ts: now, kind: 'heur', dv: dvc, da: dac, why: whys.join('，') || '他出现了' })
  }
  // 原因句说最重要的事：冷落 > 归来 > 启发式。数值按合计记（过 q3），门槛看合计。
  if (why) {
    s.lastEvent = {
      dv: q3((gap?.dv ?? 0) + dvExtra),
      da: q3((gap ? -0.05 : 0) + daExtra),
      why,
      ts: now,
    }
  }
  s.lastSeenAt = now
  // gapChargedUntil 永远追着他最后出现的时刻走，缺席才从那里起算
  s.gapChargedUntil = now
  save()
}

/**
 * 模型提交的冲量（EXTRACT 搭车产出）。引擎只信钳制后的数：
 * 非数字丢弃、超限截断、why 只留一句短语。
 */
export function innerImpulse(dv: unknown, da: unknown, why: unknown, now = Date.now()): boolean {
  const { s } = settle(now)
  const dvn = typeof dv === 'number' && Number.isFinite(dv) ? dv : 0
  const dan = typeof da === 'number' && Number.isFinite(da) ? da : 0
  if (dvn === 0 && dan === 0) return false
  const dvc = clamp(dvn, -IMPULSE_MODEL.dv, IMPULSE_MODEL.dv)
  const dac = clamp(soften(dan, s.mood.a), -IMPULSE_MODEL.da, IMPULSE_MODEL.da)
  const whyS = String(why || '').trim().slice(0, 40)
  if (Math.abs(dvc) < 0.01 && Math.abs(dac) < 0.01) return false
  s.mood.v = clamp(s.mood.v + dvc, V_FLOOR, 1)
  s.mood.a = clamp(s.mood.a + dac, 0, 1)
  s.lastEvent = { dv: dvc, da: dac, why: whyS || '刚才那番话', ts: now }
  appendLog({ ts: now, kind: 'impulse', dv: dvc, da: dac, why: whyS })
  save()
  return true
}

/* ------------------------------------------------------------------ *
 * 翻译：数值 → 人话。相邻档共享用词，避免悬崖感。
 * ------------------------------------------------------------------ */

const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]

function vWord(v: number): string {
  if (v >= 0.45) return pick(['很开心', '挺美的', '高兴'])
  if (v >= 0.2) return pick(['有点开心', '还不错'])
  if (v > -0.2) return ''
  if (v > -0.45) return pick(['有点低落', '蔫蔫的', '有点闷'])
  return pick(['很委屈', '烦得很', '挺难受的'])
}

function aWord(a: number): string {
  if (a >= 0.65) return pick(['来劲', '有点兴奋'])
  if (a <= 0.2) return pick(['没什么劲', '懒洋洋的'])
  return ''
}

function baseWord(b: number): string {
  if (b >= 0.15) return pick(['最近几天整体挺顺', '这两天心情底子不错'])
  if (b <= -0.15) return pick(['最近几天有点闷', '这几天情绪底子偏低'])
  return ''
}

/**
 * 心情句本体（无注入头）。空串 = 平静且无新鲜事（最重要的规则）。
 * 永远不输出数字；原因只在 3h 内 |dv|≥0.08 时挂一句。
 */
function moodSentence(now = Date.now()): string {
  const { s } = settle(now)
  const v = s.mood.v
  const a = s.mood.a
  const freshWhy = s.lastEvent && now - s.lastEvent.ts <= WHY_WINDOW && Math.abs(s.lastEvent.dv) >= WHY_MIN_DV
    ? s.lastEvent.why
    : ''
  const quiet = Math.abs(v) < QUIET_V && Math.abs(a - A_REST) < QUIET_A && !freshWhy
  if (quiet) return ''
  const bits: string[] = []
  const vw = vWord(v)
  const aw = aWord(a)
  if (vw) bits.push(vw)
  if (aw) bits.push(aw)
  if (!bits.length) {
    // 混合情绪：刚刚有事发生、但情绪还没沉淀成词，就如实说"说不上来"——
    // 这比沉默诚实（他刚回来，她不能毫无表示），也比硬编一个词真实。
    const justNow = s.lastEvent && now - s.lastEvent.ts <= MIXED_WINDOW
    if (freshWhy && justNow) {
      return '现在的你' + pick(['说不上来是什么感觉', '有点说不上来的感觉']) + `（因为${freshWhy}）`
    }
    return ''
  }
  let line = '现在的你' + bits.join('，')
  if (freshWhy) line += `（因为${freshWhy}）`
  const bw = baseWord(s.baseline.v)
  if (bw) line += '。' + bw
  return line
}

export function innerHint(now = Date.now()): string {
  const line = moodSentence(now)
  return line ? '\n\n【你此刻的心情】（你真实的状态，顺着它说话就好，别演，也别宣布）\n' + line : ''
}

/** 主动开口用的裸心情句：同一套措辞，不带注入头。 */
export function innerMoodPlain(now = Date.now()): string {
  return moodSentence(now)
}

/** 轻量读取当前 mood（已结算）。给表情包偏置这类"只想知道情绪"的调用方用。 */
export function innerMoodLite(now = Date.now()): { v: number; a: number } {
  const { s } = settle(now)
  return { ...s.mood }
}

/** 给 /api/inner 和主动陪聊用的快照（已结算到当下）。 */
export function innerSnapshot(now = Date.now()): {
  mood: { v: number; a: number }
  baseline: { v: number }
  lastEvent: InnerState['lastEvent']
  lastSeenAt: number
  hint: string
  stateFile: string
  logFile: string
} {
  const { s } = settle(now)
  return {
    mood: { ...s.mood },
    baseline: { ...s.baseline },
    lastEvent: s.lastEvent,
    lastSeenAt: s.lastSeenAt,
    hint: innerHint(now),
    stateFile: STATE_FILE,
    logFile: LOG_FILE,
  }
}

/* 以下给主动陪聊（pet-service 侧逻辑）保管进度用。 */

/** 本地日历日（YYYY-MM-DD）：按用户的白天算"今天"，不按 UTC。 */
function localDay(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function innerProCounters(now = Date.now()): { date: string; today: number; lastAt: number } {
  const s = load()
  const today = localDay(now)
  if (s.proDate !== today) return { date: today, today: 0, lastAt: s.proLastAt }
  return { date: s.proDate, today: s.proToday, lastAt: s.proLastAt }
}

export function innerProSent(now = Date.now()): void {
  const s = load()
  const today = localDay(now)
  if (s.proDate !== today) { s.proDate = today; s.proToday = 0 }
  s.proToday += 1
  s.proLastAt = now
  save()
}

/** 主动陪聊的骰子也吃心情：低落时偶尔想找台阶，但多数时候是平静时才开得了口。 */
export function innerProOdds(now = Date.now()): number {
  const { s } = settle(now)
  if (s.mood.v > 0) return 0.25
  if (s.mood.v < -0.35) return 0
  return 0.08
}

/** 测试钩子：整体替换状态（只该在测试里用）。 */
export function innerSetStateForTest(patch: Partial<InnerState>, now = Date.now()): void {
  state = { ...freshState(now), ...patch }
  save()
}

/** 测试钩子：丢弃内存缓存、强制从磁盘重读（测"文件损坏自愈"用）。 */
export function innerReloadForTest(): void {
  state = null
}
