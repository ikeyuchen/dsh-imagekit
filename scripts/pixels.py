# -*- coding: utf-8 -*-
"""dsh-plugin-image-pipeline 的像素后端 —— 一次性子进程，JSON 进 JSON 出。

用法: python -X utf8 pixels.py <subcommand> <job.json>
子命令: resize | mark_region | flatten_alpha | anim_encode | fg_metrics

设计约束（与 lib/index.js 的工具描述一一对应，勿单方面改动）：
- resize 只做 Lanczos 重采样，**永不锐化**——v5a 定论：超分已含锐化，
  再叠加 USM = 过锐（2026-10-03 实测翻车项）
- mark_region 画粗红圈（默认 14px 纯红）——细圈/软标记实测会泄漏到圈外
- flatten_alpha 服务抠图前处理：本管线 RGBA 输出带 VAE alpha 噪声
  （222-255 全图分布），不扁平化则抠不净（alpha 下限 178，实测）
- anim_encode 逐帧 duration 是六阶段动画节奏的载体
  （预备/滞空 110-120ms、爆发/下落 50-70ms，比统一帧率高级）
- fg_metrics 移植自 examples/pose_check.py（2026-10-02 定版逻辑，
  阈值 cy 差 <0.08 = 垂直跟随良好，实测校准）
"""
import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

Image.MAX_IMAGE_PIXELS = 300_000_000  # 约 17K×17K 的解码护栏


def die(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)


def load_job():
    if len(sys.argv) != 3:
        die("usage: pixels.py <subcommand> <job.json>")
    with open(sys.argv[2], "r", encoding="utf-8") as f:
        return json.load(f)


def open_image(path):
    p = Path(path)
    if not p.is_file():
        die(f"input not found: {path}")
    try:
        return Image.open(p)
    except Exception as e:  # 解码失败要响亮，不能装懂
        die(f"cannot decode image {path}: {e}")


def has_alpha(im):
    return im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)


def flatten(im, bg):
    """压平到不透明底色（alpha 噪声防线，见模块注释）。"""
    base = Image.new("RGB", im.size, bg)
    rgba = im.convert("RGBA")
    base.paste(rgba, mask=rgba.getchannel("A"))
    return base


def out_bytes(path):
    return Path(path).stat().st_size


# ---------------------------------------------------------------- subcommands

def cmd_resize(job):
    im = open_image(job["input"])
    keys = [k for k in ("width", "height", "percent") if job.get(k) is not None]
    if len(keys) != 1:
        die("provide exactly one of width / height / percent (got: %s)" % (keys or "none"))
    fmt = job.get("format", "png")
    if fmt not in ("png", "jpeg", "webp"):
        die(f"format must be png|jpeg|webp, got {fmt!r}")
    w, h = im.size
    k = keys[0]
    if k == "percent":
        pv = int(job[k])
        if not (1 <= pv <= 400):
            die(f"percent must be 1-400 (downsample-first tool), got {pv}")
        nw, nh = max(1, round(w * pv / 100)), max(1, round(h * pv / 100))
    elif k == "width":
        nw = int(job[k])
        nh = max(1, round(h * nw / w))
    else:
        nh = int(job[k])
        nw = max(1, round(w * nh / h))
    if not (1 <= nw <= 20000 and 1 <= nh <= 20000):
        die(f"target size out of range: {nw}x{nh}")
    quality = int(job.get("quality", 92 if fmt == "jpeg" else 90))
    if fmt == "jpeg":
        base = flatten(im, "#FFFFFF") if has_alpha(im) else im.convert("RGB")
    elif has_alpha(im):
        base = im.convert("RGBA")
    else:
        base = im.convert("RGB")
    # 唯一的采样器：Lanczos。刻意不接任何锐化参数（见模块注释）。
    base = base.resize((nw, nh), Image.LANCZOS)
    if fmt == "png":
        base.save(job["output"], "PNG")
    else:
        base.save(job["output"], fmt.upper(), quality=quality)
    return {"output": job["output"], "in_width": w, "in_height": h,
            "width": nw, "height": nh, "bytes": out_bytes(job["output"])}


def cmd_mark_region(job):
    im = open_image(job["input"])
    cx, cy, r = int(job["cx"]), int(job["cy"]), int(job["radius"])
    sw = int(job.get("stroke_width", 14))
    color = job.get("color", "#FF0000")
    if r < 3:
        die(f"radius must be >= 3 px, got {r}")
    if sw < 2:
        die(f"stroke_width must be >= 2 px (thin markers leak), got {sw}")
    if not (0 <= cx < im.size[0] and 0 <= cy < im.size[1]):
        die(f"center ({cx},{cy}) outside image {im.size[0]}x{im.size[1]}")
    base = flatten(im, "#FFFFFF") if has_alpha(im) else im.convert("RGB")
    if r <= sw // 2 + 2:
        die(f"radius {r} too small for stroke_width {sw} (the ring would fill the circle); increase radius or lower stroke_width")
    draw = ImageDraw.Draw(base)
    # PIL 的椭圆描边向内侧展开：外扩半个线宽，让可见环带（宽 sw）恰好以半径 r 为中心，
    # 返回的 bbox 是外缘框。坑：不外扩时粗线会把小圆整体涂满（2026-10-04 selftest 抓到）。
    ext = sw // 2
    bbox = [cx - r - ext, cy - r - ext, cx + r + ext, cy + r + ext]
    draw.ellipse(bbox, outline=color, width=sw)
    # 圆心贴边时外扩后的环带会越出画布（PIL 静默裁掉部分粗环）——
    # 返回的 bbox 夹取到画布内，报告的是实际画出来的标记区域，不给下游留负坐标/越界
    # 坐标（die 会误伤贴边圈选的合法用法，不采用；绘制本身用未夹取的 bbox，PIL 自行裁剪）。
    w, h = base.size
    bbox = [max(0, bbox[0]), max(0, bbox[1]), min(w, bbox[2]), min(h, bbox[3])]
    base.save(job["output"], "PNG")
    return {"output": job["output"], "bbox": bbox,
            "in_width": im.size[0], "in_height": im.size[1], "bytes": out_bytes(job["output"])}


