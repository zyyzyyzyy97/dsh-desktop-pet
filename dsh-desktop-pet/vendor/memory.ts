/**
 * memory.ts — 鲸鱼的长记忆。
 *
 * 桌面浮窗和 QQ 桥共用这一个库：她在 QQ 里听你说过的事，回到桌面还记得，
 * 反过来也一样。重启也不丢。
 *
 * 三层结构，各管一段：
 *   1. turns   —— 逐句对话原文。用于「刚才聊到哪」+ 关键词翻旧账。
 *   2. facts   —— 抽出来的长期事实（你在准备什么考试、几点起床、讨厌什么）。
 *                 每轮都会被塞进 system prompt，所以她永远记得你是谁。
 *   3. blocks  —— 把久远的一批对话压成一段摘要，省 token 又不忘事。
 *
 * 全部用 Node 自带的 node:sqlite，不引第三方依赖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Role = 'user' | 'assistant'
export type Channel = 'desktop' | 'qq' | 'system'

export type Turn = {
  id: number
  ts: number
  channel: string
  role: Role
  text: string
  imgs: number
}

export type Fact = {
  id: number
  key: string
  value: string
  ts: number
  hits: number
  source: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  channel TEXT    NOT NULL DEFAULT 'desktop',
  role    TEXT    NOT NULL,
  text    TEXT    NOT NULL,
  imgs    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts DESC);
CREATE INDEX IF NOT EXISTS turns_ch ON turns(channel, ts DESC);

CREATE TABLE IF NOT EXISTS facts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  key    TEXT    NOT NULL UNIQUE,
  value  TEXT    NOT NULL,
  ts     INTEGER NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 1,
  source TEXT
);

CREATE TABLE IF NOT EXISTS blocks (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   INTEGER NOT NULL,
  kind TEXT    NOT NULL DEFAULT 'daily',
  text TEXT    NOT NULL,
  upto INTEGER NOT NULL DEFAULT 0
);
`

/** 中文按字切，两字一组；英文按词。够用，且不依赖分词器。 */
function grams(input: string): string[] {
  const s = String(input || '')
  const out = new Set<string>()
  for (const w of s.match(/[A-Za-z0-9_]{2,}/g) || []) out.add(w.toLowerCase())
  const cjk = s.replace(/[^\u3400-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  return [...out].filter((g) => !STOP.has(g)).slice(0, 14)
}

const STOP = new Set([
  '什么', '怎么', '这个', '那个', '就是', '现在', '今天', '我们', '你们', '他们',
  '可以', '一个', '没有', '不是', '还是', '因为', '所以', '但是', '然后', '如果',
  '的时候', '一下', '知道', '觉得', '帮我', '我的', '你的', '他是', '她呢',
])

/** 把时间说成人话：「昨天」「三天前」「10 月 12 号」。 */
export function when(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const n = new Date(now)
  const day = 86400000
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(n) - startOf(d)) / day)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff <= 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  if (diff === 2) return `前天 ${hm}`
  if (diff < 7) return `${diff} 天前`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 号`
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 号`
}

export class Memory {
  private db: DatabaseSync
  readonly file: string
  /** 内存里的快照，避免每轮都查库 */
  private factCache: Fact[] = []
  private factDirty = true

  constructor(file: string) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  /* ---------------- 逐句对话 ---------------- */

  remember(p: { channel?: Channel; role: Role; text: string; imgs?: number }): number {
    const text = String(p.text || '').trim()
    if (!text) return 0
    const r = this.db
      .prepare('INSERT INTO turns (ts, channel, role, text, imgs) VALUES (?,?,?,?,?)')
      .run(Date.now(), p.channel || 'desktop', p.role, text.slice(0, 4000), p.imgs || 0)
    return Number(r.lastInsertRowid)
  }

  recent(limit = 20, channel?: Channel): Turn[] {
    const rows = channel
      ? this.db
          .prepare('SELECT * FROM turns WHERE channel = ? ORDER BY id DESC LIMIT ?')
          .all(channel, limit)
      : this.db.prepare('SELECT * FROM turns ORDER BY id DESC LIMIT ?').all(limit)
    return (rows as unknown as Turn[]).reverse()
  }

