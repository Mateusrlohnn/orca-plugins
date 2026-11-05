// Todo texto vindo do Git entra por textContent: mensagem de commit e nome de arquivo não são
// confiáveis. Nada aqui usa innerHTML.
import { clampPane, classifyRef, diffLineKind, layoutGraph, splitChanges } from './graph.js'

const ROW = 36
const LANE = 11
const MAX_LANES = 8
const COLORS = ['#4f8ef7', '#e5734a', '#3fb27f', '#c678dd', '#d4a72c', '#2bb3c0', '#e0559a', '#8a94a6']
const POLL_MS = 8000
const PAGE = 200

const $ = (id) => document.getElementById(id)
const state = {
  all: true,
  limit: PAGE,
  fingerprint: null,
  selectedHash: null,
  selectedFile: null,
  commitFiles: null,
  changesOpen: true,
  graphOpen: true,
  statusBusy: false,
  commitBusy: false,
  branch: '',
  commitBlock: null,
  stagedCount: 0,
  unstagedCount: 0,
  changesKey: null
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'onClick') node.addEventListener('click', value)
    else if (value !== undefined) node.setAttribute(key, value)
  }
  node.append(...children)
  return node
}

const request = (name, input, timeoutMs = 30000) => orca.plugin.request(name, input, { timeoutMs })
const message = (error) => error?.message || String(error)

function errorState(text, retry) {
  return el('div', { class: 'state error' }, text,
    el('button', { class: 'tool', type: 'button', onClick: retry }, 'Tentar de novo'))
}

const skeleton = () => el('div', {}, ...[1, 2, 3].map(() => el('div', { class: 'skeleton' })))

function relativeTime(seconds) {
  const diff = seconds - Date.now() / 1000
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]
  const rtf = new Intl.RelativeTimeFormat(orca.locale || 'pt-BR', { numeric: 'auto', style: 'short' })
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit)
  }
  return rtf.format(0, 'minute')
}

// ---- grafo

const laneX = (lane) => 7 + Math.min(lane, MAX_LANES - 1) * LANE
const laneColor = (lane) => COLORS[lane % COLORS.length]

function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}

function graphCell(row, width) {
  const svg = svgEl('svg', { width, height: ROW, 'aria-hidden': 'true' })
  const mid = ROW / 2
  const path = (d, lane) =>
    svg.append(svgEl('path', { d, fill: 'none', stroke: laneColor(lane), 'stroke-width': 1.5 }))

  for (const lane of row.passthrough) path(`M${laneX(lane)} 0V${ROW}`, lane)
  for (const lane of row.incoming) {
    path(`M${laneX(lane)} 0C${laneX(lane)} ${mid / 2} ${laneX(row.col)} ${mid / 2} ${laneX(row.col)} ${mid}`, lane)
  }
  for (const lane of row.outgoing) {
    path(`M${laneX(row.col)} ${mid}C${laneX(row.col)} ${mid * 1.5} ${laneX(lane)} ${mid * 1.5} ${laneX(lane)} ${ROW}`, lane)
  }
  svg.append(svgEl('circle', { cx: laneX(row.col), cy: mid, r: 3.5, fill: laneColor(row.col) }))
  return svg
}

function commitRow(commit, row, width) {
  const refs = commit.refs.map((ref) => {
    const { label, kind } = classifyRef(ref)
    return el('span', { class: `ref ref-${kind} trunc`, title: label }, label)
  })
  const button = el('button', {
    class: 'commit',
    type: 'button',
    role: 'listitem',
    title: `${commit.subject}\n${commit.hash.slice(0, 9)} · ${commit.author}`,
    'aria-current': commit.hash === state.selectedHash ? 'true' : 'false',
    'data-hash': commit.hash,
    onClick: () => selectCommit(commit)
  },
    graphCell(row, width),
    el('span', { class: 'text' },
      el('span', { class: 'line' }, ...refs, el('span', { class: 'subject trunc' }, commit.subject)),
      el('span', { class: 'line meta muted' },
        el('span', { class: 'trunc' }, `${commit.hash.slice(0, 7)} · ${commit.author} · ${relativeTime(commit.time)}`))))
  return button
}

