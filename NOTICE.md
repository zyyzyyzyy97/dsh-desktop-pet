# 第三方组件与许可声明（NOTICE）

本仓库整体按 **AGPL-3.0-or-later** 分发。其中包含/依赖以下第三方组件，在此一并声明：

## vendored 组件（随仓库分发）

| 组件 | 位置 | 许可 | 说明 |
|---|---|---|---|
| cortico-world-desktop-pet | `dsh-desktop-pet/vendor/cortico-world-desktop-pet/` | AGPL-3.0-or-later | Coopanion 本体（渲染层 web/ + PetServer src/ + 浮窗 host/），**原样复制、未修改源码**；其内含独立的 LICENSE 与 THIRD_PARTY_NOTICES.md |
| 鲸鱼美术素材 | `dsh-desktop-pet/vendor/cortico-world-desktop-pet/web/` 等 | **非 AGPL**，**禁止商用** | Coopanion 的贴图/皮肤素材，授权条款见其 THIRD_PARTY_NOTICES.md |
| cortico | `dsh-desktop-pet/vendor/node_modules/cortico/` | MIT | Coopanion 运行时框架。⚠️ 此份为**打过补丁的副本**（把 `src/` 提到包根以支持裸子路径导入 `cortico/core/…`），补丁仅为路径布局调整，未改逻辑 |
| pylibs | `dsh-desktop-pet/vendor/pylibs/` | 各自上游许可（MIT/BSD 等） | edge-tts 7.3.1 及其 Python 依赖（aiohttp 等），供 `tts_edge.py` 兜底 TTS 使用 |

## npm 依赖（`npm install` 安装，不随仓库分发）

| 包 | 许可 |
|---|---|
| ws | MIT |
| tsx | MIT |
| fflate | MIT |
| jpeg-js | BSD-3-Clause |
| opencc-js | MIT AND Apache-2.0 |

## 可选外部依赖（不随仓库分发，需自备）

| 组件 | 许可 | 说明 |
|---|---|---|
| sherpa-onnx-node / sherpa-onnx-win-x64 | Apache-2.0 | 本地 ASR 运行时（可选，见主插件 README「语音识别」节） |
| SenseVoice 模型 / silero-vad | Apache-2.0 / MIT | ASR 模型文件，放 `~/.dsh/speech-to-text/sensevoice/models/` |
| NapCat | MIT | QQ 协议端（OneBot 11），QQ 桥功能需要 |
| qwen3-tts / DashScope | 商用服务 | 语音合成主路径，需自己的 API key；失败自动回退 edge-tts |

## 插件自有代码

`dsh-desktop-pet/src/`、`vendor/pet-service.ts`、`vendor/inner.ts`、`vendor/memory.ts`、
`vendor/qq-bridge.mjs`、`vendor/shot.py`、`vendor/tts_edge.py`、`dsh-voice-picker/` 全部、
`test/` 全部 —— 原创代码，随整包按 AGPL-3.0-or-later 授权。
