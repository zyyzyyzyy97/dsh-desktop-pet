#!/usr/bin/env node
/**
 * 验证本机 SenseVoice 语音识别链路是否可用：
 * 模型文件是否齐全 + SHA256 是否对得上 + sherpa-onnx 能否加载并推理。
 *
 *   node test/verify-speech.mjs
 *
 * 说明：这里用一段合成正弦波做「能不能跑」的冒烟测试，它识别出来是空字符串
 * 属于正常（正弦波不是人声）；报错或进程崩掉才是问题。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA = path.join(DSH_HOME, 'speech-to-text', 'sensevoice')
const MODEL = path.join(DATA, 'models', 'sensevoice-onnx', 'model.int8.onnx')
const TOKENS = path.join(DATA, 'models', 'sensevoice-onnx', 'tokens.txt')
const VAD = path.join(DATA, 'models', 'silero', 'silero_vad.onnx')

/** 与 dsh-experimental-speech-to-text-sensevoice/runtime/assets.json 保持一致 */
const EXPECT = {
  [MODEL]: { bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  [TOKENS]: { bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  [VAD]: { bytes: 1807522, sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28' },
}

const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => console.log('  \u2717 ' + m)
let failed = 0

console.log('\n[1] 模型文件')
for (const [file, want] of Object.entries(EXPECT)) {
  if (!fs.existsSync(file)) { bad(`缺少 ${path.relative(DATA, file)}`); failed++; continue }
  const size = fs.statSync(file).size
  if (size !== want.bytes) { bad(`${path.basename(file)} 大小 ${size} ≠ ${want.bytes}（没下完？）`); failed++; continue }
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (sha !== want.sha256) { bad(`${path.basename(file)} SHA256 不匹配`); failed++; continue }
  ok(`${path.relative(DATA, file)}  ${(size / 1048576).toFixed(1)}MB  sha 对得上`)
}
if (failed) {
  console.log('\n结论：模型不全，DSH 点麦克风只会弹「需要安装」。')
  process.exit(1)
}

console.log('\n[2] sherpa-onnx 运行时')
let sherpa
try {
  const req = createRequire(import.meta.url)
  // DSH 自带，不在本插件依赖里
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions')
  let found = null
  for (const v of fs.readdirSync(base).filter((x) => /^\d/.test(x)).sort().reverse()) {
    const p = path.join(base, v, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sherpa-onnx-node')
    if (fs.existsSync(p)) { found = p; break }
  }
  if (!found) throw new Error('没找到 sherpa-onnx-node（DSH 安装目录变了？）')
  sherpa = req(found)
  ok('sherpa-onnx-node 已加载')
} catch (e) {
  bad(e.message)
  console.log('\n结论：运行时缺失，语音识别起不来。')
  process.exit(1)
}

console.log('\n[3] 加载模型 + 推理')
try {
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: MODEL, language: 'auto', useInverseTextNormalization: 1 },
      tokens: TOKENS,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  })
  ok('模型加载成功')

  // 1 秒 440Hz 正弦波，16k 采样
  const n = 16000
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.3
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  recognizer.decode(stream)
  const r = recognizer.getResult(stream)
  ok(`推理完成，输出 ${JSON.stringify(r.text ?? r)}（正弦波出空串是正常的）`)
} catch (e) {
  bad(`推理失败：${e.message}`)
  failed++
}

console.log(failed ? '\n结论：有问题，见上面 \u2717。' : '\n结论：语音识别链路正常。点输入框的麦克风就能录音了。')
process.exit(failed ? 1 : 0)