  /**
   * 翻旧账：按关键词找很久以前说过的话。
   * 故意跳过最近 8 条——那些已经在上下文里了，重复塞进去只会挤占 token。
   */
  recall(query: string, limit = 6): Turn[] {
    const gs = grams(query)
    if (!gs.length) return []
    const cut = Date.now() - 40 * 60 * 1000
    const like = gs.map(() => 'text LIKE ?').join(' OR ')
    const params: (string | number)[] = gs.map((g) => `%${g}%`)
    let rows: Turn[]
    try {
      rows = this.db
        .prepare(
          `SELECT * FROM turns WHERE (${like}) AND ts < ? ORDER BY ts DESC LIMIT 300`,
        )
        .all(...params, cut) as unknown as Turn[]
    } catch {
      return []
    }
    const scored = rows.map((r) => {
      const t = r.text.toLowerCase()
      let score = 0
      for (const g of gs) if (t.includes(g)) score += g.length
      // 越久以前略微加权：新事本来就在上下文里，旧事才是「翻记忆」的意义
      const ageDays = (Date.now() - r.ts) / 86400000
      score *= 1 + Math.min(1, ageDays / 30) * 0.35
      if (r.role === 'user') score *= 1.2
      return { r, score }
    })
    scored.sort((a, b) => b.score - a.score || b.r.ts - a.r.ts)
    // 同一分钟的连续两句只留一句，免得摘出来半截对话
    const out: Turn[] = []
    for (const s of scored) {
      if (out.some((o) => Math.abs(o.ts - s.r.ts) < 60000)) continue
      out.push(s.r)
      if (out.length >= limit) break
    }
    return out
  }

  /* ---------------- 长期事实 ---------------- */

  get facts(): Fact[] {
    if (this.factDirty) {
      this.factCache = this.db
        .prepare('SELECT * FROM facts ORDER BY hits DESC, ts DESC LIMIT 200')
        .all() as unknown as Fact[]
      this.factDirty = false
    }
    return this.factCache
  }

  setFact(key: string, value: string, source = 'chat'): void {
    const k = String(key || '').trim().slice(0, 60)
    const v = String(value || '').trim().slice(0, 500)
    if (!k || !v) return
    const old = this.db.prepare('SELECT id, value FROM facts WHERE key = ?').get(k) as
      | { id: number; value: string }
      | undefined
    if (old) {
      if (old.value === v) {
        this.db.prepare('UPDATE facts SET hits = hits + 1, ts = ? WHERE id = ?').run(Date.now(), old.id)
      } else {
        // 事实会变（换了目标、搬了城市），覆盖旧值但记一次命中
        this.db
          .prepare('UPDATE facts SET value = ?, ts = ?, hits = hits + 1, source = ? WHERE id = ?')
          .run(v, Date.now(), source, old.id)
      }
    } else {
      this.db
        .prepare('INSERT INTO facts (key, value, ts, source) VALUES (?,?,?,?)')
        .run(k, v, Date.now(), source)
    }
    this.factDirty = true
  }

  forgetFact(id: number): boolean {
    const r = this.db.prepare('DELETE FROM facts WHERE id = ?').run(id)
    this.factDirty = true
    return Number(r.changes) > 0
  }

  /* ---------------- 摘要块 ---------------- */

  addBlock(text: string, kind = 'daily', upto = 0): void {
    const t = String(text || '').trim()
    if (!t) return
    this.db.prepare('INSERT INTO blocks (ts, kind, text, upto) VALUES (?,?,?,?)').run(Date.now(), kind, t, upto)
  }

