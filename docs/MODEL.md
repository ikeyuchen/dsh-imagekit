# 生图链路与参数手册

> 这份文档回答两个问题：**提示词到底被送到哪里、中间有没有被加工**，以及**模型有哪些参数、该怎么调**。
> 提示词怎么写见 [PROMPTS.md](./PROMPTS.md)；怎么用起来见 [USAGE.md](./USAGE.md)。

## 1. 提示词的真实链路

```
image_generate(prompt)
   → 网关 POST /generate/async { prompt, negative_prompt, template, width, height, steps, cfg, seed, batch_size, resolution, denoise, ref_images }
   → 网关把 __PROMPT__ / __NEGATIVE__ / __WIDTH__ … 替换进 workflow JSON
   → ComfyUI 执行
```

**关键事实：默认模板里没有 system prompt、没有上游的 caption 包装。**

`qwen_image_2_1_t2i_api.json` 的相关节点：

| 节点 | class_type | 参数 |
|---|---|---|
| 5 | `TextEncodeQwenImage21` | `prompt: __PROMPT__`、`negative_prompt: __NEGATIVE__`、`resolution: 1024` |
| 6 | `EmptyLatentImage` | `__WIDTH__ × __HEIGHT__`、`batch_size: __BATCH__` |
| 7 | `KSampler` | `euler` / `simple`、`steps: __STEPS__`、`cfg: __CFG__`、`denoise: 1.0` |

也就是说你写的 prompt **原样进文本编码器**。对比 Qwen 上游 diffusers 模板会包一层
*"Describe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships…"*，
我们这版不做包装——所以**提示词本身必须写成图像描述（caption）**，写成关键词堆效果会明显变差。

## 2. 采样参数

| 参数 | 默认 | 范围/取值 | 什么时候动 |
|---|---|---|---|
| `steps` | 25 | 4–50（turbo LoRA 模板 6） | 细节不够 +5~10；赶时间用 `draft` 档（turbo 6 步 ≈ standard，见 §5.3） |
| `cfg` | 1.0 | 1.0–3.0（实测） | 保持 1.0；2.0 更浓但耗时 ×1.5，3.0 不推荐（见 §5.2） |
| `width` / `height` | 由档位决定（draft 1056² / standard 1536² / quality 2048²） | 32 的倍数；模型原生 ≈4MP（2048²），官方比例表 2048²–2752×1536 | 默认档 1536²（25 步，12G 约 50 秒）；成片 2048²/40 步（约 170 秒）；草稿 1056²；**超过原生不建议**（2560² 25 步 226 秒且易重复） |
| `seed` | -1（随机） | 整数 | 复现同一张：填上次结果里的 seed |
| `batch_size` | 1 | 1–8 | 一次出多张再挑；显存占用线性增长 |
| `denoise` | 1.0 | 0.05–1.0 | **只对 i2i 有效**：0.4–0.7 保结构改内容，1.0 完全重画 |
| `resolution` | 1024（edit 1056） | 512–2048 | **t2i 上无效**（模板写死），仅编辑模板生效（见 §5.1） |
| `negative_prompt` | 空 | 文本 | 出现稳定缺陷时再加，见下 |

采样器固定 **euler + simple**，不需要调；turbo 上游模板走 `KSamplerSelect` + `CFGGuider`。

### Prompt 增强（PE）模型的显存代价

`qwen3.5_9b_qwen_image_2.1_pe_t2i` / `_pe_i2i`（9B int8）**各 8.8 GB 磁盘**，实测算力显存：

| 项 | 实测（RTX 5070 Ti Laptop 12 GB） |
|---|---|
| 加载峰值 | **9.75 GB**（常驻 9.63 GB） |
| 释放后 | 1.23 GB（`/free` 立刻回收） |
| 释放后再出图 | 可正常跑（turbo 1056² 7.1 秒，峰值 11.57 GB） |

结论：

- **PE 与出图模型不能同时驻留 12 GB 卡**（PE 就要 9.75 GB），必须两段式：先加载 PE 扩写提示词 → `/free` 释放 → 再加载出图模型。
- **8 GB 显存跑不了 PE**（9.75 > 8），只能靠 `--lowvram` 交换，速度会非常慢；8G 用户建议直接用 PE 之外的写法（见 [PROMPTS.md](./PROMPTS.md)）。
- 两个 PE 模型合计 17.6 GB 磁盘，只在 `full` 包里；不装 PE 不影响文生图与参考图编辑。

### 负向提示词

模板支持（`__NEGATIVE__` 直连编码器），但**默认留空**。只在出现顽固缺陷时加，保持短：

```
文字乱码, 多余的手指, 畸变, 水印
```

堆一长串 `worst quality, low quality, bad anatomy…` 对 Qwen 收益很低。

## 3. 模板对照

