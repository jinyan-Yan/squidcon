'use strict'

/* ------------------------------------------------------------------
 * 渲染进程:只管界面和交互。
 * 真碰文件和 sharp 的活全在主进程,通过 window.forge 调用。
 *
 * 一屏分两块:
 *   左「参考台」 —— 当前参考图,样式就是从这里读的
 *   右「结果列」 —— 其余每张图标一张卡,原图 → 套用后并排
 * ------------------------------------------------------------------ */

const state = {
  items: [], // { id, name, kind, svg, bytes, origUrl, result, resultUrl, error, processing, outSize, format }
  referenceId: null,
  pinnedId: null, // 被点中置顶的那张卡
}

const SIZE_OPTIONS = [128, 256, 512, 1024]

let uidSeed = 0
const uid = () => `f${++uidSeed}`
const $ = (id) => document.getElementById(id)

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const isSvgName = (name) => /\.svg$/i.test(name)
const IMAGE_EXT = /\.(svg|png|jpe?g|webp)$/i

const referenceItem = () => state.items.find((i) => i.id === state.referenceId) || null
const targets = () => state.items.filter((i) => i.id !== state.referenceId)

/* ------------------------------------------------------------------
 * 载入
 * ------------------------------------------------------------------ */

async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => IMAGE_EXT.test(f.name))
  if (files.length === 0) return

  const entries = []
  for (const file of files) {
    if (isSvgName(file.name)) {
      entries.push({ name: file.name, svg: await file.text() })
    } else {
      entries.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
    }
  }
  ingest(entries)
}

/** 统一入口:entries = [{ name, svg } | { name, bytes }] */
async function ingest(entries) {
  if (entries.length === 0) return

  let firstNew = null
  for (const entry of entries) {
    const kind = entry.svg != null ? 'svg' : 'raster'
    const blob = kind === 'svg' ? new Blob([entry.svg], { type: 'image/svg+xml' }) : null
    const item = {
      id: uid(),
      name: entry.name,
      kind,
      svg: entry.svg || null,
      bytes: entry.bytes || null,
      origUrl: URL.createObjectURL(blob || new Blob([entry.bytes], { type: 'image/png' })),
      result: null,
      resultUrl: null,
      error: null,
      processing: true,
      outSize: 512,
      // 位图变不成矢量,只能出 PNG
      format: kind === 'svg' ? 'svg' : 'png',
    }
    state.items.push(item)
    if (!firstNew) firstNew = item
  }

  // 第一张自动当参考,省得用户每次都要点一下
  if (!state.referenceId) state.referenceId = firstNew.id

  renderAll()
  await Promise.all(state.items.map(convertItem))
}

/* ------------------------------------------------------------------
 * 转换
 * ------------------------------------------------------------------ */

function inputOf(item) {
  return item.kind === 'svg' ? { svg: item.svg } : { bytes: item.bytes }
}

async function convertItem(item) {
  item.processing = true
  const ref = referenceItem()

  const res = await window.forge.convert({
    target: inputOf(item),
    reference: ref ? inputOf(ref) : null,
    // 带上 id,主进程按它缓存结构探测结果,换参考时不用重新量图
    targetKey: item.id,
    referenceKey: ref ? ref.id : null,
    outSize: item.outSize,
    format: item.format,
  })

  if (res.ok) {
    item.error = null
    item.result = res
    // 管线可能降级(比如选了 SVG 但源图带不透明画布),以实际产物为准
    if (res.format !== item.format) item.format = res.format
    if (item.resultUrl && item.resultUrl.startsWith('blob:')) URL.revokeObjectURL(item.resultUrl)
    item.resultUrl =
      res.format === 'svg'
        ? URL.createObjectURL(new Blob([res.svg], { type: 'image/svg+xml' }))
        : `data:image/png;base64,${res.pngBase64}`
  } else {
    item.result = null
    item.error = res.message
    if (item.resultUrl && item.resultUrl.startsWith('blob:')) URL.revokeObjectURL(item.resultUrl)
    item.resultUrl = null
  }

  item.processing = false

  // 只替换这一张卡,不整屏重绘 —— 否则每次转换完所有图都会闪一下
  if (item.id === state.referenceId) {
    renderReference()
  } else {
    updateResultCard(item)
  }
  updateExportAll()
}

/* ------------------------------------------------------------------
 * 渲染:左参考台
 * ------------------------------------------------------------------ */

function structureLine(report) {
  if (!report) return '正在分析…'
  const s = report.source
  const parts = [s.canvasTransparent ? '透明画布' : '实色画布']
  parts.push(s.hasTile ? `底板 ${s.tileColor}` : '无底板')
  return parts.join(' · ')
}