def cmd_flatten_alpha(job):
    im = open_image(job["input"])
    bg = job.get("background", "#FFFFFF")
    fmt = job.get("format", "jpeg")
    if fmt not in ("jpeg", "png"):
        die(f"format must be jpeg|png, got {fmt!r}")
    had = has_alpha(im)
    base = flatten(im, bg)
    quality = int(job.get("quality", 92))
    if fmt == "jpeg":
        base.save(job["output"], "JPEG", quality=quality)
    else:
        base.save(job["output"], "PNG")
    return {"output": job["output"], "width": base.size[0], "height": base.size[1],
            "had_alpha": had, "bytes": out_bytes(job["output"])}


def cmd_anim_encode(job):
    paths = job["frames"]
    if len(paths) < 2:
        die(f"anim needs >= 2 frames, got {len(paths)}")
    fmt = job.get("format", "webp")
    if fmt not in ("webp", "gif"):
        die(f"format must be webp|gif, got {fmt!r}")
    quality = int(job.get("quality", 88))
    loop = int(job.get("loop", 0))
    dur = job["durations_ms"]
    # 数值标量按"数值"统一判——JSON 里合法的 90.0 是 float，原 isinstance(dur, int)
    # 会把它落进迭代分支对 float 直接 TypeError（裸 traceback）；字符串 "110" 按字符迭代成
    # [1,1,0] 再报莫名其妙的越界。逐帧 float 时长用 round 而非 int 截断（110.9 → 111）。
    if isinstance(dur, (int, float)) and not isinstance(dur, bool):
        durs = [round(float(dur))] * len(paths)
    elif isinstance(dur, list):
        durs = [round(float(d)) for d in dur]
    else:
        die(f"durations_ms must be a number or a list of numbers, got {type(dur).__name__}")
    if len(durs) != len(paths):
        die(f"durations_ms length {len(durs)} != frames {len(paths)}")
    for d in durs:
        if not (20 <= d <= 60000):
            die(f"duration {d} ms out of range 20-60000")
    imgs = []
    for p in paths:
        im = open_image(p)
        imgs.append(im.convert("RGBA") if has_alpha(im) else im.convert("RGB"))
    size = imgs[0].size
    norm = [i if i.size == size else i.resize(size, Image.LANCZOS) for i in imgs]
    max_size = job.get("max_size")
    if max_size:
        ms = int(max_size)
        longest = max(size)
        if longest > ms:
            ns = (max(1, round(size[0] * ms / longest)), max(1, round(size[1] * ms / longest)))
            norm = [i.resize(ns, Image.LANCZOS) for i in norm]
            size = ns
    out = job["output"]
    if fmt == "webp":
        # WebP q88 优先：百万色，比 GIF 小约 7 倍（实测）
        norm[0].save(out, "WEBP", save_all=True, append_images=norm[1:],
                     duration=durs, loop=loop, quality=quality, method=4)
    else:
        q = [i.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT) for i in norm]
        q[0].save(out, "GIF", save_all=True, append_images=q[1:],
                  duration=durs, loop=loop, optimize=True)
    return {"output": out, "frames": len(paths), "width": size[0], "height": size[1],
            "durations_ms": durs, "bytes": out_bytes(out)}


def cmd_fg_metrics(job):
    # 与其余子命令同款干净报错（input not found / cannot decode），不裸 traceback
    im = open_image(job["image"])
    try:
        import numpy as np
    except ImportError as e:
        # 缺 numpy 要响亮并给修法，不能裸 ImportError 栈
        die(f"fg_metrics needs numpy (ImportError: {e}); install numpy or set pythonCommand to an interpreter that has it")
    arr = np.asarray(im.convert("L").resize((256, 256)), dtype=np.float32)
    fg = arr > 90 if job.get("dark_bg") else arr < 210
    ys, xs = np.nonzero(fg)
    if len(ys) == 0:
        die("no foreground detected (threshold mismatch? character=light bg, skeleton=dark bg)")
    return {"cy": float(ys.mean() / 255), "cx": float(xs.mean() / 255),
            "top": float(ys.min() / 255), "bot": float(ys.max() / 255),
            "cover": round(float(fg.mean()), 4)}


def cmd_probe(job):
    """解释器探测：确认 python + PIL（可选 numpy）活着，返回版本。"""
    info = {"ok": True, "pil": Image.__version__}
    if job.get("need_numpy"):
        import numpy as np
        info["numpy"] = np.__version__
    return info


SUBCOMMANDS = {
    "resize": cmd_resize,
    "mark_region": cmd_mark_region,
    "flatten_alpha": cmd_flatten_alpha,
    "anim_encode": cmd_anim_encode,
    "fg_metrics": cmd_fg_metrics,
    "probe": cmd_probe,
}


def main():
    sub = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = SUBCOMMANDS.get(sub)
    if fn is None:
        die(f"unknown subcommand {sub!r}; available: {', '.join(SUBCOMMANDS)}")
    try:
        result = fn(load_job())
    except SystemExit:
        raise  # die() 自己的退出通道，原样放行
    except Exception as e:
        # 未预期异常（缺字段/坏数值/坏 JSON/非法 color）也必须走 die() 契约
        # （stderr 单行 + exit 2）——父进程 JS 依赖该协议区分「坏输入」与「崩溃」
        die(f"{sub} failed: {type(e).__name__}: {e}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