| 模板 | 用途 | 关键差异 |
|---|---|---|
| `qwen_image_2_1_t2i` | 默认文生图 | 25 步，euler/simple |
| `qwen_image_2_1_t2i_turbo` | 草稿 | 挂 6 步 turbo LoRA（`Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r256`），`draft` 档用它 |
| `qwen_image_2_1_t2i_pe` | 文生图 + 服务端改写 | 多一个 `TextGenerate` 节点，把短提示词扩写成画面描述 |
| `qwen_image_2_1_turbo_official_t2i` | 上游 turbo | `KSamplerSelect` + `CFGGuider`，链路不同 |
| `qwen_image_2_1_cn` | 中文文字渲染 | 尺寸写死 1024² |
| `qwen_image_2_1_edit` | 单图编辑 | 需要 `ref_images`，`resolution` 可调 |
| `qwen_image_2_1_edit3` / `qwen_image_2_1_edit6` | 多图合成（3 / 6 张） | 同上，参考图数量不同 |
| `qwen_image_2_1_edit_pe` | 编辑 + 改写 | 编辑版 PE |
| `qwen_image_2_1_turbo_official_edit` | 上游 turbo 编辑 | turbo 链路的编辑版 |
| `qwen_image_2_1_i2i` | 图生图 | `denoise` 生效（`__DENOISE__`），其它模板写死 1.0 |
| `qwen_image_2_1_vnccs` | 姿态/构图控制 | 挂 VNCCS 姿态 LoRA |

> 传了 `ref_images` 但用 t2i 模板 → 参考图会被忽略。插件已做自动切换（见 `resolveTemplateForRefs`）。

## 4. 服务端改写（PE）

`*_pe` 模板里多一个 `TextGenerate` 节点：用户 prompt → 按 system prompt 改写成完整描述 → 再进编码器。

- system prompt 存在**外部网关**的 `workflows/_pe_system_prompt.txt`（10.3 KB），编辑版是 `_pe_i2i_system_prompt.txt`（均不在本仓库）
- 它要求模型以"观察者"身份描述成品图：定画幅 → 开篇句（媒介/风格/主体）→ 按区域走画面 →
  画面文字逐条加引号 → 光线单独一句 → 收尾总览；输出纯英文单段 400–500 词
- 明确禁止质量词（`masterpiece`/`8K`），要求颜色带修饰、材质具体、枚举不概括
- **在 ComfyUI 里执行，不占 agent 上下文**；只在传 `template: *_pe` 时触发

## 5. 实测记录（2026-11-07，12 GB 显存笔记本 GPU）

方法：同一提示词、同一 seed（424242 / 777），每次只改一个变量，1056×1056，跑完记录墙钟时间。

### 5.1 `resolution` 在 t2i 上无效

| 设置 | 结果 | 耗时 |
|---|---|---|
| `resolution: 512` | 与基线**逐字节相同** | 23.3s |
| `resolution: 1024`（默认） | 基线 | 27.0s |
| `resolution: 2048` | 与基线**逐字节相同** | **3.4s**（ComfyUI 图缓存命中，没重算） |

原因看模板就知道：`qwen_image_2_1_t2i_api.json` 里 `resolution` 是**字面量 1024**，
不是 `__RESOLUTION__`；只有 `edit` / `edit3` / `edit6` 用占位符。

**结论：文生图不用管 resolution（改了也不生效）；编辑模板才需要。**

### 5.2 `cfg` 高于 1.0 能用，但更慢

| cfg | 耗时 | 观感 |
|---|---|---|
| 1.0（默认） | 27.0s | 自然、肤色与毛色准确 |
| 2.0 | 40.6s | 对比与饱和略强，细节相当 |
| 3.0 | 39.3s | 更"浓"，已开始像加了滤镜 |

cfg > 1 时每步要同时算正负两条分支，**耗时约 ×1.5**。
**结论：默认 1.0；只有想要更强对比/饱和时才用 2.0，3.0 及以上不推荐。**

### 5.3 turbo 模板：质量相当，时间约 1/3

写实照片（猫，1056²）：

| 模板 | 步数 | 耗时 |
|---|---|---|
| `t2i`（standard） | 25 | 27.0s |
| `t2i_turbo`（viggle LoRA） | 6 | **9.8s** |
| `turbo_official_t2i` | 8 | **9.2s** |

中文海报（"晨光咖啡 / 每日 7:00 开门"，832×1216）：

| 模板 | 步数 | 耗时 | 文字正确性 |
|---|---|---|---|
| `t2i` | 25 | 20.6s | ✅ 正确，但多画了一排装饰斜线 |
| `t2i_turbo` | 6 | **8.2s** | ✅ 正确，画面更干净 |
| `turbo_official_t2i` | 8 | **8.3s** | ✅ 正确，标题更大更浓 |

**结论：在本次测试的写实照片与中文海报两类样例上，turbo 模板与 standard 质量同级，耗时约 1/3。**
推荐用法：**迭代用 `draft`（= t2i_turbo 6 步），定稿再跑 `standard`**。
中文文字在两个 turbo 模板下同样能正确渲染，不必为了文字回到 25 步。

### 5.4 引擎长跑后的一个坑

引擎连续运行约 7 小时后，文本编码节点报 `VBAR allocation failed`（CUDA 虚拟地址分配失败），
即使显存显示空闲。**处理：`comfy(action="control", op="restart")`**，重启后首张图有 7–20 秒模型加载，
之后恢复。已写入 [USAGE.md](./USAGE.md) 故障表。
