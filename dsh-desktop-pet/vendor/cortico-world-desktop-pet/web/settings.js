/* Coo 设置页逻辑：全部走同源 /api/*（与 /pet 同一端口，CSP connect-src 'self'） */
const $ = (id) => document.getElementById(id)

function msg(el, text, kind) {
  el.textContent = text || ''
  el.className = 'msg' + (kind ? ' ' + kind : '')
}

async function api(path, body) {
  const opt = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const r = await fetch(path, opt)
  const text = await r.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = { error: text.slice(0, 200) } }
  if (!r.ok) throw new Error(data?.error || ('HTTP ' + r.status))
  return data
}

/* ---------- 载入 ---------- */
async function load() {
  try {
    const c = await api('/api/config')
    $('baseUrl').value = c.baseUrl || ''
    $('apiKey').value = c.apiKey || ''
    $('model').value = c.model || ''
    $('temperature').value = String(c.temperature ?? 0.85)
    $('tv').textContent = String(c.temperature ?? 0.85)
    $('name').value = c.name || 'Coo'
    $('greeting').value = c.greeting || ''
    $('persona').value = c.persona || ''
    $('petHostExe').value = c.petHostExe || ''
    $('autoOpenWindow').checked = !!c.autoOpenWindow
    $('keepAsking').checked = !!c.keepAsking
    $('voiceOut').checked = c.voiceOut !== false
    $('memesOn').checked = c.memes !== false
    $('memoryOn').checked = c.memory !== false
    $('ttsVoice').value = c.ttsVoice || 'Cherry'
    $('keyState').textContent = c.hasKey ? '已配置密钥' : '还没有配置密钥 —— 不填的话鲸鱼没法回你话。'
  } catch (e) {
    $('keyState').textContent = '读取配置失败：' + e.message
  }
}

/* ---------- 模型与密钥 ---------- */
$('temperature').addEventListener('input', () => { $('tv').textContent = $('temperature').value })

$('btnPeek').addEventListener('click', () => {
  const el = $('apiKey')
  const show = el.type === 'password'
  el.type = show ? 'text' : 'password'
  $('btnPeek').textContent = show ? '隐藏' : '显示'
})

