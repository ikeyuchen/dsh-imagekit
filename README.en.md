# dsh-imagekit

<img src="docs/icon.png" width="88" height="88" alt="dsh-imagekit">

**Local image generation and upscaling for DeepSeek Harness** — Qwen-Image text-to-image / reference edits, Vulkan super-resolution, plus pixel tools, ComfyUI engine and VRAM monitoring.

[简体中文](README.md) · **English**

[![npm](https://img.shields.io/npm/v/dsh-imagekit?color=4b6fff)](https://www.npmjs.com/package/dsh-imagekit)
[![license](https://img.shields.io/badge/license-MIT-4b6fff)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey)](#requirements)
[![dsh](https://img.shields.io/badge/dsh-0.2.x-6c5ce7)](package.json)

## Install

Search **`dsh-imagekit`** in the plugin marketplace, or install from npm:

```bash
dsh plugin --profile web add dsh-imagekit
```

For source development:

```bash
git clone https://github.com/ikeyuchen/dsh-imagekit.git
dsh plugin --profile web add ./dsh-imagekit
```

## Features

| Tool | What it does |
| --- | --- |
| `image_generate` / `image_generate_raw` | Text-to-image, reference-based edits, custom workflows; `draft` / `standard` / `quality` tiers |
| `image_upscale` | 10 Vulkan presets from official upstream builds (Real-CUGAN / Real-ESRGAN / waifu2x / RealSR; MIT + BSD-3) |
| 5 pixel tools | Resize, region marking, alpha flatten, frame animation, pose check |
| `comfy` / `image_service_status` | ComfyUI engine start/stop, self-healing, upgrade |
| `image_setup` | Download, verify, back up, roll back and prune models and engines |
| `perf` / `env_probe` / `preflight` | VRAM sampling, environment checks, pre-flight gates |

Toolsets are registered by profile: `minimal` 5 / `standard` 13 / `all` 15 (default `standard`).

## Models

| Pack | Steps | Notes |
| --- | --- | --- |
| `core` (standard) | 25 | Best detail and Chinese text; ~30–60 s on a warm engine |
| `fast` (turbo) | 6–8 | Turbo-distilled, about 1/3 the time, close to standard quality; good for drafts |

Both packs can be installed together and share the VAE and text encoder; pick `lowvram` on 8 GB GPUs.

## Samples

<p align="center">
  <img src="docs/demo-photo.webp" width="300" alt="Photoreal: orange cat on a windowsill">
  &nbsp;&nbsp;
  <img src="docs/demo-anime.webp" width="300" alt="Anime: fox-eared girl under cherry blossoms">
  <br>
  <img src="docs/demo-text.webp" width="300" alt="Text: Chinese poster">
  &nbsp;&nbsp;
  <img src="docs/demo-scene.webp" width="300" alt="Scene: mountain lake at dusk">
</p>
<p align="center"><em>Photoreal · anime · text · scene, all generated locally by this plugin (1056² / 1056² / 1024² / 1056²; prompts in <a href="docs/USAGE.md">usage</a>)</em></p>

## Requirements

- Windows 10/11 x64 (engine and upscale binaries are Win64 only for now).
- ComfyUI, Qwen-Image weights and 7-Zip are not bundled; check what is missing with `image_setup(action="status")`.
- The generation gateway (default `127.0.0.1:8189`) is a separate service you provide and point the plugin at.

## Docs

[Usage](docs/USAGE.md) · [Prompting](docs/PROMPTS.md) · [Model & params](docs/MODEL.md) · [Configuration](docs/CONFIGURATION.md) · [Engine versions](docs/ENGINE-VERSIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Implementation](docs/IMPLEMENTATION.md) · [Icon](docs/ICON.md) · [Releasing](docs/RELEASING.md) · [Roadmap](docs/ROADMAP.md) · [Changelog](CHANGELOG.md) · [Third-party](THIRD_PARTY.md)

## License

MIT. This is a third-party open-source plugin, not affiliated with, sponsored or endorsed by Alibaba / Qwen, the ComfyUI project, or DeepSeek. Product names are used only to describe compatibility.
