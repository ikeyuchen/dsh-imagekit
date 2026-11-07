/**
 * dsh-imagekit — Client（浏览器）半侧
 *
 * 职责：在「插件详情页 → 配置」里提供图像生成工坊的设置表单：
 *   存储位置（安装根 / 模型目录 / 引擎目录 / 放大引擎目录）
 *   下载源（模型源 / 自定义镜像 / 放大引擎源）
 *   自动行为（自动下载 / 自动检查更新 / 保留旧版本 / 工具集档位）
 *
 * 机制（2026-11-06 验证可用）：
 *   - 宿主按行 id 服务 volatile 字段（configForms → 'tool-image'）；
 *   - SettingsFormModel 做 staged 表单，inject() 把快照与动作并进 props；
 *   - 只投 plugins.bundle.config 座位（嵌插件详情页）。
 *
 * 资源下载/删除属于长任务，由 host 侧 image_setup 工具执行（带进度与确认），
 * 本表单只负责路径与策略配置——设置页不做磁盘写操作。
 */
window.__ModuleLoader__.load({
  id: 'dsh-imagekit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const prim = require('@deepseek-ai/dsh-client-ui-primitives')
    const { SettingsForm, SettingsFormModel, settingsTextField } = prim

    const NS = 'imagekit.ui'
    const PERF_NS = 'imagekit.perf'

    const zh = {
      summary: '存储位置、下载源与自动行为',
      group_store: '存储位置',
      group_source: '下载源',
      group_behaviour: '自动行为',
      group_perf: '性能与显存',
      perfHint: '生成前确认专用显存与共享显存回退；数据来自 host 侧 perf 采样器。',
      perfGpu: 'GPU',
      perfFree: '剩余',
      perfUtil: '利用率',
      perfTemp: '温度',
      perfShared: '共享显存',
      perfFallbackOn: '已溢出到系统内存（静默 10–50x 慢）',
      perfFallbackOff: '未溢出',
      perfProcesses: 'GPU 进程',
      perfSampling: '采样',
      perfStandby: '待机（无会话活动）',
      perfRunning: '采样中',
      perfRefresh: '刷新显存',
      perfUnavailable: '宿主未提供 perf 工具（minimal 档位不含 perf，切到 standard 即可）',
      perfNoData: '暂无采样数据；点「刷新显存」重试。',
      group_assets: '组件与手动下载',
      assetsHint: '组件不会自动下载。点击「下载 / 安装」才会联网；大文件请手动确认后再开始。',
      assetEngine: 'ComfyUI 引擎',
      assetModels: '生图模型',
      assetUpscale: '图片放大引擎',
      assetInstalled: '已安装',
      assetAbsent: '未安装',
      assetMissing: '缺失',
      assetDownload: '下载 / 安装',
      assetAlreadyInstalled: '已安装且清单完整；如需复测请点「校验」',
      assetVersionUnknown: '版本未记录',
      assetManifestVersion: '清单版本',
      assetUpdateAvailable: '可升级',
      assetUpgrade: '升级',
      assetUpgradeHint: '按清单登记的固定版本重新下载并校验；引擎升级会先停止引擎，完成后自动重启',
      assetUpgradeConfirm: '升级引擎会先停止正在运行的 ComfyUI（排队中的任务会中断），校验通过后自动重启。继续？',
      assetUpgradeConfirmGeneric: '升级会先备份当前版本，再下载并校验清单版本；失败会自动回滚。继续？',
      assetJobProgress: '进度',
      assetDownloading: '下载中',
      assetExtracting: '下载完成，正在解压',
      assetJobWaiting: '准备中（解析下载源）',
      assetSpeed: '速度',
      assetEta: '剩余',
      assetPackDelete: '删除该包',
      assetPackDeleteConfirm: '只删除这个包独有的模型文件；与其他已装包共用的文件会保留（仍被需要）。继续？',
      assetDeleteAllConfirm: '这会删除「生图模型」下的全部模型文件（所有包）。只想删一个包装错的话，用右侧每个包的「删除该包」。继续全部删除？',
      assetBackups: '旧版本备份',
      assetBackupDelete: '删除旧版本',
      assetBackupDeleteConfirm: '确定删除这个旧版本备份？删除后无法用于回滚。',
      assetVerifyHint: '按清单校验大小 / sha256',
      assetVerify: '校验',
      assetDelete: '删除',
      assetDeleteConfirm: '确定删除该组件？这会删除磁盘上的文件，且不可恢复。',
      assetRefresh: '刷新状态',
      assetIdle: '点击「刷新状态」读取已安装组件。',
      assetWorking: '处理中，请稍候…',
      outputDir: '生成图片目录',
      outputDirHint: '不传 save_to 时，所有生图/放大结果统一放在这里（放大在 outputs/upscale 子目录）',
      installRoot: '安装根目录',
      resetDefaults: '恢复默认',
      resetDefaultsHint: '自动检测磁盘：有 D 盘用 D，无 D 盘用 C',
      resetDone: '已填入默认路径，请点「保存」生效。',
      installRootHint: '工具分类根；引擎/模型/放大引擎都放在它下面，便于按工具整理与清理',
      modelsRoot: '生图模型目录',
      modelsRootHint: '留空 = <安装根>/models；已有 ComfyUI 模型可指过去复用，不必重新下载',
      engineRoot: 'ComfyUI 引擎目录',
      engineRootHint: '便携版解包目录（含 python_embeded 与 ComfyUI）',
      upscaleEnginesRoot: '放大引擎目录',
      upscaleEnginesRootHint: 'Real-CUGAN / Real-ESRGAN / waifu2x / RealSR 四个子目录所在位置',
      modelSource: '模型下载源',
      modelSourceHint: 'hf-mirror / modelscope 为第三方镜像，默认走官方 huggingface',
      modelPackBaseUrl: '自定义镜像根 URL',
      modelPackBaseUrlHint: '仅当模型源为 custom 时使用，例：https://your-mirror.example.com/imagekit',
      githubProxy: 'GitHub 下载代理',
      githubProxyHint: '空 = 不用。仅当官方下载不通时兜底，例：https://ghfast.top/（只代理 github.com 链接，仍校验 sha256；实测不加速，只提升可达性）',
      modelPacks: '生图模型（可同时安装）',
      modelPacksHint: '标准与快速是不同扩散模型，可同时安装、由工作流选择；8G 档把文本编码器换成 w4a8。',
      packDownload: '下载该模型',
      packInstalled: '已安装',
      pack_core: '标准 · int8（12G 显存）',
      pack_fast: '快速 · turbo int8（12G 显存）',
      pack_lowvram: '标准 · int8 + w4a8（8G 显存）',
      'pack_lowvram-fast': '快速 · turbo int8 + w4a8（8G 显存）',
      pack_full: '全量（turbo + ControlNet + PE）',
      installedPack: '已安装档位',
      upscaleSource: '放大引擎下载源',
      upscaleSourceHint: 'official = 上游 GitHub Release',
      toolsetProfile: '工具集档位',
      toolsetProfileHint: '只做生图和放大就选 minimal；要跑自己的 ComfyUI 工作流或改图（缩放/标记/合成）选 standard；还要看显存与环境体检选 all',
      autoDownload: '自动下载缺失组件',
      autoDownloadHint: '默认关闭；关闭时只在你明确要求下载时才联网',
      autoCheckUpdates: '自动检查组件更新',
      autoCheckUpdatesHint: '在插件详情页提示引擎/引擎包是否有新版本',
      keepVersions: '保留旧版本备份',
      keepVersionsHint: '升级后保留的备份份数，可在清理时删除',
      tasksHint: '下载 / 校验 / 删除是带进度的长任务，让助手运行 image_setup（status / install / upgrade / delete / verify / clean）即可；设置页只保存路径与策略。',
      on: '开启', off: '关闭',
      sourceHf: 'HuggingFace', sourceHfMirror: 'HF 镜像', sourceMs: 'ModelScope', sourceCustom: '自定义镜像',
      upOfficial: '官方 GitHub', upSourceforge: 'SourceForge 镜像', upCustom: '自定义镜像',
      profileMinimal: 'minimal · 生图+放大（5 件）', profileStandard: 'standard · +工作流与处理（13 件）', profileAll: 'all · +性能与环境（15 件）',
      keep0: '不保留', keep1: '保留 1 份', keep2: '保留 2 份',
      unavailable: '宿主未提供该配置命名空间（插件未加载？）。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '宿主没有接受这些值，已保留供你修改。',
      save: '保存', saving: '保存中…',
    }
    const en = {
      summary: 'Storage, download sources and automation',
      group_store: 'Storage',
      group_source: 'Download sources',
      group_behaviour: 'Automation',
      group_perf: 'Performance & VRAM',
      perfHint: 'Check dedicated VRAM and shared-memory fallback before generating; data comes from the host perf sampler.',
      perfGpu: 'GPU',
      perfFree: 'free',
      perfUtil: 'util',
      perfTemp: 'temp',
      perfShared: 'Shared memory',
      perfFallbackOn: 'spilling into system RAM (silent 10–50x slowdown)',
      perfFallbackOff: 'not spilling',
      perfProcesses: 'GPU processes',
      perfSampling: 'sampling',
      perfStandby: 'standby (no session activity)',
      perfRunning: 'sampling',
      perfRefresh: 'Refresh VRAM',
      perfUnavailable: 'The host does not expose the perf tool (minimal profile has no perf; use standard)',
      perfNoData: 'No samples yet; click Refresh VRAM to retry.',
      group_assets: 'Components & manual download',
      assetsHint: 'Components are never downloaded automatically. Click Download / Install to start; confirm before moving large files.',
      assetEngine: 'ComfyUI engine',
      assetModels: 'Image models',
      assetUpscale: 'Upscale engines',
      assetInstalled: 'installed',
      assetAbsent: 'not installed',
      assetMissing: 'missing',
      assetDownload: 'Download / install',
      assetAlreadyInstalled: 'Installed and complete; use Verify to re-check',
      assetVersionUnknown: 'version unrecorded',
      assetManifestVersion: 'manifest',
      assetUpdateAvailable: 'update available',
      assetUpgrade: 'Upgrade',
      assetUpgradeHint: 'Re-downloads the pinned manifest version and verifies size + sha256; an engine upgrade stops the engine first and restarts it afterwards',
      assetUpgradeConfirm: 'Upgrading the engine stops the running ComfyUI (queued jobs are interrupted), then restarts it after verification. Continue?',
      assetUpgradeConfirmGeneric: 'Upgrade backs up the current version, downloads the manifest version, verifies it, and rolls back on failure. Continue?',
      assetJobProgress: 'progress',
      assetDownloading: 'downloading',
      assetExtracting: 'downloaded, extracting',
      assetJobWaiting: 'preparing (resolving source)',
      assetSpeed: 'speed',
      assetEta: 'left',
      assetPackDelete: 'Delete pack',
      assetPackDeleteConfirm: 'Removes only this pack\'s exclusive model files; files still needed by another installed pack are kept. Continue?',
      assetDeleteAllConfirm: 'This deletes ALL model files (every pack). To remove a single mistakenly downloaded pack, use Delete pack on that row. Continue with the full deletion?',
      assetBackups: 'Old version backups',
      assetBackupDelete: 'Delete old version',
      assetBackupDeleteConfirm: 'Delete this old-version backup? It can no longer be used to roll back.',
      assetVerifyHint: 'Check size / sha256 against the manifest',
      assetVerify: 'Verify',
      assetDelete: 'Delete',
      assetDeleteConfirm: 'Delete this component? This removes files on disk and cannot be undone.',
      assetRefresh: 'Refresh',
      assetIdle: 'Click Refresh to inspect installed components.',
      assetWorking: 'Working, please wait…',
      outputDir: 'Generated images directory',
      outputDirHint: 'When save_to is omitted, every generated/upscaled image lands here (upscales in outputs/upscale)',
      installRoot: 'Install root',
      resetDefaults: 'Restore defaults',
      resetDefaultsHint: 'Auto-detect disk: D if present, otherwise C',
      resetDone: 'Default paths filled; click Save to apply.',
      installRootHint: 'Per-tool root; engine/models/upscale live under it for easy cleanup',
      modelsRoot: 'Image models directory',
      modelsRootHint: 'Blank = <install root>/models; point it at an existing ComfyUI models dir to reuse weights',
      engineRoot: 'ComfyUI engine directory',
      engineRootHint: 'Portable build root (contains python_embeded and ComfyUI)',
      upscaleEnginesRoot: 'Upscale engines directory',
      upscaleEnginesRootHint: 'Location of the Real-CUGAN / Real-ESRGAN / waifu2x / RealSR subdirectories',
      modelSource: 'Model download source',
      modelSourceHint: 'hf-mirror / modelscope are third-party mirrors; default is official huggingface',
      modelPackBaseUrl: 'Custom mirror base URL',
      modelPackBaseUrlHint: 'Only used when the model source is custom',
      githubProxy: 'GitHub download proxy',
      githubProxyHint: 'Empty = off. Fallback only when the official route fails, e.g. https://ghfast.top/ (proxies github.com links only; sha256 still verified; reachability, not speed)',
      modelPacks: 'Image models (install together)',
      modelPacksHint: 'Standard and fast are different diffusion models; install both and pick per workflow. 8G profiles swap the text encoder to w4a8.',
      packDownload: 'Download model',
      packInstalled: 'installed',
      pack_core: 'Standard · int8 (12G VRAM)',
      pack_fast: 'Fast · turbo int8 (12G VRAM)',
      pack_lowvram: 'Standard · int8 + w4a8 (8G VRAM)',
      'pack_lowvram-fast': 'Fast · turbo int8 + w4a8 (8G VRAM)',
      pack_full: 'Full (turbo + ControlNet + PE)',
      installedPack: 'installed profile',
      upscaleSource: 'Upscale download source',
      upscaleSourceHint: 'official = upstream GitHub releases',
      toolsetProfile: 'Toolset profile',
      toolsetProfileHint: 'generate + upscale only → minimal; add your own ComfyUI workflows and image ops → standard; add VRAM/env checks → all',
      autoDownload: 'Auto-download missing components',
      autoDownloadHint: 'Off by default; downloads only run when you ask explicitly',
      autoCheckUpdates: 'Auto-check component updates',
      autoCheckUpdatesHint: 'Surface newer engine/pack versions on the plugin page',
      keepVersions: 'Keep old version backups',
      keepVersionsHint: 'Backups kept after an upgrade; removable with clean',
      tasksHint: 'Download / verify / delete are long jobs with progress: ask the assistant to run image_setup (status / install / upgrade / delete / verify / clean). This form stores paths and policy only.',
      on: 'On', off: 'Off',
      sourceHf: 'HuggingFace', sourceHfMirror: 'HF mirror', sourceMs: 'ModelScope', sourceCustom: 'Custom mirror',
      upOfficial: 'Official GitHub', upSourceforge: 'SourceForge mirror', upCustom: 'Custom mirror',
      profileMinimal: 'minimal · generate + upscale (5)', profileStandard: 'standard · + workflows & ops (13)', profileAll: 'all · + perf & env (15)',
      keep0: 'Keep none', keep1: 'Keep 1', keep2: 'Keep 2',
      unavailable: 'The host does not serve this config namespace (plugin not loaded?).',
      readOnly: 'Settings are read-only in this deployment.',
      saveFailed: 'The host did not accept these values; they are kept for editing.',
      save: 'Save', saving: 'Saving…',
    }

    // perf 工具卡（原 dsh-plugin-perfmon 的趋势卡）：GPU 显存折线 + 共享显存峰值。
    const perfZh = {
      title: '性能趋势',
      window: '窗口',
      points: '采样点',
      gpu: 'GPU 显存',
      cpu: 'CPU',
      ram: 'RAM 最低',
      shared: '共享显存峰值',
      marks: '打点',
      running: '采样中…',
      fallback: '无趋势数据（完整结果见工具输出）',
    }
    const perfEn = {
      title: 'Performance trend',
      window: 'Window',
      points: 'samples',
      gpu: 'GPU VRAM',
      cpu: 'CPU',
      ram: 'RAM min',
      shared: 'Shared VRAM peak',
      marks: 'marks',
      running: 'Sampling…',
      fallback: 'No trend data (see the tool output)',
    }

    const FIELDS = [
      'outputDir',
      'installRoot',
      'modelsRoot',
      'engineRoot',
      'upscaleEnginesRoot',
      'modelSource',
      'modelPackBaseUrl',
      'githubProxy',
      'upscaleSource',
      'toolsetProfile',
      'autoDownload',
      'autoCheckUpdates',
      'keepVersions',
    ]

    const SELECT_OPTIONS = {
      modelSource: [
        { value: 'modelscope', key: 'sourceMs' },
        { value: 'hf-mirror', key: 'sourceHfMirror' },
        { value: 'huggingface', key: 'sourceHf' },
        { value: 'custom', key: 'sourceCustom' },
      ],
      upscaleSource: [
        { value: 'official', key: 'upOfficial' },
        { value: 'sourceforge', key: 'upSourceforge' },
        { value: 'custom', key: 'upCustom' },
      ],
      toolsetProfile: [
        { value: 'standard', key: 'profileStandard' },
        { value: 'minimal', key: 'profileMinimal' },
        { value: 'all', key: 'profileAll' },
      ],
      autoDownload: [{ value: 'off', key: 'off' }, { value: 'on', key: 'on' }],
      autoCheckUpdates: [{ value: 'on', key: 'on' }, { value: 'off', key: 'off' }],
      keepVersions: [{ value: '1', key: 'keep1' }, { value: '0', key: 'keep0' }, { value: '2', key: 'keep2' }],
    }

    const TEXT_FIELDS = [
      { key: 'installRoot', group: 'group_store', placeholder: '安装根目录（留空 = 默认值）' },
      { key: 'outputDir', group: 'group_store', placeholder: '<installRoot>\\outputs' },
      { key: 'modelsRoot', group: 'group_store', placeholder: '<installRoot>\\models' },
      { key: 'engineRoot', group: 'group_store', placeholder: '<installRoot>\\engine\\ComfyUI_windows_portable' },
      { key: 'upscaleEnginesRoot', group: 'group_store', placeholder: '<installRoot>\\upscale-engines\\engines' },
      { key: 'modelPackBaseUrl', group: 'group_source', placeholder: 'https://…' },
      { key: 'githubProxy', group: 'group_source', placeholder: 'https://ghfast.top/' },
    ]

    const SOURCE_GROUP = 'group_source'
    const BEHAVIOUR_GROUP = 'group_behaviour'

    function defineErrorBoundary(root) {
      const Base =
        root && typeof root.Component === 'function'
          ? root.Component
          : class { constructor(props) { this.props = props; this.state = { error: null } } }
      class Boundary extends Base {
        constructor(props) { super(props); this.state = { error: null } }
        static getDerivedStateFromError(error) { return { error } }
        render() {
          if (this.state && this.state.error) {
            return h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, currentColor)' } },
              String(this.state.error?.message ?? this.state.error))
          }
          return super.render()
        }
      }
      return Boundary
    }

    /** perf 工具卡：从原 dsh-plugin-perfmon 迁移，数据只读 presentationMeta。 */
    const PerfCardBase = typeof React.Component === 'function'
      ? React.Component
      : class { constructor(props) { this.props = props; this.state = { error: null } } }
    class PerfCardBoundary extends PerfCardBase {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      render() {
        if (this.state && this.state.error) {
          return h('div', {
            style: {
              border: '1px solid var(--dsw-alias-state-error-primary, currentColor)', borderRadius: 8,
              padding: '6px 10px', margin: '4px 0', fontSize: 12,
              color: 'var(--dsw-alias-state-error-primary, currentColor)',
            },
          }, `card render failed / 卡片渲染失败：${String(this.state.error?.message ?? this.state.error)}`)
        }
        return this.props.children
      }
    }
    function safePerfCard(Component) {
      return function SafePerfCard(props) { return h(PerfCardBoundary, null, h(Component, props)) }
    }
    const perfNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '?')
    const perfTime = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '?' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    function PerfSparkline({ series }) {
      const values = series.map((p) => p.gpuUsedMiB).filter((v) => typeof v === 'number' && Number.isFinite(v))
      if (values.length < 2) return h('div', { style: { opacity: 0.7, marginTop: 4 } }, '—')
      const min = Math.min(...values)
      const max = Math.max(...values)
      const span = max - min || 1
      const points = values.map((v, i) => {
        const x = (i / (values.length - 1)) * 100
        const y = 22 - ((v - min) / span) * 20
        return `${x.toFixed(1)},${y.toFixed(1)}`
      }).join(' ')
      return h('svg', {
        viewBox: '0 0 100 24', preserveAspectRatio: 'none', role: 'img',
        'aria-label': `GPU VRAM ${min}–${max} MiB`,
        style: { width: '100%', height: 48, marginTop: 4, display: 'block' },
      }, h('polyline', {
        points, fill: 'none', stroke: 'var(--dsw-alias-label-primary, currentColor)',
        strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round', strokeLinecap: 'round',
      }))
    }
    function PerfTrendCard(props) {
      const t = typeof props.t === 'function' ? props.t : (k) => perfZh[k] ?? perfEn[k] ?? k
      const block = props.block ?? {}
      const failed = props.phase === 'result' && block.isError === true
      const running = props.phase !== 'result'
      const meta = props.phase === 'result' && block.meta !== null && typeof block.meta === 'object' ? block.meta : null
      const text = (() => {
        const content = Array.isArray(block.content) ? block.content : []
        return content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n').slice(0, 300)
      })()
      const series = Array.isArray(meta?.series) ? meta.series : []
      const gpu = meta?.gpu ?? null
      const cpu = meta?.cpu ?? null
      const marks = Array.isArray(meta?.marks) ? meta.marks : []
      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1, currentColor)', borderRadius: 8,
          padding: '8px 10px', margin: '4px 0', background: 'var(--dsw-alias-bg-layer-1, transparent)',
          color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 12, lineHeight: 1.5,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('strong', null, t('title')),
          meta ? h('span', { style: { opacity: 0.8 } }, `${perfTime(meta.window?.from)} → ${perfTime(meta.window?.to)}`) : null,
          meta ? h('span', { style: { opacity: 0.7 } }, `${perfNum(meta.window?.tickCount)} ${t('points')}`) : null,
          h('span', { style: { marginLeft: 'auto', color: failed ? 'var(--dsw-alias-state-error-primary, currentColor)' : 'var(--dsw-alias-label-secondary, currentColor)' } },
            running ? t('running') : failed ? '✗' : '✓')),
        running
          ? h('div', { style: { opacity: 0.8, marginTop: 4 } }, t('running'))
          : meta === null
            ? h('div', { style: { opacity: 0.85, marginTop: 4 } }, t('fallback'), text ? h('div', { style: { marginTop: 2, whiteSpace: 'pre-wrap', opacity: 0.8 } }, text) : null)
            : h('div', null,
                h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4, opacity: 0.9 } },
                  gpu ? h('span', null, `${t('gpu')} ${perfNum(gpu.minMiB)}–${perfNum(gpu.maxMiB)} MiB（avg ${perfNum(gpu.avgMiB)}）`) : null,
                  cpu ? h('span', null, `${t('cpu')} avg ${perfNum(cpu.avgPct)}% / max ${perfNum(cpu.maxPct)}%`) : null,
                  meta.memAvailMinMB != null ? h('span', null, `${t('ram')} ${perfNum(meta.memAvailMinMB)} MB`) : null,
                  meta.nonLocalMaxMiB != null ? h('span', { style: { color: meta.nonLocalMaxMiB > 0 ? 'var(--dsw-alias-state-warn-primary, currentColor)' : 'inherit' } }, `${t('shared')} ${perfNum(meta.nonLocalMaxMiB)} MiB`) : null),
                h(PerfSparkline, { series }),
                marks.length > 0
                  ? h('div', { style: { marginTop: 4, opacity: 0.85 } },
                      `${t('marks')}：${marks.map((m) => `#${m.id} ${m.label}`).join('、')}`)
                  : null)
      )
    }

    function SelectRow({ label, hint, value, options, disabled, onEdit }) {
      // SettingsFormModel.field() 返回 { text, overridden, invalid }；下拉只取 text。
      const current = typeof value === 'string' ? value : (value?.text ?? '')
      const known = options.some((o) => o.value === current)
      const opts = known || current === '' ? options : [{ value: current, label: current }, ...options]
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 } },
        h('span', { style: { fontSize: 13 } }, label),
        h('select', {
          value: current,
          disabled,
          onChange: (event) => onEdit(event.target.value),
          style: {
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-l1, currentColor)',
            background: 'var(--dsw-alias-bg-layer-1, inherit)',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontSize: 13,
          },
        }, opts.map((o) => h('option', { key: o.value ?? '', value: o.value ?? '' }, o.label))),
        hint ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } }, hint) : null)
    }

    function ConfigForm(props) {
      const t = typeof props.t === 'function' ? props.t : (k) => en[k] ?? k
      const [assets, setAssets] = React.useState(null)
      const [assetBusy, setAssetBusy] = React.useState('')
      const [assetMessage, setAssetMessage] = React.useState('')
      const [assetFailed, setAssetFailed] = React.useState(false)
      // 下载速度：用相邻两次 status 的 writtenBytes 差值算瞬时速度，再做 EMA 平滑
      const lastSampleRef = React.useRef(null)
      const [assetSpeed, setAssetSpeed] = React.useState(null)
      const [resetMessage, setResetMessage] = React.useState('')
      const [perf, setPerf] = React.useState(null)
      const [perfBusy, setPerfBusy] = React.useState(false)
      const [perfMessage, setPerfMessage] = React.useState('')

      const callSetup = async (body) => {
        const response = await fetch('/api/dsh-imagekit/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` }))
        if (!data.ok) throw new Error(data.message || `HTTP ${response.status}`)
        return data.value
      }
      const refreshAssets = async () => {
        try {
          const value = await callSetup({ action: 'status' })
          setAssets(value)
          // 速度：只在下载中计算；用两次采样的字节差 ÷ 时间差，EMA 平滑（0.4 新值）
          const job = value?.job
          const now = Date.now()
          if (job && job.state === 'running' && Number.isFinite(Number(job.writtenBytes))) {
            const written = Number(job.writtenBytes)
            const prev = lastSampleRef.current
            if (prev !== null && prev.component === job.component && now > prev.at) {
              const inst = (written - prev.bytes) / ((now - prev.at) / 1000)
              if (Number.isFinite(inst) && inst >= 0) {
                setAssetSpeed((old) =>
                  old && Number.isFinite(old.bytesPerSec)
                    ? { bytesPerSec: old.bytesPerSec * 0.6 + inst * 0.4 }
                    : { bytesPerSec: inst }
                )
              }
            }
            lastSampleRef.current = { bytes: written, at: now, component: job.component }
          } else {
            lastSampleRef.current = null
            setAssetSpeed(null)
          }
          // 不在这里清空 assetMessage：长任务期间轮询会把「下载中/失败原因」擦掉
        } catch (error) {
          setAssetMessage(String(error?.message ?? error))
        }
      }
      const callPerf = async (body) => {
        const response = await fetch('/api/dsh-imagekit/perf', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` }))
        if (!data.ok) throw new Error(data.message || `HTTP ${response.status}`)
        return data.value
      }
      const refreshPerf = async () => {
        setPerfBusy(true)
        try {
          const value = await callPerf({ action: 'snapshot' })
          setPerf(value)
          setPerfMessage('')
        } catch (error) {
          setPerfMessage(String(error?.message ?? error))
        } finally {
          setPerfBusy(false)
        }
      }
      React.useEffect(() => { void refreshAssets(); void refreshPerf() }, [])
      React.useEffect(() => {
        if (assetBusy === '') return undefined
        const timer = setInterval(() => { void refreshAssets() }, 1000)
        return () => clearInterval(timer)
      }, [assetBusy])

      const resetDefaults = async () => {
        try {
          const value = await callSetup({ action: 'defaults' })
          const defaults = value?.defaults ?? {}
          for (const key of ['installRoot', 'modelsRoot', 'engineRoot', 'upscaleEnginesRoot', 'outputDir']) {
            if (typeof defaults[key] === 'string' && defaults[key] !== '') props.edit(key, defaults[key])
          }
          setResetMessage(t('resetDone'))
        } catch (error) {
          setResetMessage(String(error?.message ?? error))
        }
      }

      const runAsset = async (action, component, pack) => {
        setAssetBusy(`${component}:${action}`)
        setAssetMessage(t('assetWorking'))
        setAssetFailed(false)
        try {
          const body = { action, component }
          if (pack) body.pack = pack
          if (action === 'delete') body.confirm = component
          const value = await callSetup(body)
          setAssetMessage(value?.message || 'done')
          await refreshAssets()
        } catch (error) {
          setAssetFailed(true)
          setAssetMessage(String(error?.message ?? error))
        } finally {
          setAssetBusy('')
        }
      }

      const state = props.useImagekitConfig((s) => s)
      if (state === null || state === undefined) {
        return h('div', { style: { fontSize: 12, opacity: 0.75 } }, t('tasksHint'))
      }
      const disabled = !state.writable

      const groups = []
      const push = (titleKey, children) => {
        groups.push(h('div', { key: titleKey, style: { marginTop: 14 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 2 } }, t(titleKey)),
          children))
      }

      const storeRows = TEXT_FIELDS
        .filter((f) => f.group === 'group_store')
        .map((f) => h(prim.SettingsValueField, {
          key: f.key,
          id: `imagekit-${f.key}`,
          label: t(f.key),
          hint: t(`${f.key}Hint`),
          placeholder: f.placeholder,
          // 字段值是 { text, overridden, invalid }，按 SettingsValueField 的契约展开；
          // 直接当 value 传入会被 React 当对象子节点渲染（error #31）。
          ...(state[f.key] ?? {}),
          disabled,
          onEdit: (text) => props.edit(f.key, text),
        }))
      push('group_store', [
        ...storeRows,
        h('button', {
          type: 'button',
          onClick: () => void resetDefaults(),
          title: t('resetDefaultsHint'),
          style: { marginTop: 8, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, currentColor)', background: 'transparent', color: 'var(--dsw-alias-label-secondary, inherit)', cursor: 'pointer', fontSize: 12 },
        }, t('resetDefaults')),
        resetMessage ? h('p', { style: { margin: '6px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)' } }, resetMessage) : null,
      ])

      const formatMib = (v) => {
        const n = Number(v)
        if (!Number.isFinite(n)) return '?'
        return n >= 1024 ? `${(n / 1024).toFixed(1)} GiB` : `${Math.round(n)} MiB`
      }
      const perfGpu = perf?.gpu ?? null
      const perfShared = perf?.sysmemFallback ?? null
      const perfProcs = Array.isArray(perf?.gpuProcesses) ? perf.gpuProcesses.slice(0, 6) : []
      const perfSelf = perf?.self ?? null
      push('group_perf', [
        h('p', { style: { margin: '0 0 6px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('perfHint')),
        perfGpu
          ? h('div', { style: { fontSize: 12, lineHeight: 1.7 } },
              h('div', null, h('strong', null, t('perfGpu')), ` ${perfGpu.name ?? ''}`),
              h('div', null,
                `专用显存 ${formatMib(perfGpu.usedMiB)} / ${formatMib(perfGpu.totalMiB)}` +
                  `（${t('perfFree')} ${formatMib(perfGpu.freeMiB)}） · ${t('perfUtil')} ${perfGpu.utilPct ?? '?'}%` +
                  ` · ${t('perfTemp')} ${perfGpu.tempC ?? '?'}°C`),
              h('div', null,
                `${t('perfShared')} ${formatMib(perfShared?.totalSharedMiB)} · `,
                h('span', {
                  style: { color: perfShared?.active ? 'var(--dsw-alias-state-warn-primary, #b26a00)' : 'inherit' },
                }, perfShared?.active ? t('perfFallbackOn') : t('perfFallbackOff'))),
              perfProcs.length
                ? h('div', { style: { marginTop: 2, opacity: 0.85 } },
                    `${t('perfProcesses')}：` +
                      perfProcs.map((p) => `${p.name ?? '?'} ${formatMib(p.localMiB)}${p.nonLocalMiB ? ` + ${formatMib(p.nonLocalMiB)} 共享` : ''}`).join(' · '))
                : null)
          : h('p', { style: { margin: 0, fontSize: 12, opacity: 0.75 } }, perfMessage || t('perfNoData')),
        perfSelf
          ? h('div', { style: { marginTop: 4, fontSize: 11, opacity: 0.7 } },
              `${t('perfSampling')} ${perfSelf.mode ?? '?'} · ${perfSelf.standby ? t('perfStandby') : t('perfRunning')}`)
          : null,
        h('button', {
          type: 'button',
          disabled: perfBusy,
          onClick: () => void refreshPerf(),
          style: { marginTop: 8, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, currentColor)', background: 'transparent', color: 'var(--dsw-alias-label-secondary, inherit)', cursor: perfBusy ? 'default' : 'pointer', fontSize: 12 },
        }, perfBusy ? t('assetWorking') : t('perfRefresh')),
        perfMessage && perfGpu ? h('p', { style: { margin: '6px 0 0', fontSize: 11, color: 'var(--dsw-alias-state-error-primary, currentColor)' } }, perfMessage) : null,
      ])

      push('group_source', [
        h(SelectRow, {
          key: 'modelSource',
          label: t('modelSource'),
          hint: t('modelSourceHint'),
          value: state.modelSource,
          disabled,
          options: SELECT_OPTIONS.modelSource.map((o) => ({ value: o.value, label: t(o.key) })),
          onEdit: (v) => props.edit('modelSource', v),
        }),
        h(prim.SettingsValueField, {
          key: 'modelPackBaseUrl',
          id: 'imagekit-modelPackBaseUrl',
          label: t('modelPackBaseUrl'),
          hint: t('modelPackBaseUrlHint'),
          placeholder: 'https://…',
          ...(state.modelPackBaseUrl ?? {}),
          disabled,
          onEdit: (text) => props.edit('modelPackBaseUrl', text),
        }),
        h(prim.SettingsValueField, {
          key: 'githubProxy',
          id: 'imagekit-githubProxy',
          label: t('githubProxy'),
          hint: t('githubProxyHint'),
          placeholder: 'https://ghfast.top/',
          ...(state.githubProxy ?? {}),
          disabled,
          onEdit: (text) => props.edit('githubProxy', text),
        }),
        h(SelectRow, {
          key: 'upscaleSource',
          label: t('upscaleSource'),
          hint: t('upscaleSourceHint'),
          value: state.upscaleSource,
          disabled,
          options: SELECT_OPTIONS.upscaleSource.map((o) => ({ value: o.value, label: t(o.key) })),
          onEdit: (v) => props.edit('upscaleSource', v),
        }),
      ])

      const formatBytes = (bytes) => {
        const n = Number(bytes ?? 0)
        if (!Number.isFinite(n) || n <= 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let value = n
        let index = 0
        while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
        return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
      }
      const assetLabel = { engine: t('assetEngine'), models: t('assetModels'), upscale: t('assetUpscale') }
      const runBackupDelete = async (component, backupId) => {
        const confirmed = window.confirm(
          t('assetBackupDeleteConfirm') + `\n\n${assetLabel[component] ?? component} · ${backupId}`
        )
        if (!confirmed) return
        setAssetBusy(`${component}:backup`)
        setAssetMessage(t('assetWorking'))
        try {
          const value = await callSetup({ action: 'delete', component, backup: backupId, confirm: component })
          setAssetMessage(value?.message || 'done')
          await refreshAssets()
        } catch (error) {
          setAssetMessage(String(error?.message ?? error))
        } finally {
          setAssetBusy('')
        }
      }
      const smallButton = (disabled) => ({
        padding: '5px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, currentColor)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 12,
      })
      /** 下载进度条：字节级百分比优先，缺字节数时用文件数；done 之后显示「解压中」。 */
      const formatSpeed = (bytesPerSec) => {
        const n = Number(bytesPerSec)
        if (!Number.isFinite(n) || n <= 0) return ''
        return `${formatBytes(n).replace(' B', ' B')}/s`
      }
      const formatEta = (seconds) => {
        const s = Math.round(Number(seconds))
        if (!Number.isFinite(s) || s < 0) return ''
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        const sec = s % 60
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
      }
      const progressBar = (job, label, speed) => {
        if (!job || typeof job !== 'object') return null
        const pct = Number.isFinite(job.percent) ? Math.max(0, Math.min(100, job.percent)) : null
        const downloading = job.state === 'running'
        const written = Number(job.writtenBytes ?? 0)
        const total = Number(job.totalBytes ?? 0)
        const fileText =
          downloading && total > 0
            ? `${formatBytes(written)} / ${formatBytes(total)}`
            : downloading && Number(job.total) > 0
              ? `${job.done ?? 0} / ${job.total}`
              : ''
        const caption = downloading
          ? written === 0 && pct === 0
            ? t('assetJobWaiting')
            : `${t('assetDownloading')}${job.fileLabel ? ` · ${job.fileLabel}` : ''}`
          : job.state === 'done'
            ? t('assetExtracting')
            : ''
        const speedText = downloading && speed && Number(speed.bytesPerSec) > 0 ? formatSpeed(speed.bytesPerSec) : ''
        const remainBytes = downloading && total > 0 ? Math.max(0, total - written) : 0
        const etaText =
          speedText !== '' && remainBytes > 0 ? formatEta(remainBytes / Number(speed.bytesPerSec)) : ''
        const rightText = [pct === null ? '' : `${pct}%`, fileText, speedText, etaText ? `${t('assetEta')} ${etaText}` : '']
          .filter(Boolean)
          .join(' · ')
        return h('div', { style: { marginTop: 6, minWidth: 240 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, marginBottom: 3, color: 'var(--dsw-alias-label-secondary, inherit)' } },
            h('span', null, caption),
            h('span', null, rightText)),
          h('div', {
            role: 'progressbar',
            'aria-valuenow': pct ?? 0,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            title: `${label ?? ''} ${pct === null ? '' : `${pct}%`}`,
            style: {
              position: 'relative',
              height: 7,
              borderRadius: 4,
              overflow: 'hidden',
              background: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.18))',
            },
          },
            h('div', {
              style: {
                position: 'absolute',
                inset: 0,
                width: pct === null ? '100%' : `${pct}%`,
                borderRadius: 4,
                background: job.state === 'done'
                  ? 'var(--dsw-alias-state-success-primary, #2e8b57)'
                  : 'var(--dsw-alias-state-warning-primary, #b26a00)',
                transition: 'width .35s ease',
              },
            })))
      }
      const packLabelOf = (name, fallback) => {
        if (!name) return fallback ?? ''
        const key = `pack_${name}`
        const text = t(key)
        return text === key ? (fallback ?? name) : text
      }
      const jobInfo = assets?.job ?? null
      const assetRows = (assets?.components ?? []).map((row) => {
        const busy = assetBusy.startsWith(`${row.component}:`)
        // 已安装且清单无缺失：下载按钮禁用；仍保留「校验」让用户主动复测。
        const complete = row.installed && row.missing === 0
        const downloadDisabled = !!assetBusy || complete
        const backups = Array.isArray(row.backups) ? row.backups : []
        // autoCheckUpdates=off 时不在详情页提示更新（这个开关之前只是个摆设）
        const updateShown = row.installed && row.updateAvailable && state.autoCheckUpdates !== 'off'
        const runningJob = jobInfo !== null && typeof jobInfo === 'object' && jobInfo.component === row.component ? jobInfo : null
        const jobText =
          runningJob && Number(runningJob.total) > 0 && runningJob.state !== 'done'
            ? ` · ${t('assetJobProgress')} ${runningJob.done ?? 0}/${runningJob.total}`
            : ''
        const versionText = row.installed
          ? `${t('assetInstalled')}${row.installedVersion ? ` v${row.installedVersion}` : ` · ${t('assetVersionUnknown')}`}`
          : t('assetAbsent')
        const manifestText = row.targetVersion ? `${t('assetManifestVersion')} v${row.targetVersion}` : ''
        const buttons = [
          updateShown ? h('button', {
            key: 'upgrade',
            type: 'button',
            disabled: !!assetBusy,
            onClick: () => {
              const message = row.component === 'engine' ? t('assetUpgradeConfirm') : t('assetUpgradeConfirmGeneric')
              if (!window.confirm(`${message}\n\n${assetLabel[row.component] ?? row.component} → v${row.targetVersion}`)) return
              void runAsset('upgrade', row.component)
            },
            title: `${t('assetUpgradeHint')} → v${row.targetVersion}`,
            style: Object.assign(smallButton(!!assetBusy), {
              borderColor: 'var(--dsw-alias-state-warning-primary, #b26a00)',
              color: 'var(--dsw-alias-state-warning-primary, #b26a00)',
            }),
          }, busy && assetBusy.endsWith(':upgrade') ? t('assetWorking') + jobText : t('assetUpgrade')) : null,
          row.component !== 'models' ? h('button', {
            key: 'install',
            type: 'button',
            disabled: downloadDisabled,
            onClick: () => void runAsset('install', row.component),
            title: complete ? t('assetAlreadyInstalled') : '',
            style: Object.assign(smallButton(downloadDisabled), {
              border: '1px solid var(--dsw-alias-border-l1, currentColor)',
              color: 'var(--dsw-alias-label-primary, inherit)',
              opacity: downloadDisabled ? 0.55 : 1,
            }),
          }, busy && assetBusy.endsWith(':install') ? t('assetWorking') : complete ? t('assetInstalled') : t('assetDownload')) : null,
          row.component !== 'models' ? h('button', {
            key: 'verify',
            type: 'button',
            disabled: !!assetBusy,
            onClick: () => void runAsset('verify', row.component),
            title: t('assetVerifyHint'),
            style: smallButton(!!assetBusy),
          }, t('assetVerify')) : null,
          row.installed ? h('button', {
            key: 'delete',
            type: 'button',
            disabled: !!assetBusy,
            onClick: () => {
              const confirmText = row.component === 'models' ? t('assetDeleteAllConfirm') : t('assetDeleteConfirm')
              if (!window.confirm(confirmText + `\n\n${assetLabel[row.component] ?? row.component} · ${formatBytes(row.bytes)}`)) return
              void runAsset('delete', row.component)
            },
            style: Object.assign(smallButton(!!assetBusy), {
              border: '1px solid var(--dsw-alias-state-error-primary, #b44)',
              color: 'var(--dsw-alias-state-error-primary, #b44)',
            }),
          }, t('assetDelete')) : null,
        ]
        const modelPackRows =
          row.component === 'models'
            ? (row.packs ?? []).map((pack) =>
                h('div', {
                  key: pack.name,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '5px 0 5px 14px',
                    fontSize: 12,
                    borderBottom: '1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
                  },
                },
                  h('div', { style: { flex: 1 } },
                    h('strong', null, packLabelOf(pack.name, pack.label)),
                    ` · ${formatBytes(pack.expectedBytes)}`,
                    pack.installed
                      ? ` · ${t('packInstalled')}`
                      : ` · ${t('assetMissing')} ${pack.missing}（${formatBytes(pack.missingBytes)}）`),
                  h('button', {
                    type: 'button',
                    disabled: !!assetBusy || pack.installed,
                    onClick: () => void runAsset('install', 'models', pack.name),
                    style: Object.assign(smallButton(!!assetBusy || pack.installed), {
                      border: '1px solid var(--dsw-alias-border-l1, currentColor)',
                      color: 'var(--dsw-alias-label-primary, inherit)',
                      opacity: !!assetBusy || pack.installed ? 0.55 : 1,
                    }),
                  }, pack.installed
                    ? t('packInstalled')
                    : assetBusy.startsWith('models:install')
                      ? t('assetWorking')
                      : t('packDownload')),
                  h('button', {
                    type: 'button',
                    disabled: !!assetBusy,
                    onClick: () => void runAsset('verify', 'models', pack.name),
                    title: t('assetVerifyHint'),
                    style: smallButton(!!assetBusy),
                  }, t('assetVerify')),
                  jobInfo && jobInfo.component === 'models' && jobInfo.pack === pack.name && jobInfo.state === 'running'
                    ? progressBar(jobInfo, packLabelOf(pack.name, pack.label), assetSpeed)
                    : null,
                  pack.installed
                    ? h('button', {
                        type: 'button',
                        disabled: !!assetBusy,
                        onClick: () => {
                          if (!window.confirm(`${t('assetPackDeleteConfirm')}\n\n${packLabelOf(pack.name, pack.label)}（${formatBytes(pack.expectedBytes)}）`)) return
                          void runAsset('delete', 'models', pack.name)
                        },
                        title: t('assetPackDeleteConfirm'),
                        style: Object.assign(smallButton(!!assetBusy), {
                          border: '1px solid var(--dsw-alias-state-error-primary, #b44)',
                          color: 'var(--dsw-alias-state-error-primary, #b44)',
                        }),
                      }, t('assetPackDelete'))
                    : null))
            : []
        return h('div', { key: row.component, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { flex: 1, minWidth: 220, fontSize: 13 } },
              h('strong', null, assetLabel[row.component] ?? row.component),
              `  ${versionText} · ${formatBytes(row.bytes)}`,
              row.missing ? ` · ${t('assetMissing')} ${row.missing}` : '',
              row.installed && row.updateAvailable && row.targetVersion && state.autoCheckUpdates !== 'off'
                ? h('span', { key: 'update', style: { marginLeft: 8, color: 'var(--dsw-alias-state-warning-primary, #b26a00)' } }, `${t('assetUpdateAvailable')} → v${row.targetVersion}${jobText}`)
                : null,
              !row.installed && manifestText
                ? h('span', { key: 'manifest', style: { marginLeft: 8, opacity: 0.7 } }, manifestText)
                : null),
            ...buttons),
          progressBar(
            jobInfo && typeof jobInfo === 'object' && jobInfo.component === row.component && jobInfo.state !== 'done'
              ? jobInfo
              : null,
            assetLabel[row.component] ?? row.component,
            assetSpeed
          ),
          ...modelPackRows,
          backups.length ? h('div', { style: { marginTop: 4, paddingLeft: 12, fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } },
            h('div', null, `${t('assetBackups')} (${backups.length})`),
            backups.map((backup) => h('div', { key: backup.id, style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 } },
              h('span', { style: { flex: 1 } },
                `v${backup.version ?? '?'} · ${formatBytes(backup.bytes)} · ${backup.files ?? 0} files · ${backup.createdAt ? new Date(backup.createdAt).toLocaleString() : ''}`),
              h('button', {
                type: 'button',
                disabled: !!assetBusy,
                onClick: () => void runBackupDelete(row.component, backup.id),
                style: Object.assign(smallButton(!!assetBusy), {
                  border: '1px solid var(--dsw-alias-state-error-primary, #b44)',
                  color: 'var(--dsw-alias-state-error-primary, #b44)',
                }),
              }, t('assetBackupDelete'))))) : null)
      })
      push('group_assets', [
        h('p', { style: { margin: '0 0 6px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('assetsHint')),
        h('button', {
          type: 'button',
          disabled: !!assetBusy,
          onClick: () => void refreshAssets(),
          style: { marginBottom: 6, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, currentColor)', background: 'transparent', color: 'var(--dsw-alias-label-secondary, inherit)', cursor: assetBusy ? 'default' : 'pointer', fontSize: 12 },
        }, t('assetRefresh')),
        ...(assetRows.length ? assetRows : [h('p', { key: 'idle', style: { margin: 0, fontSize: 12, opacity: 0.7 } }, t('assetIdle'))]),
        assetMessage ? h('pre', { style: { margin: '8px 0 0', whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.5, maxHeight: 160, overflow: 'auto', color: assetFailed ? 'var(--dsw-alias-state-error-primary, #b44)' : 'var(--dsw-alias-label-secondary, inherit)' } }, assetMessage) : null,
      ])

      push('group_behaviour', [
        h(SelectRow, {
          key: 'toolsetProfile',
          label: t('toolsetProfile'),
          hint: t('toolsetProfileHint'),
          value: state.toolsetProfile,
          disabled,
          options: SELECT_OPTIONS.toolsetProfile.map((o) => ({ value: o.value, label: t(o.key) })),
          onEdit: (v) => props.edit('toolsetProfile', v),
        }),
        h(SelectRow, {
          key: 'autoCheckUpdates',
          label: t('autoCheckUpdates'),
          hint: t('autoCheckUpdatesHint'),
          value: state.autoCheckUpdates,
          disabled,
          options: SELECT_OPTIONS.autoCheckUpdates.map((o) => ({ value: o.value, label: t(o.key) })),
          onEdit: (v) => props.edit('autoCheckUpdates', v),
        }),
        h(SelectRow, {
          key: 'keepVersions',
          label: t('keepVersions'),
          hint: t('keepVersionsHint'),
          value: state.keepVersions,
          disabled,
          options: SELECT_OPTIONS.keepVersions.map((o) => ({ value: o.value, label: t(o.key) })),
          onEdit: (v) => props.edit('keepVersions', v),
        }),
        h('p', { style: { marginTop: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary, inherit)' } },
          t('tasksHint')),
      ])

      return h(SettingsForm, {
        labels: {
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        },
        state,
        onSave: props.save,
        onDiscard: props.discard,
      }, groups)
    }

    function ConfigCard(props) {
      if (props.view === 'summary') return props.t ? props.t('summary') : 'Storage, sources and automation'
      if (typeof props.useImagekitConfig !== 'function') {
        return h('div', { style: { fontSize: 12, opacity: 0.75 } }, '图像生成工坊设置正在加载…')
      }
      return h(ConfigForm, props)
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'imagekit: 字典')
        ctx.effect(() => ctx.locale.register(PERF_NS, { zh: perfZh, en: perfEn }), 'imagekit: perf 字典')
        // perf 工具卡：与设置页无关，tool.call.toolview 槽（原 perfmon 能力）
        ctx.effect(
          () =>
            ctx.slots.inject('tool.call.toolview', () =>
              ctx.slots.register(
                { name: 'tool.call.toolview', key: 'perf', locale: PERF_NS },
                safePerfCard(PerfTrendCard)
              )
            ),
          'imagekit: perf 卡片'
        )

        // 不同 DSH 版本的 settings 命名空间可能取包名 / patch id / loader id，
        // 这里做一层代理：优先选择已 ready 的命名空间，并随 mirror 动态发现。
        const BASE_CANDIDATES = ['dsh-imagekit', 'tool-image', 'include:tool-image']
        const controllers = new Map()
        const controllerOf = (ns) => {
          if (!controllers.has(ns)) controllers.set(ns, ctx.configForms.get(ns))
          return controllers.get(ns)
        }
        const discovered = () => {
          try {
            const view = ctx.configForms.describe().getSnapshot().view
            return (view?.namespaces ?? [])
              .map((row) => row.ns)
              .filter((ns) => ns === 'dsh-imagekit' || ns === 'tool-image' || ns === 'include:tool-image')
          } catch { return [] }
        }
        const candidates = () => [...new Set([...discovered(), ...BASE_CANDIDATES])]
        const pick = () => {
          const all = candidates().map(controllerOf)
          return all.find((c) => c.getSnapshot().status === 'ready')
            ?? all.find((c) => c.getSnapshot().status !== 'unavailable')
            ?? all[0]
        }
        const scope = {
          getSnapshot: () => pick().getSnapshot(),
          subscribe: (listener) => {
            const offs = candidates().map((ns) => controllerOf(ns).subscribe(listener))
            return () => { for (const off of offs) off() }
          },
          set: (field, value) => pick().set(field, value),
        }
        const form = new SettingsFormModel(
          scope,
          [
            settingsTextField('outputDir'),
            settingsTextField('installRoot'),
            settingsTextField('modelsRoot'),
            settingsTextField('engineRoot'),
            settingsTextField('upscaleEnginesRoot'),
            settingsTextField('modelSource'),
            settingsTextField('modelPackBaseUrl'),
            settingsTextField('githubProxy'),
            settingsTextField('upscaleSource'),
            settingsTextField('toolsetProfile'),
            settingsTextField('autoDownload'),
            settingsTextField('autoCheckUpdates'),
            settingsTextField('keepVersions'),
          ],
          []
        )
        const projection = () => {
          const out = { ...form.shell() }
          for (const key of FIELDS) out[key] = form.field(key)
          return out
        }
        const store = form.bind(projection)
        ctx.effect(() => () => { form.dispose() }, 'imagekit: 表单模型')

        // dsh-context 同款：在 bundle 详情页注册设置卡。
        // 关键：不要自己往 props 上塞 useImagekitConfig——那会覆盖宿主用 `inject.hooks`
        // 生成的 hook，导致 ConfigCard 永远走“正在加载”分支。
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: 'dsh-imagekit',
                  locale: NS,
                  inject: () => ({ hooks: { imagekitConfig: store }, ...form.actions() }),
                },
                (props) => h(ConfigCard, { ...props, view: 'page' })
              )
            ),
          'imagekit: 配置槽'
        )
      },
    }
  },
})