  blocks(limit = 4): { ts: number; kind: string; text: string }[] {
    return this.db
      .prepare('SELECT ts, kind, text FROM blocks ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as { ts: number; kind: string; text: string }[]
  }

  /** 按类型取（diary / impression / compact / portrait / moment），新的在前。upto 给 portrait 记进度。 */
  byKind(kind: string, limit = 6): { ts: number; kind: string; text: string; upto: number }[] {
    return this.db
      .prepare('SELECT ts, kind, text, upto FROM blocks WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(kind, limit) as unknown as { ts: number; kind: string; text: string; upto: number }[]
  }

  countKind(kind: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM blocks WHERE kind = ?').get(kind) as { c: number }
    return r.c
  }

  /** 最老的那批、还没被浓缩的对话（给摘要用） */
  unsedimented(limit = 60): Turn[] {
    const upto = (this.db.prepare('SELECT MAX(upto) AS u FROM blocks').get() as { u: number | null }).u || 0
    return this.db
      .prepare('SELECT * FROM turns WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(upto, limit) as unknown as Turn[]
  }

  maxTurnId(): number {
    const r = this.db.prepare('SELECT MAX(id) AS m FROM turns').get() as { m: number | null }
    return r.m || 0
  }

  /* ---------------- 给模型看的简报 ---------------- */

  /**
   * 拼一段给她看的记忆。刻意写得像「她想起来的」，不是「数据库导出」——
   * 否则她会回一句「根据记忆库记录」，马上出戏。
   */
  brief(query: string, opts: { facts?: number; recall?: number } = {}): string {
    const parts: string[] = []
    const fs_ = this.facts.slice(0, opts.facts ?? 30)
    if (fs_.length) {
      parts.push(
        '【你记得的事】\n' +
          fs_
            .map((f) => {
              const stale = Date.now() - f.ts > 45 * 86400000
              return `- ${f.key}：${f.value}${stale ? `（${when(f.ts)}提到的）` : ''}`
            })
            .join('\n'),
      )
    }
    // 只取压过的『旧印象』，日记和逐条印象另有专门位置，别在这里重复出现
    const bl = this.byKind('compact', 3)
    if (bl.length) {
      parts.push('【更早以前的印象】\n' + bl.map((b) => `- ${b.text}`).join('\n'))
    }
    // 值得一直记住的时刻（第一次和好这类）。不参与淡忘，也不多给——四条封顶，
    // 时刻的分量来自稀有，列一排就跟打卡记录没两样了。
    const mo = this.byKind('moment', 4)
    if (mo.length) {
      parts.push('【一直记得的时刻】\n' + mo.reverse().map((b) => `- ${b.text}`).join('\n'))
    }
    // 只取「他说过的」，不取她自己以前说过的话。
    // 原因：模型最容易模仿的就是自己旧回复的措辞，把旧语气（傲娇、口头禅）
    // 原样带回来，等于人设根本没换。她在这一阶段的说话方式应该重新长，
    // 但他说过什么、发生过什么，必须记得。
    const past = this.recall(query, opts.recall ?? 5).filter((p) => p.role === 'user')
    if (past.length) {
      parts.push(
        '【他以前说过的事】\n' +
          past
            .map((p) => `- ${when(p.ts)}：${p.text.slice(0, 120)}`)
            .join('\n'),
      )
    }
    if (!parts.length) return ''
    return (
      '\n\n' +
      parts.join('\n\n') +
      '\n\n（上面是你自己记得的事，自然地用，别把它们当资料念出来，' +
      '更别说「根据记忆」「记录显示」。记不清就说不记得，别编。）'
    )
  }

  /** 他的最后一句时刻（时间感用）。0 = 还没说过。 */
  lastUserTs(): number {
    const r = this.db.prepare(`SELECT MAX(ts) AS t FROM turns WHERE role = 'user'`).get() as { t: number | null }
    return r.t || 0
  }

  /** 今天（本地日历日）他说的话数。 */
  userTurnsToday(now = Date.now()): number {
    const d = new Date(now)
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM turns WHERE role = 'user' AND ts >= ?`).get(start) as { c: number }
    return r.c
  }

  /**
   * 近 7 天他的上线时段（消息最多的那桶）。样本 <5 条、或分布太散（<35%）都不下结论
   * ——宁可不说，不说错。
   */
  activeBucket(now = Date.now()): string | null {
    const from = now - 7 * 86400000
    const rows = this.db.prepare(`SELECT ts FROM turns WHERE role = 'user' AND ts >= ?`).all(from) as unknown as { ts: number }[]
    if (rows.length < 5) return null
    const names = ['凌晨', '早上', '上午', '中午', '下午', '晚上', '深夜']
    const idx = (h: number) => (h < 5 ? 0 : h < 9 ? 1 : h < 12 ? 2 : h < 14 ? 3 : h < 18 ? 4 : h < 23 ? 5 : 6)
    const counts = new Array(7).fill(0)
    for (const r of rows) counts[idx(new Date(r.ts).getHours())]++
    const max = Math.max(...counts)
    if (max / rows.length < 0.35) return null
    return names[counts.indexOf(max)]
  }

  stats() {
    const t = this.db.prepare('SELECT COUNT(*) AS c FROM turns').get() as { c: number }
    const f = this.db.prepare('SELECT COUNT(*) AS c FROM facts').get() as { c: number }
    const b = this.db.prepare('SELECT COUNT(*) AS c FROM blocks').get() as { c: number }
    const first = this.db.prepare('SELECT MIN(ts) AS t FROM turns').get() as { t: number | null }
    const byCh = this.db
      .prepare('SELECT channel, COUNT(*) AS c FROM turns GROUP BY channel')
      .all() as unknown as { channel: string; c: number }[]
    return {
      turns: t.c,
      facts: f.c,
      blocks: b.c,
      since: first.t,
      sinceText: first.t ? when(first.t) : null,
      channels: Object.fromEntries(byCh.map((x) => [x.channel, x.c])),
      file: this.file,
      bytes: (() => {
        try { return fs.statSync(this.file).size } catch { return 0 }
      })(),
    }
  }

  close() {
    try { this.db.close() } catch { /* noop */ }
  }
}