async function loadGraph() {
  const graph = $('graph')
  if (!graph.childElementCount) graph.replaceChildren(skeleton())
  try {
    const { commits, hasMore } = await request('repo.log', { all: state.all, limit: state.limit })
    if (!commits.length) {
      graph.replaceChildren(el('div', { class: 'state muted' }, 'Este repositório ainda não tem commits.'))
      return
    }
    const { rows, maxWidth } = layoutGraph(commits)
    const width = laneX(Math.min(maxWidth, MAX_LANES) - 1) + 7
    const top = graph.scrollTop
    const items = commits.map((commit, i) => commitRow(commit, rows[i], width))
    if (hasMore) {
      items.push(el('button', {
        class: 'more muted',
        type: 'button',
        onClick: () => { state.limit += PAGE; void loadGraph() }
      }, 'Carregar mais commits'))
    }
    graph.replaceChildren(...items)
    graph.scrollTop = top
  } catch (error) {
    graph.replaceChildren(errorState(message(error), () => void loadGraph()))
  }
}

// ---- arquivos

function fileRow(file, onClick, current) {
  const code = file.status.trim()[0] === '?' ? 'A' : (file.status.trim()[0] || 'M')
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const dir = slash >= 0 ? file.path.slice(0, slash) : ''
  return el('button', {
    class: 'file',
    type: 'button',
    role: 'listitem',
    title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
    'aria-current': current ? 'true' : 'false',
    onClick
  },
    el('span', { class: `st st-${code}`, 'aria-label': `status ${file.status.trim()}` }, code),
    el('span', { class: 'name trunc' }, name),
    el('span', { class: 'dir trunc muted' }, dir))
}

const allPaths = (files) => files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]))

async function changeStage(action, files) {
  setFeedback('')
  try {
    await request(action, { paths: allPaths(files) })
  } catch (error) {
    setFeedback(message(error), 'error')
  }
  await refreshStatus()
}

function actionButton(label, symbol, action, files) {
  return el('button', {
    class: 'file-action',
    type: 'button',
    title: label,
    'aria-label': label,
    onClick: () => void changeStage(action, files)
  }, symbol)
}

function changeRow(file, action, label, symbol) {
  return el('div', { class: 'file-row', role: 'listitem' },
    fileRow(file, () => void selectChange(file, action === 'changes.unstage'), !state.selectedHash && state.selectedFile?.path === file.path),
    actionButton(`${label} ${file.path}`, symbol, action, [file]))
}

function changeGroup(title, files, action, label, symbol, allLabel) {
  if (!files.length) return []
  return [
    el('div', { class: 'group-title' },
      el('span', {}, `${title} (${files.length})`),
      actionButton(allLabel, symbol, action, files)),
    el('div', { role: 'list', 'aria-label': title },
      ...files.map((file) => changeRow(file, action, label, symbol)))
  ]
}

function renderChanges(files, total) {
  $('changes-count').textContent = String(total)
  const { staged, unstaged } = splitChanges(files)
  state.stagedCount = staged.length
  state.unstagedCount = unstaged.length
  renderComposer()

  // A cada 8 s o status volta igual na maioria das vezes: não redesenha para não perder foco.
  const key = JSON.stringify([files, total, state.selectedHash, state.selectedFile?.path])
  if (key === state.changesKey) return
  state.changesKey = key

  const rows = [
    ...changeGroup('Staged', staged, 'changes.unstage', 'Tirar do stage', '−', 'Tirar tudo do stage'),
    ...changeGroup('Changes', unstaged, 'changes.stage', 'Adicionar ao stage', '+', 'Adicionar tudo ao stage')
  ]
  if (!total) rows.push(el('div', { class: 'notice muted' }, 'Nenhuma alteração.'))
  if (total > files.length) {
    rows.push(el('div', { class: 'notice muted' }, `Mostrando ${files.length} de ${total}.`))
  }
  const list = $('changes')
  const top = list.scrollTop
  list.replaceChildren(...rows)
  list.scrollTop = top
}

// ---- commit

function setFeedback(text, kind = '') {
  const box = $('commit-feedback')
  box.textContent = text
  box.className = kind
}

