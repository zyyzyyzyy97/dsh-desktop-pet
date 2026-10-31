#!/usr/bin/env node
/**
 * 抓 WS 上双向的消息，定位「点麦克风后到底卡在哪」。
 *
 *   node test/trace-ws.mjs [pet 端口]
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

const PET_PORT = Number(process.argv[2] || 18765)
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9400 + Math.floor(Math.random() * 300)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=' + os.tmpdir() + '/edge-trace-' + Date.now(),
  '--window-size=560,460',
  'about:blank',
], { stdio: 'ignore' })

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p?.webSocketDebuggerUrl) return p
    } catch { /* 还没起 */ }
    await sleep(300)
  }
  throw new Error('CDP 没起来')
}

const page = await target()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
    if (!/AudioContext was not allowed/.test(t)) logs.push(`[${m.params.type}] ${t}`)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    logs.push('[异常] ' + (d?.text || '') + ' ' + (d?.exception?.description || ''))
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => {
  const n = ++id
  return new Promise((res) => { pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
}
await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')

// 在页面任何脚本之前植入 WS 记录器
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
  (() => {
    window.__wslog = [];
    const Native = window.WebSocket;
    function Rec(url, proto) {
      const s = proto === undefined ? new Native(url) : new Native(url, proto);
      window.__wslog.push({ dir: 'open?', url: String(url) });
      s.addEventListener('open', () => window.__wslog.push({ dir: 'open', url: String(url) }));
      s.addEventListener('close', (e) => window.__wslog.push({ dir: 'close', code: e.code, url: String(url) }));
      s.addEventListener('error', () => window.__wslog.push({ dir: 'error', url: String(url) }));
      s.addEventListener('message', (e) => {
        if (typeof e.data === 'string') window.__wslog.push({ dir: 'recv', data: e.data.slice(0, 200) });
        else window.__wslog.push({ dir: 'recv-bin', size: e.data.byteLength || 0 });
      });
      const origSend = s.send.bind(s);
      s.send = (d) => {
        if (typeof d === 'string') window.__wslog.push({ dir: 'sent', data: d.slice(0, 200) });
        else window.__wslog.push({ dir: 'sent-bin', size: d.byteLength || 0 });
        return origSend(d);
      };
      return s;
    }
    Rec.prototype = Native.prototype;
    Rec.CONNECTING = Native.CONNECTING;
    Rec.OPEN = Native.OPEN;
    Rec.CLOSING = Native.CLOSING;
    Rec.CLOSED = Native.CLOSED;
    window.WebSocket = Rec;
  })();
  `,
})

await send('Page.navigate', { url: `http://127.0.0.1:${PET_PORT}/pet` })
// 等页面真的加载完（首次 tsx 编译 + 鲸鱼骨架都慢），最多 25 秒
let ready = false
for (let i = 0; i < 50; i++) {
  await sleep(500)
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ rs: document.readyState, url: location.href, hasBubble: !!document.getElementById('bubble'), hasVoice: !!document.querySelector('[data-action="voice"]'), ws: (window.__wslog||[]).length })`,
    returnByValue: true,
  })
  try {
    const s = JSON.parse(r.result.value)
    if (s.rs === 'complete' && s.hasVoice && s.ws > 0) { ready = true; console.log('页面就绪:', r.result.value); break }
  } catch { /* 还在跳转 */ }
}
if (!ready) {
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ rs: document.readyState, url: location.href, body: document.body ? document.body.innerHTML.slice(0,200) : null })`,
    returnByValue: true,
  })
  console.log('页面没就绪:', r.result.value)
}

console.log('— 连接与首包 —')
const init = await send('Runtime.evaluate', {
  expression: `JSON.stringify((window.__wslog||[]).slice(0,6))`,
  returnByValue: true,
})
console.log(' ', init.result.value)

// 点麦克风
await send('Runtime.evaluate', {
  expression: `(() => {
    const b = document.querySelector('[data-action="voice"]');
    if (!b) return 'no-button';
    const r = b.getBoundingClientRect();
    const o = { button: 0, bubbles: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
    b.dispatchEvent(new PointerEvent('pointerdown', o));
    b.dispatchEvent(new PointerEvent('pointerup', o));
    return 'clicked';
  })()`,
  returnByValue: true,
}).then((r) => console.log('— 点击 —\n ', r.result.value))
await sleep(3000)

console.log('— 点击后 WS 消息（最后 12 条）—')
const tail = await send('Runtime.evaluate', {
  expression: `JSON.stringify((window.__wslog||[]).slice(-12), null, 1)`,
  returnByValue: true,
})
console.log(tail.result.value)

console.log('— 页面内部状态 —')
const st = await send('Runtime.evaluate', {
  expression: `(() => {
    const f = document.querySelector('.b-mic');
    const b = document.querySelector('[data-action="voice"]');
    return JSON.stringify({
      bubble: document.getElementById('bubble')?.hidden,
      flagHidden: f?.hidden, flagCls: f?.className, flagText: f?.querySelector('.b-mic-t')?.textContent,
      btn: b?.className,
    });
  })()`,
  returnByValue: true,
})
console.log(' ', st.result.value)

if (logs.length) {
  console.log('— console —')
  for (const l of logs.slice(-12)) console.log(' ', l)
}

ws.close()
edge.kill()
process.exit(0)