$('btnSaveModel').addEventListener('click', async () => {
  const el = $('modelMsg')
  msg(el, '保存中…')
  try {
    await api('/api/config', {
      baseUrl: $('baseUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim(),
      temperature: Number($('temperature').value),
    })
    await load()
    msg(el, '已保存。双击桌面上的鲸鱼就能聊了。', 'ok')
  } catch (e) { msg(el, '保存失败：' + e.message, 'err') }
})

$('btnTest').addEventListener('click', async () => {
  const el = $('modelMsg')
  const btn = $('btnTest')
  btn.disabled = true
  msg(el, '正在请求模型…')
  try {
    // 先把当前表单存下来，测试的就是你眼前这套配置
    await api('/api/config', {
      baseUrl: $('baseUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim(),
      temperature: Number($('temperature').value),
    })
    const r = await api('/api/chat/test', {})
    if (r.ok) msg(el, `连上了（${r.ms}ms）：${r.reply}`, 'ok')
    else msg(el, '连不上：' + r.error, 'err')
  } catch (e) {
    msg(el, '连不上：' + e.message, 'err')
  } finally { btn.disabled = false }
})

$('btnReset').addEventListener('click', async () => {
  const el = $('modelMsg')
  try { await api('/api/chat/reset', {}); msg(el, '聊天记忆已清空。', 'ok') }
  catch (e) { msg(el, '失败：' + e.message, 'err') }
})

/* ---------- 人设 ---------- */
$('btnSavePersona').addEventListener('click', async () => {
  const el = $('personaMsg')
  try {
    await api('/api/config', {
      name: $('name').value.trim() || 'Coo',
      greeting: $('greeting').value.trim(),
      persona: $('persona').value,
    })
    msg(el, '已保存。', 'ok')
  } catch (e) { msg(el, '保存失败：' + e.message, 'err') }
})

/* ---------- 桌宠 ---------- */
$('btnSavePet').addEventListener('click', async () => {
  const el = $('petMsg')
  try {
    await api('/api/config', {
      petHostExe: $('petHostExe').value.trim(),
      autoOpenWindow: $('autoOpenWindow').checked,
      keepAsking: $('keepAsking').checked,
    })
    msg(el, '已保存。点「重开浮窗」让新设置生效。', 'ok')
  } catch (e) { msg(el, '保存失败：' + e.message, 'err') }
})

$('btnReopen').addEventListener('click', async () => {
  const el = $('petMsg')
  msg(el, '正在重开…')
  try {
    await api('/api/config', {
      petHostExe: $('petHostExe').value.trim(),
      autoOpenWindow: $('autoOpenWindow').checked,
      keepAsking: $('keepAsking').checked,
    })
    const r = await api('/api/window/open', {})
    if (r.ok) msg(el, '浮窗已重新打开 —— 看桌面右下角。', 'ok')
    else msg(el, '没能开浮窗：' + (r.reason || '未知原因'), 'err')
  } catch (e) { msg(el, '失败：' + e.message, 'err') }
})

/* ---------- 声音 · 表情 · 记忆 ---------- */
$('btnSaveVoice').addEventListener('click', async () => {
  const el = $('voiceMsg')
  msg(el, '保存中…')
  try {
    await api('/api/config', {
      voiceOut: $('voiceOut').checked,
      memes: $('memesOn').checked,
      memory: $('memoryOn').checked,
      ttsVoice: $('ttsVoice').value.trim() || 'Cherry',
    })
    await load()
    msg(el, '已保存。', 'ok')
  } catch (e) { msg(el, '保存失败：' + e.message, 'err') }
})

$('btnTestVoice').addEventListener('click', async () => {
  const el = $('voiceMsg')
  msg(el, '合成中…')
  try {
    const r = await api('/api/tts', { text: '爸，我在呢。这道题选 B，我看过了。' })
    if (!r.ok) throw new Error('没有合成出声音')
    const a = new Audio(r.url)
    a.play()
    msg(el, `好了，${r.ms}ms。`, 'ok')
  } catch (e) { msg(el, '试听失败：' + e.message, 'err') }
})

$('btnMemoryReveal').addEventListener('click', async () => {
  const box = $('memoryBox')
  const el = $('voiceMsg')
  try {
    const m = await api('/api/memory')
    const lines = []
    lines.push(`共 ${m.turns} 句对话 · ${m.facts} 条事实 · ${m.blocks} 段摘要`)
    lines.push(`从 ${m.sinceText || '今天'} 开始 · 分端：${
      Object.entries(m.channels || {}).map(([k, v]) => `${k === 'qq' ? 'QQ' : '桌面'} ${v}`).join('，') || '—'}`)
    if (m.facts?.length) {
      lines.push('', '── 她记住的事 ──')
      for (const f of m.facts) lines.push(`· ${f.key}：${f.value}`)
    }
    if (m.blocks?.length) {
      lines.push('', '── 更早的印象 ──')
      for (const b of m.blocks) lines.push('· ' + b.text.split('\n').join(' '))
    }
    if (m.recent?.length) {
      lines.push('', '── 最近说过 ──')
      for (const r of m.recent) {
        lines.push(`${r.when} ${r.channel === 'qq' ? '[QQ]' : ''} ${r.role === 'user' ? '你' : 'Coo'}：${r.text}`)
      }
    }
    box.textContent = lines.join('\n')
    box.style.display = 'block'
    msg(el, '', 'ok')
  } catch (e) { msg(el, '读取失败：' + e.message, 'err') }
})

/* ---------- 技能 Skills ---------- */
function renderSkills(data) {
  const box = $('skills-list')
  box.replaceChildren()
  $('skillDir').textContent = '技能目录：' + (data.dir || '—') + (data.items?.length ? `　已装 ${data.items.length} 个` : '')

  for (const s of data.items || []) {
    const d = document.createElement('div')
    d.className = 'skill'
    const body = document.createElement('div')
    body.className = 'body'

    const head = document.createElement('div')
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = s.name
    head.append(name)
    if (s.hasScripts) {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = '带脚本'
      head.append(tag)
    }

    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = s.description || '（没有描述）'

    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = `${s.files} 个文件` + (s.whenToUse ? '　·　' + s.whenToUse : '')

    body.append(head, desc, meta)

    const del = document.createElement('button')
    del.className = 'ghost small'
    del.type = 'button'
    del.textContent = '卸载'
    del.addEventListener('click', async () => {
      if (!confirm(`卸载技能 ${s.name}？\n（会挪到插件目录的 skills-disabled/，没有真删）`)) return
      del.disabled = true
      try {
        const r = await api('/api/skills/remove', { name: s.name })
        renderSkills(r)
        msg($('skillMsg'), `已卸载 ${s.name}。`, 'ok')
      } catch (e) {
        msg($('skillMsg'), '卸载失败：' + e.message, 'err')
        del.disabled = false
      }
    })

    d.append(body, del)
    box.append(d)
  }

  for (const p of data.problems || []) {
    const d = document.createElement('div')
    d.className = 'skill bad'
    const body = document.createElement('div')
    body.className = 'body'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = p.dir.split(/[\\/]/).pop() || p.dir
    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = '这个目录没被识别：' + p.reason
    body.append(name, desc)
    d.append(body)
    box.append(d)
  }

  if (!(data.items || []).length && !(data.problems || []).length) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.style.margin = '0'
    p.textContent = '还没装技能。上面填一个 GitHub 仓库地址就能装。'
    box.append(p)
  }
}

async function loadSkills() {
  try { renderSkills(await api('/api/skills')) } catch { /* 忽略 */ }
}

$('btnSkillInstall').addEventListener('click', async () => {
  const el = $('skillMsg')
  const url = $('skillUrl').value.trim()
  if (!url) { msg(el, '先填一个 GitHub 地址（比如 https://github.com/anthropics/skills）。', 'err'); return }
  const btn = $('btnSkillInstall')
  btn.disabled = true
  msg(el, '正在下载并安装…（一个大仓库可能有十几 MB）')
  try {
    const r = await api('/api/skills/install', { url })
    renderSkills(r)
    const got = [...(r.installed || []), ...(r.updated || [])]
    msg(el, `装好了 ${got.length} 个：${got.join('、')}。DSH 里直接说需求就会用到，不用重启。`, 'ok')
    $('skillUrl').value = ''
  } catch (e) {
    msg(el, '安装失败：' + e.message, 'err')
  } finally { btn.disabled = false }
})

$('btnSkillReveal').addEventListener('click', async () => {
  try { await api('/api/skills/reveal', {}) } catch (e) { msg($('skillMsg'), '打开失败：' + e.message, 'err') }
})

$('btnSkillReload').addEventListener('click', async () => {
  await loadSkills()
  msg($('skillMsg'), '已刷新。', 'ok')
})

/* ---------- 角色包 ---------- */
/** 角色包的 name 可能是 {zh:'Coo', en:'Coo'} 这种本地化对象，取一个能看的字符串。 */
function labelOf(v) {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') return v.zh || v['zh-Hant'] || v.en || Object.values(v)[0] || ''
  return ''
}

function renderFigures(list) {
  const box = $('figures')
  box.replaceChildren()
  for (const f of list) {
    const d = document.createElement('div')
    d.className = 'fig'
    const name = document.createElement('b')
    name.textContent = labelOf(f.name) || f.id
    const id = document.createElement('span')
    id.textContent = f.id
    const tag = document.createElement('span')
    tag.className = 'tag' + (f.id === 'coo' || f.id === 'whale' ? ' builtin' : '')
    tag.textContent = f.id === 'coo' || f.id === 'whale' ? '内置' : '已安装'
    d.append(name, id, tag)
    box.append(d)
  }
  if (!list.length) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = '还没有可用的角色包。'
    box.append(p)
  }
}

