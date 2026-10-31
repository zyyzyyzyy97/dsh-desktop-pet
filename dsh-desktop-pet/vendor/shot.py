"""抓一张桌面并压成小 PNG，给鲸鱼看屏幕用。

只用标准库 + Win32 GDI，不装任何东西。
缩放交给 StretchBlt（GDI 层，快），颜色转换用切片赋值（C 级），
所以整条链路一二十毫秒，不会卡住聊天。

用法：
    python shot.py <输出路径> [目标宽度] [显示器序号,-1=全部]

输出到 stdout 的一行 JSON：
    {"ok":true,"path":"...","w":1100,"h":688,"bytes":312345,"ms":23,"screen":"1920x1080"}
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import struct
import sys
import time
import zlib

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()

SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79
SM_CMONITORS = 80

SRCCOPY = 0x00CC0020
HALFTONE = 4


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD),
        ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def monitor_rect(idx):
    """取某块显示器的矩形；idx<0 取所有屏拼起来的虚拟桌面。"""
    if idx < 0:
        return (user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
                user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
                user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
                user32.GetSystemMetrics(SM_CYVIRTUALSCREEN))
    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT),
                    ("dwFlags", wt.DWORD)]
    monitors = []
    MONITORENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HMONITOR, wt.HDC,
                                         ctypes.POINTER(wt.RECT), wt.LPARAM)

    def cb(hmon, hdc, lprc, lp):
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            r = mi.rcMonitor
            monitors.append((r.left, r.top, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumDisplayMonitors(0, 0, MONITORENUMPROC(cb), 0)
    if not monitors:
        return monitor_rect(-1)
    return monitors[min(idx, len(monitors) - 1)]


def grab(out_path, target_w=1100, idx=-1):
    t0 = time.time()
    sx, sy, sw, sh = monitor_rect(int(idx))
    if sw <= 0 or sh <= 0:
        raise RuntimeError("拿不到屏幕尺寸")

    tw = max(320, min(int(target_w), sw))
    th = max(200, round(sh * tw / sw))

    hdc_screen = user32.GetDC(0)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbm = gdi32.CreateCompatibleBitmap(hdc_screen, tw, th)
    gdi32.SelectObject(hdc_mem, hbm)

    # 直接从屏幕 DC 拉伸到目标尺寸，省掉在 Python 里缩放
    gdi32.SetStretchBltMode(hdc_mem, HALFTONE)
    gdi32.SetBrushOrgEx(hdc_mem, 0, 0, None)
    ok = gdi32.StretchBlt(hdc_mem, 0, 0, tw, th, hdc_screen, sx, sy, sw, sh, SRCCOPY)
    if not ok:
        gdi32.BitBlt(hdc_mem, 0, 0, tw, th, hdc_screen, sx, sy, SRCCOPY)

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = tw
    bi.biHeight = -th
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0
    buf = ctypes.create_string_buffer(tw * th * 4)
    gdi32.GetDIBits(hdc_mem, hbm, 0, th, buf, ctypes.byref(bi), 0)

    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(0, hdc_screen)

    raw = buf.raw
    rgb = bytearray(tw * th * 3)
    rgb[0::3] = raw[2::4]
    rgb[1::3] = raw[1::4]
    rgb[2::3] = raw[0::4]

    rows = bytearray()
    stride = tw * 3
    for y in range(th):
        rows.append(0)
        rows += rgb[y * stride:(y + 1) * stride]

    def chunk(tag, d):
        return (struct.pack(">I", len(d)) + tag + d
                + struct.pack(">I", zlib.crc32(tag + d) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", tw, th, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(rows), 3))
           + chunk(b"IEND", b""))

    tmp = out_path + ".part"
    with open(tmp, "wb") as f:
        f.write(png)
    os.replace(tmp, out_path)

    return {"ok": True, "path": out_path, "w": tw, "h": th, "bytes": len(png),
            "ms": int((time.time() - t0) * 1000), "screen": f"{sw}x{sh}",
            "monitors": user32.GetSystemMetrics(SM_CMONITORS)}


if __name__ == "__main__":
    try:
        out = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
        w = int(sys.argv[2]) if len(sys.argv) > 2 else 1100
        i = int(sys.argv[3]) if len(sys.argv) > 3 else -1
        print(json.dumps(grab(out, w, i), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