function renderComposer() {
  const input = $('message')
  const button = $('commit')
  const { branch, commitBlock, commitBusy, stagedCount, unstagedCount } = state
  input.placeholder = branch
    ? `Mensagem (Ctrl+Enter para commitar em "${branch}")`
    : 'Mensagem do commit'
  input.disabled = Boolean(commitBlock) || commitBusy

  // Sem nada em stage, o botão diz que leva tudo: nunca commita mais do que está escrito nele.
  const count = stagedCount || unstagedCount
  const label = stagedCount ? `Commit (${stagedCount})` : unstagedCount ? `Commit tudo (${unstagedCount})` : 'Commit'
  button.textContent = commitBusy ? 'Commitando…' : label
  button.title = branch ? `Commit local em ${branch}, sem push` : ''
  button.disabled = commitBusy || Boolean(commitBlock) || !count || !input.value.trim()

  const box = $('commit-feedback')
  if (commitBlock) setFeedback(commitBlock, 'block')
  else if (box.className === 'block') setFeedback('')
}

async function submitCommit() {
  if ($('commit').disabled) return
  state.commitBusy = true
  setFeedback('')
  renderComposer()
  try {
    const { hash, branch } = await request('commit.create', {
      message: $('message').value,
      all: state.stagedCount === 0,
      expectedBranch: state.branch
    }, 120000)
    $('message').value = ''
    setFeedback(`Commit ${hash} criado em ${branch}. Nenhum push foi feito.`)
  } catch (error) {
    setFeedback(message(error), 'error')
  } finally {
    state.commitBusy = false
    await refreshStatus(true)
  }
}

// ---- detalhe

function openDetail(title, body, canGoBack) {
  $('detail').hidden = false
  syncPanes()
  $('detail-title').textContent = title
  $('detail-title').title = title
  $('back').hidden = !canGoBack
  $('detail-body').replaceChildren(body)
  $('detail-body').scrollTop = 0
}

function markCurrent() {
  for (const row of $('graph').querySelectorAll('.commit')) {
    row.setAttribute('aria-current', row.dataset.hash === state.selectedHash ? 'true' : 'false')
  }
}

function closeDetail() {
  $('detail').hidden = true
  syncPanes()
  state.selectedHash = null
  state.selectedFile = null
  state.commitFiles = null
  markCurrent()
}

async function selectCommit(commit) {
  state.selectedHash = commit.hash
  state.selectedFile = null
  state.commitFiles = null
  markCurrent()
  openDetail(`${commit.hash.slice(0, 7)} ${commit.subject}`, skeleton(), false)
  try {
    const answer = await request('commit.files', { hash: commit.hash })
    if (state.selectedHash !== commit.hash) return
    state.commitFiles = { commit, ...answer }
    renderCommitFiles()
  } catch (error) {
    if (state.selectedHash !== commit.hash) return
    openDetail(commit.subject, errorState(message(error), () => void selectCommit(commit)), false)
  }
}

function renderCommitFiles() {
  const { commit, body, files, total } = state.commitFiles
  state.selectedFile = null
  const list = el('div', { role: 'list', 'aria-label': 'Arquivos do commit' },
    ...files.map((file) => fileRow(file, () => void showDiff(file, commit.hash), false)))
  const parts = [el('p', { class: 'message' }, body)]
  if (!files.length) parts.push(el('div', { class: 'state muted' }, 'Nenhum arquivo alterado em relação ao primeiro pai.'))
  parts.push(list)
  if (total > files.length) parts.push(el('div', { class: 'notice muted' }, `Mostrando ${files.length} de ${total}.`))
  openDetail(`${commit.hash.slice(0, 7)} ${commit.subject}`, el('div', {}, ...parts), false)
}

function diffView(diff, truncated) {
  if (!diff.trim()) return el('div', { class: 'state muted' }, 'Sem diferenças para mostrar.')
  const lines = diff.split('\n').map((line) =>
    el('div', { class: `d-${diffLineKind(line)}` }, line))
  const view = el('div', { class: 'diff' }, ...lines)
  return truncated
    ? el('div', {}, el('div', { class: 'notice muted' }, 'Diff muito grande: mostrando só o começo.'), view)
    : view
}