function formatSelect(item) {
  // 位图变不成矢量,只给 PNG
  const options = item.kind === 'svg' ? ['svg', 'png'] : ['png']
  return `<select class="mini-select" data-action="format" data-id="${item.id}">${options
    .map((f) => `<option value="${f}"${item.format === f ? ' selected' : ''}>${f.toUpperCase()}</option>`)
    .join('')}</select>`
}

function sizeSelect(item) {
  return `<select class="mini-select" data-action="size" data-id="${item.id}">${SIZE_OPTIONS.map(
    (s) => `<option value="${s}"${item.outSize === s ? ' selected' : ''}>${s} px</option>`
  ).join('')}</select>`
}

/** 每张卡底部:格式 / 尺寸 / 导出 —— 每张图各自独立 */
function cardFoot(item) {
  return `
    <div class="card-foot">
      ${formatSelect(item)}
      ${sizeSelect(item)}
      <button class="btn btn-secondary btn-small" data-action="export" data-id="${item.id}" ${
        item.result ? '' : 'disabled'
      }>导出</button>
    </div>
  `
}

function renderReference() {
  const panel = $('reference-panel')
  const ref = referenceItem()

  if (!ref) {
    panel.innerHTML = ''
    return
  }

  // 换位动画期间不重建,否则动画会被打断
  const current = panel.querySelector('.ref-card')
  if (current && current.dataset.animating === '1') {
    setTimeout(renderReference, 120)
    return
  }

  const report = ref.result && ref.result.report
  const ratio = report ? (report.source.contentRatio * 100).toFixed(1) + '%' : '—'
  const preview = ref.origUrl

  panel.innerHTML = `
    <article class="card ref-card" data-card="${ref.id}">
      <div class="card-strip strip-blue"></div>
      <div class="card-body">
        <div class="card-head">
          <div class="head-text">
            <h2 class="card-title">${escapeHtml(ref.name)}</h2>
            <p class="caption">${escapeHtml(structureLine(report))}</p>
          </div>
          <div class="card-actions">
            <span class="tag">参考</span>
            <button class="btn-text" data-action="remove" data-id="${ref.id}">删除</button>
          </div>
        </div>

        <div class="ref-preview"><img alt="" src="${preview}" /></div>

        <div class="size-row">
          <div class="size-cell"><img alt="" class="size-48" src="${preview}" /><span>48</span></div>
          <div class="size-cell"><img alt="" class="size-24" src="${preview}" /><span>24</span></div>
        </div>

        <div class="stat">
          <span class="stat-value">${ratio}</span>
          <span class="stat-label">主内容占画布</span>
        </div>

        ${cardFoot(ref)}
      </div>
    </article>
  `
}

/* ------------------------------------------------------------------
 * 渲染:右结果列
 * ------------------------------------------------------------------ */

function skeleton(cls) {
  return `<div class="skeleton ${cls}"></div>`
}

function sideHtml(label, imgUrl, extra) {
  const img = (cls) => (imgUrl ? `<img alt="" class="${cls}" src="${imgUrl}" />` : skeleton(cls))

  return `
    <div class="side">
      <span class="side-label">${label}</span>
      <div class="preview-box">${img('size-72')}</div>
      <div class="mini-row">
        <div class="mini">${img('size-48')}<span>48</span></div>
        <div class="mini">${img('size-24')}<span>24</span></div>
      </div>
      ${extra || ''}
    </div>
  `
}

function resultCardHtml(item) {
  const report = item.result && item.result.report

  const before = report ? (report.source.contentRatio * 100).toFixed(1) + '%' : '—'
  const after = report ? (report.applied.contentRatio * 100).toFixed(1) + '%' : '—'

  const head = `
    <div class="card-head">
      <div class="head-text">
        <h3 class="card-title">${escapeHtml(item.name)}</h3>
        <p class="caption">${escapeHtml(structureLine(report))}</p>
      </div>
      <div class="card-actions">
        <button class="btn btn-ghost" data-action="set-ref" data-id="${item.id}">设为参考</button>
        <button class="btn-text" data-action="remove" data-id="${item.id}">删除</button>
      </div>
    </div>
  `

  if (item.error) {
    return `
      <article class="card result-card" data-card="${item.id}">
        <div class="card-strip strip-mint"></div>
        <div class="card-body">
          ${head}
          <p class="hint is-error">处理失败:${escapeHtml(item.error)}</p>
        </div>
      </article>
    `
  }

  return `
    <article class="card result-card" data-card="${item.id}">
      <div class="card-strip strip-mint"></div>
      <div class="card-body">
        ${head}
        <div class="card-main">
          <div class="compare">
            ${sideHtml('原图', item.origUrl)}
            <div class="arrow">→</div>
            ${sideHtml('套用后', item.resultUrl)}
          </div>
          <div class="ratio-panel">
            <div class="ratio-values">
              <span class="ratio-before">${before}</span>
              <span class="ratio-arrow">→</span>
              <span class="ratio-after">${after}</span>
            </div>
            <span class="ratio-note">主内容占画布</span>
          </div>
        </div>
        ${cardFoot(item)}
      </div>
    </article>
  `
}

