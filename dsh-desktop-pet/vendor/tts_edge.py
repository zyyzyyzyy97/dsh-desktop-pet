"""edge-tts 兜底：qwen3-tts 挂了或者没网时用这个。

只做一件事：读一个 UTF-8 文本文件，合成 mp3 写到指定路径。
不直接收中文参数，避开 Windows 命令行编码那些坑。
"""
import asyncio
import sys

import edge_tts


async def main() -> None:
    src, out, voice, rate = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    with open(src, "r", encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        raise SystemExit("empty text")
    await edge_tts.Communicate(text, voice, rate=rate).save(out)


asyncio.run(main())