async function loadFigures() {
  try { renderFigures(await api('/api/figures')) } catch { /* 忽略 */ }
}

$('btnInstall').addEventListener('click', async () => {
  const el = $('packMsg')
  const url = $('packUrl').value.trim()
  if (!url) { msg(el, '先填一个 GitHub 地址。', 'err'); return }
  const btn = $('btnInstall')
  btn.disabled = true
  msg(el, '正在下载并安装…（大包可能要十几秒）')
  try {
    const r = await api('/api/packs/install', { url })
    msg(el, `装好了：${r.id}。去「换皮肤」里选它。`, 'ok')
    $('packUrl').value = ''
    await loadFigures()
  } catch (e) {
    msg(el, '安装失败：' + e.message, 'err')
  } finally { btn.disabled = false }
})

/* ---------- 其他入口 ---------- */
// 设置与装扮共用 Coopanion 宿主那一个附属窗口：换页用本窗口导航，
// 否则 window.open 只会把已存在的窗口 show() 出来（还停在原页）。
const goPage = (p) => { try { location.assign(p) } catch { location.href = p } }
// 「网页版鲸鱼」要真的交给系统浏览器：换一个 host（127.0.0.1 ↔ localhost）让宿主视为外链
const browserUrl = (p) => {
  const alt = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'
  return `http://${alt}:${location.port}${p}`
}
$('btnDress').addEventListener('click', () => goPage('/dress'))
$('btnDress2').addEventListener('click', () => goPage('/dress'))
$('btnPickFigure').addEventListener('click', () => goPage('/dress'))
$('btnSkills').addEventListener('click', () => {
  const card = $('skills')
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' })
})
$('btnPet').addEventListener('click', () => { try { window.open(browserUrl('/pet'), '_blank') } catch { location.href = browserUrl('/pet') } })

/* ---------- 桌宠菜单翻页：设置 / 装扮 是同一个附属窗口 ---------- */
function followMenu() {
  try {
    const ws = new WebSocket(`ws://${location.host}/socket?role=dress`)
    ws.onmessage = (e) => {
      let m = null
      try { m = JSON.parse(e.data) } catch { return }
      if (m && m.t === 'goto' && typeof m.page === 'string' && location.pathname !== m.page) location.assign(m.page)
    }
    ws.onclose = () => setTimeout(followMenu, 2000)
  } catch { /* 忽略 */ }
}
followMenu()

load()
loadFigures()
loadSkills()