function renderResults() {
  const box = $('results')
  const list = targets()

  if (list.length === 0) {
    box.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">再拖入其它图标</p>
      </div>
    `
    return
  }

  box.innerHTML = list.map(resultCardHtml).join('')
  applyPinned()
  syncOverlap()
}

/** 压叠量 = 卡片高度的一半。卡片高度由内容决定,只能渲染后量 */
function syncOverlap() {
  const card = document.querySelector('.result-card')
  if (!card || !card.offsetHeight) return
  $('results').style.setProperty('--overlap', `${Math.round(card.offsetHeight / 2)}px`)
}

/** 只有一张卡能置顶 */
function applyPinned() {
  document.querySelectorAll('.card').forEach((el) => {
    el.classList.toggle('is-pinned', Boolean(state.pinnedId) && el.dataset.card === state.pinnedId)
  })
}

function updateResultCard(item) {
  const existing = document.querySelector(`[data-card="${item.id}"]`)
  if (!existing) {
    renderResults()
    return
  }
  // 正在做换位动画的卡片先不替换,等动画走完再刷
  if (existing.dataset.animating === '1') {
    setTimeout(() => updateResultCard(item), 120)
    return
  }
  const holder = document.createElement('div')
  holder.innerHTML = resultCardHtml(item)
  existing.replaceWith(holder.firstElementChild)
  applyPinned() // 卡片换了新节点,置顶状态要重新贴回去
  syncOverlap() // 内容变了高度可能跟着变,压叠量要重算
}

let wasEmpty = true

function renderAll() {
  // 没有图标时拖入区居中;载入后它滑到左上角常驻,工作台从中间散开
  const isEmpty = state.items.length === 0
  const intro = wasEmpty && !isEmpty
  const stage = $('stage')
  const workbench = $('workbench')

  stage.classList.toggle('is-empty', isEmpty)
  stage.classList.toggle('is-loaded', !isEmpty)
  $('controls').hidden = isEmpty
  workbench.hidden = isEmpty

  renderReference()
  renderResults()

  if (intro) {
    // 卡片逐张落位,差值靠 animationDelay,不用 inline style 属性
    workbench.classList.add('intro')
    workbench.querySelectorAll('.card').forEach((el, i) => {
      el.style.animationDelay = `${i * 70}ms`
    })
    setTimeout(() => {
      workbench.classList.remove('intro')
      workbench.querySelectorAll('.card').forEach((el) => {
        el.style.animationDelay = ''
      })
    }, 1200)
  }

  wasEmpty = isEmpty
  updateExportAll()
}

/* ------------------------------------------------------------------
 * 交互
 * ------------------------------------------------------------------ */

function setReference(id) {
  if (state.referenceId === id) return

  // 换位动画:先记下两张卡的旧位置
  const oldRefId = state.referenceId
  const before = new Map()
  for (const iid of [oldRefId, id]) {
    if (!iid) continue
    const el = document.querySelector(`[data-card="${iid}"]`)
    if (el) before.set(iid, el.getBoundingClientRect())
  }

  state.referenceId = id

  // 不清旧结果 —— 换位动画期间卡片要保持有内容,清掉会变成一片空白骨架。
  // 重算完成时 updateResultCard 会把它们换掉。
  renderAll()

  // FLIP:让新生成的卡从对方面前的位置滑回自己的位置,视觉上就是两张卡交换
  for (const [iid, rect] of before) {
    const el = document.querySelector(`[data-card="${iid}"]`)
    if (!el) continue
    const after = el.getBoundingClientRect()
    const dx = rect.left - after.left
    const dy = rect.top - after.top
    if (!dx && !dy) continue

    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
    el.style.opacity = '0.65'
    void el.offsetHeight // 强制回流,否则下面的过渡不生效

    // 动画期间标记住,这期间不让卡片被重绘替换,否则动画断在半路
    el.dataset.animating = '1'
    setTimeout(() => delete el.dataset.animating, 520)

    requestAnimationFrame(() => {
      el.style.transition =
        'transform 460ms var(--ease-out), opacity 300ms var(--ease-out), box-shadow 220ms var(--ease-out)'
      el.style.transform = ''
      el.style.opacity = ''
    })
  }

  // 立刻开算。探测结果有缓存,通常几十毫秒就回来;
  // 卡片本身在动画期间不会被替换,结果先存着,等动画结束再刷进 DOM
  Promise.all(state.items.map(convertItem))
}

function removeItem(id) {
  const el = document.querySelector(`[data-card="${id}"]`)
  if (!el) return commitRemove(id)

  let done = false
  const finish = () => {
    if (done) return
    done = true
    commitRemove(id)
  }

  // 用 Web Animations 而不是 CSS 过渡:高度从 auto 收到 0 需要先量出实高,
  // 而 CSS 里写 height:0 又得靠 !important 才压得过内联样式,过渡会被打断。
  const height = el.offsetHeight
  const anim = el.animate(
    [
      { height: `${height}px`, opacity: 1 },
      { height: '0px', opacity: 0 },
    ],
    // 退出用 ease-in:先慢后快,像被抽走;用 ease-out 会一上来就collapse完,像直接消失
    { duration: 320, easing: 'cubic-bezier(0.55, 0, 0.85, 0.35)', fill: 'forwards' }
  )

  anim.finished.then(finish).catch(finish)
  setTimeout(finish, 500) // 兜底
}

function commitRemove(id) {
  const index = state.items.findIndex((i) => i.id === id)
  if (index === -1) return
  const [item] = state.items.splice(index, 1)

  if (item.origUrl) URL.revokeObjectURL(item.origUrl)
  if (item.resultUrl && item.resultUrl.startsWith('blob:')) URL.revokeObjectURL(item.resultUrl)
  if (state.pinnedId === id) state.pinnedId = null

  if (state.referenceId === id) {
    state.referenceId = state.items.length ? state.items[0].id : null
    renderAll()
    Promise.all(state.items.map(convertItem))
    return
  }

  renderAll()
}

/* ------------------------------------------------------------------
 * 导出
 * ------------------------------------------------------------------ */

function filePayloadOf(item) {
  const r = item.result
  return {
    name: item.name,
    format: r.format,
    ...(r.format === 'svg' ? { svg: r.svg } : { pngBase64: r.pngBase64 }),
  }
}

async function exportOne(item) {
  if (!item.result) return
  const res = await window.forge.save(filePayloadOf(item))
  if (res.ok) flashHint(`已导出:${res.path}`)
}

async function exportAll() {
  const ready = state.items.filter((i) => i.result)
  if (ready.length === 0) return
  const res = await window.forge.saveAll({ files: ready.map(filePayloadOf) })
  if (res.ok) flashHint(`已导出 ${res.count} 个文件到 ${res.dir}`)
}

let hintTimer = null
function flashHint(text) {
  // 复用画面上的一个提示位,4 秒后还原
  let slot = document.querySelector('.hint')
  if (!slot) {
    slot = document.createElement('p')
    slot.className = 'hint'
    $('reference-panel').appendChild(slot)
  }
  const original = slot.textContent
  slot.textContent = text
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    slot.textContent = original
  }, 4000)
}

function updateExportAll() {
  $('btn-export-all').disabled = !state.items.some((i) => i.result)
}

/* ------------------------------------------------------------------
 * 事件绑定
 * ------------------------------------------------------------------ */

const dropzone = $('dropzone')
const fileInput = $('file-input')

const openPicker = () => fileInput.click()
dropzone.addEventListener('click', openPicker)

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files)
  fileInput.value = ''
})

// 整个窗口都能接文件,不用非得瞄准那块虚线框
document.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropzone.classList.add('is-over')
})
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropzone.classList.remove('is-over')
})
document.addEventListener('drop', (e) => {
  e.preventDefault()
  dropzone.classList.remove('is-over')
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
})

// 工作台用事件委托,卡片重绘后按钮和下拉依然有效
$('workbench').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]')
  if (!btn) return
  const item = state.items.find((i) => i.id === btn.dataset.id)
  if (!item) return

  if (btn.dataset.action === 'set-ref') setReference(item.id)
  else if (btn.dataset.action === 'export') exportOne(item)
  else if (btn.dataset.action === 'remove') removeItem(item.id)
})

// 点卡片空白处 = 置顶 / 收回;点里面的控件不算
$('workbench').addEventListener('click', (e) => {
  const card = e.target.closest('[data-card]')
  if (!card) return
  if (e.target.closest('button, select, input, a')) return

  const id = card.dataset.card
  state.pinnedId = state.pinnedId === id ? null : id
  applyPinned()
})

// 点空白处收回置顶
document.addEventListener('click', (e) => {
  if (!state.pinnedId) return
  if (e.target.closest('[data-card]')) return
  state.pinnedId = null
  applyPinned()
})

// 每张图各自的格式 / 输出尺寸
$('workbench').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-action]')
  if (!sel) return
  const item = state.items.find((i) => i.id === sel.dataset.id)
  if (!item) return

  if (sel.dataset.action === 'format') item.format = sel.value
  else if (sel.dataset.action === 'size') item.outSize = Number(sel.value)
  else return

  convertItem(item)
})

$('btn-export-all').addEventListener('click', exportAll)

// 命令行传入的文件(资源管理器「打开方式」/ npm start -- xxx.png)
window.forge.onBootFiles((files) => ingest(files))

// 初始状态
renderAll()