async function showDiff(file, hash) {
  state.selectedFile = file
  const canGoBack = Boolean(hash)
  openDetail(file.path, skeleton(), canGoBack)
  const input = { path: file.path }
  if (file.oldPath) input.oldPath = file.oldPath
  if (hash) input.hash = hash
  else if (file.status.trim() === '??') input.untracked = true
  try {
    const { diff, truncated } = await request('file.diff', input)
    if (state.selectedFile !== file) return
    openDetail(file.path, diffView(diff, truncated), canGoBack)
  } catch (error) {
    if (state.selectedFile !== file) return
    openDetail(file.path, errorState(message(error), () => void showDiff(file, hash)), canGoBack)
  }
}

// O diff abre como aba do Orca, onde cabe. Se o Orca recusar, o painel ainda mostra aqui embaixo.
async function selectChange(file, staged) {
  closeDetail()
  state.changesKey = null
  state.selectedFile = file
  setFeedback('')
  try {
    await request('file.openTab', { path: file.path, staged })
  } catch (error) {
    setFeedback(`Não abriu em aba: ${message(error)}`, 'error')
    void showDiff(file, null)
  }
}

// ---- tamanho das seções

const SIZES_KEY = 'git-graph.sizes'
const MIN_CHANGES = 110
const MIN_DETAIL = 80
const MIN_GRAPH = 60
const KEY_STEP = 16

// O tamanho é só conveniência: se o navegador recusar guardar, o painel segue funcionando.
function loadSizes() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZES_KEY))
    return {
      changes: Number.isFinite(saved?.changes) ? saved.changes : null,
      detail: Number.isFinite(saved?.detail) ? saved.detail : null
    }
  } catch {
    return { changes: null, detail: null }
  }
}

const sizes = loadSizes()

function saveSizes() {
  try {
    localStorage.setItem(SIZES_KEY, JSON.stringify(sizes))
  } catch {
    // sem armazenamento: vale só até fechar o painel
  }
}

function freeHeight() {
  const fixed = [document.querySelector('header'), $('changes-title'), document.querySelector('.graph-title')]
  return document.body.clientHeight - fixed.reduce((sum, node) => sum + node.offsetHeight, 0)
}

function limits(pane) {
  const graph = state.graphOpen ? MIN_GRAPH : 0
  if (pane === 'changes') {
    const detail = $('detail').hidden ? 0 : (sizes.detail ?? MIN_DETAIL)
    return { min: MIN_CHANGES, max: freeHeight() - graph - detail }
  }
  const changes = state.changesOpen ? $('changes-body').offsetHeight : 0
  return { min: MIN_DETAIL, max: freeHeight() - graph - changes }
}

function applySizes() {
  const root = document.documentElement.style
  const set = (name, value) => (value === null ? root.removeProperty(name) : root.setProperty(name, value))
  document.body.classList.toggle('graph-closed', !state.graphOpen)

  if (sizes.changes !== null && state.graphOpen) {
    const { min, max } = limits('changes')
    const height = clampPane(sizes.changes, min, max)
    set('--changes-h', `${height}px`)
    set('--changes-max', 'none')
    $('sash-changes').setAttribute('aria-valuenow', String(Math.round(height)))
  } else {
    set('--changes-h', null)
    set('--changes-max', null)
  }

  if (sizes.detail !== null && !$('detail').hidden) {
    const { min, max } = limits('detail')
    const height = clampPane(sizes.detail, min, max)
    set('--detail-h', `${height}px`)
    set('--detail-flex', 'none')
    $('sash-detail').setAttribute('aria-valuenow', String(Math.round(height)))
  } else {
    set('--detail-h', null)
    set('--detail-flex', null)
  }
}

function syncPanes() {
  $('sash-changes').hidden = !state.changesOpen || !state.graphOpen
  $('sash-detail').hidden = $('detail').hidden || !state.graphOpen
  applySizes()
}

function setSize(pane, value) {
  const { min, max } = limits(pane)
  sizes[pane] = clampPane(value, min, max)
  applySizes()
}

