// 开发期手动运行：在本目录直接把音色工作台拉起来（连真实小鲸鱼，只读它的配置）。
// 用完 Ctrl+C。不写任何文件。
import { startPickerServer } from '../dsh-voice-picker/src/server.mjs'

const port = Number(process.argv[2] || 18796)
const h = await startPickerServer({ port, petPort: 18765, ctrlPort: 18766, autoOpen: false, log: (...a) => console.log(...a) })
console.log('工作台地址:', h.url, '（Ctrl+C 退出）')
