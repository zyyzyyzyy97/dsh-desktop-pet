# PROJECT.md 补遗 · 性格模块（inner 版）

> 这份文件给未来接手工单的会话：装完 inner 版后，把下面几节并进
> `~/.dsh/dafei/PROJECT.md` 的对应章节即可（§4 能力 / §6 坑 / §8 验证 / §10 待办）。

---

## 并入 §4（已实现能力）

- **心情引擎（inner.ts）**：mood(v,a)+baseline 浮点，惰性指数衰减（τv=3h/τa=45min/τb=5d），
  冲量三路（EXTRACT 搭车 ±0.3/启发式 ±0.1/冷落档位一次性），q3 三位小数记账，
  流水 inner-log.jsonl 永不清理。注入【你此刻的心情】人话+原因，平静时空串，永远不给数字。
  过夜宽宥（19 点后走、6-11 点回、<18h 不算冷落）；唤醒度软顶 a/0.85 防长聊爆表。
- **自画像/重要时刻**：每 80 句新对话 + ≥12h 让她重写"我现在是谁"（portrait，不合格保留旧版）；
  里程碑（moment）识别入库去重，brief 常驻最多 4 条。diaryHint 三段式：画像→印象→日记。
- **时间感**：relationHint 增补"上次说话 X 前（>30min 才说）/今天几句/常在哪个时段上线"
  （memory.lastUserTs/userTurnsToday/activeBucket，样本不足不下结论）。
- **主动陪聊**（cfg.proactive，默认关）：150s 检查，沉默 [2h,8h] + 页面在线 + 心情>-0.35 +
  日限 2 次 + 安静时段外 + 他没晾着上一次 + 概率闸（平静 0.25/低落 0.08）。发了进记忆，绝不追问。
- **/api/inner**：内心快照（mood/baseline/lastEvent/hint 预览/pro 计数）。
- **学习批量化**：learnPending 单条覆盖（漏标）改为最多 3 对合并一次调用。

## 并入 §5（模型调用约定）

- EXTRACT_SYS v2：一次裸调用两件事——事实数组 + mood 冲量
  `{"facts":[…],"mood":{"dv","da","why"}}`；runLearn 兼容旧数组输出；引擎侧二次钳制。

## 并入 §6（踩坑清单 · 新增）

| 坑 | 真相 |
|---|---|
| 浮点累加卡阈值 | -0.18+0.1=-0.0799…，`|dv|>=0.08` 随机翻车 → 全状态 q3 三位小数记账 |
| 被动结算偷走冷落事件 | hint/快照轮询先撞 6h 线时 touch 拿不到事件 → pendingGap 待领（60s 窗口） |
| 长聊唤醒度饱和 | 每 2 轮 +0.1da 对 45min 衰减 → 稳态爆表 1.0 → 软顶 da×max(0,1-a/0.85) |
| 过夜被当冷落 | 19 点后走、早上回、<18h → 宽宥，不算 |
| 深夜启发式逐轮扣 | 长夜聊 30 轮 -0.9 触底 → 每次聊天开场只算一次（隔 2h 算新场） |
| cmd 多行 python -c | 静默截断到第一行，零报错零输出 → 必须单行或脚本文件 |
| 测试还原配置不可靠 | 崩溃时 finally 也没了 → 持久 .test-backup 文件，开头先还原残留 |
| node:sqlite 无独立 node | Coopanion.exe + ELECTRON_RUN_AS_NODE=1 = Node v24.21（自带 node:sqlite） |

## 并入 §8（验证手法）

- 三件套：`test/inner-unit.mjs`（14）+ `test/check-inner.mjs`（21，假模型+真服务进程）+
  `test/sim-week.mjs`（14，一周情绪轨迹仿真）。全绿 = 49 项断言。
- `PET_DEBUG_SYS=1` 把每轮 system 前 400 字写 pet-service.log，亲眼验证注入。
- `GET /api/inner` 直接看内心状态；`inner-log.jsonl` 是调参黑匣子。

## 并入 §10（待办）

- [x] 心情引擎 + 自画像/重要时刻 + 时间感 + 主动陪聊（默认关）——2026-10-30
- [ ] `cfg.proactive` 真机开启与观察（先稳一两周）
- [ ] baseline 由反思任务小步推动（±0.02，机制已预留）
- [ ] 心情驱动桌宠动作/表情（12 个手动动作 + 表情 vocab 已就位，未接）
- [ ] 设置页"她的内心"面板（/api/inner 已就绪）
- [ ] 主动陪聊 QQ 通道 + voiceOnly 语音版
- [ ] 观察两周 inner-log.jsonl 后回调常量（文件头集中）

## 并入 §2（代码在哪）

- 装在主目录的 inner 版里：`vendor/inner.ts`（心情引擎）、`test/inner-unit.mjs`、
  `test/check-inner.mjs`、`test/sim-week.mjs`；设计全文与安装/回滚见 `D:\性格\DESIGN.md`、`D:\性格\INSTALL.md`。