// Arrastar para baixo aumenta Changes, que fica acima da barra, e diminui o detalhe, que fica abaixo.
function bindSash(sash, pane, node, direction) {
  sash.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    sash.setPointerCapture(event.pointerId)
    sash.classList.add('dragging')
    document.body.classList.add('resizing')
    const startY = event.clientY
    const startHeight = node.offsetHeight

    const onMove = (move) => setSize(pane, startHeight + (move.clientY - startY) * direction)
    const onEnd = () => {
      sash.removeEventListener('pointermove', onMove)
      sash.removeEventListener('pointerup', onEnd)
      sash.removeEventListener('pointercancel', onEnd)
      sash.classList.remove('dragging')
      document.body.classList.remove('resizing')
      saveSizes()
    }
    sash.addEventListener('pointermove', onMove)
    sash.addEventListener('pointerup', onEnd)
    sash.addEventListener('pointercancel', onEnd)
  })

  sash.addEventListener('keydown', (event) => {
    const step = { ArrowUp: -KEY_STEP, ArrowDown: KEY_STEP }[event.key]
    if (!step) return
    event.preventDefault()
    setSize(pane, node.offsetHeight + step * direction)
    saveSizes()
  })

  sash.addEventListener('dblclick', () => {
    sizes[pane] = null
    applySizes()
    saveSizes()
  })
}

bindSash($('sash-changes'), 'changes', $('changes-body'), 1)
bindSash($('sash-detail'), 'detail', $('detail'), -1)
new ResizeObserver(applySizes).observe(document.body)
syncPanes()

// ---- atualização

async function refreshStatus(forceGraph = false) {
  if (state.statusBusy) return
  state.statusBusy = true
  try {
    const { repo, files, total, fingerprint, commitBlock } = await request('repo.status')
    if (!repo) {
      $('branch').textContent = 'Nenhum workspace em foco'
      $('changes-count').textContent = '–'
      $('changes').replaceChildren()
      state.branch = ''
      state.commitBlock = 'Abra um workspace para commitar.'
      state.stagedCount = state.unstagedCount = 0
      state.changesKey = null
      renderComposer()
      $('graph').replaceChildren(el('div', { class: 'state muted' }, 'Abra um workspace para ver o grafo.'))
      state.fingerprint = null
      return
    }
    $('branch').textContent = repo.branch || repo.name
    $('branch').title = repo.path
    state.branch = repo.branch
    state.commitBlock = commitBlock
    renderChanges(files, total)
    if (forceGraph || fingerprint !== state.fingerprint) {
      state.fingerprint = fingerprint
      await loadGraph()
    }
  } catch (error) {
    $('changes-count').textContent = '!'
    $('graph').replaceChildren(errorState(message(error), () => void refreshStatus(true)))
    state.fingerprint = null
  } finally {
    state.statusBusy = false
  }
}

$('refresh').addEventListener('click', () => void refreshStatus(true))
$('close').addEventListener('click', closeDetail)
$('back').addEventListener('click', () => { if (state.commitFiles) renderCommitFiles() })
$('scope').addEventListener('click', () => {
  state.all = !state.all
  state.limit = PAGE
  $('scope').setAttribute('aria-pressed', String(state.all))
  $('scope').textContent = state.all ? 'Todas' : 'Só esta'
  void refreshStatus(true)
})
$('changes-title').addEventListener('click', () => {
  state.changesOpen = !state.changesOpen
  $('changes-title').setAttribute('aria-expanded', String(state.changesOpen))
  $('changes-body').hidden = !state.changesOpen
  syncPanes()
})
$('graph-title').addEventListener('click', () => {
  state.graphOpen = !state.graphOpen
  $('graph-title').setAttribute('aria-expanded', String(state.graphOpen))
  $('graph').hidden = !state.graphOpen
  syncPanes()
})
$('message').addEventListener('input', renderComposer)
$('message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void submitCommit()
  }
})
$('commit').addEventListener('click', () => void submitCommit())

orca.on('workspace.changed', () => {
  closeDetail()
  // Mensagem escrita para um workspace não pode acabar commitada em outro.
  $('message').value = ''
  setFeedback('')
  state.changesKey = null
  state.limit = PAGE
  $('graph').replaceChildren()
  void refreshStatus(true)
})

setInterval(() => { if (!document.hidden) void refreshStatus() }, POLL_MS)
void refreshStatus(true)
