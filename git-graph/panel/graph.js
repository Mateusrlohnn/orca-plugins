// Distribui os commits em raias. Recebe em ordem topológica, filhos antes dos pais.
// Uma raia guarda o hash que ela espera encontrar; ela nunca muda de índice enquanto está aberta.
export function layoutGraph(commits) {
  const lanes = []
  const rows = []
  let maxWidth = 0

  const freeLane = () => {
    const free = lanes.indexOf(null)
    if (free >= 0) return free
    lanes.push(null)
    return lanes.length - 1
  }

  for (const commit of commits) {
    const incoming = []
    const passthrough = []
    lanes.forEach((expected, i) => {
      if (expected === commit.hash) incoming.push(i)
      else if (expected) passthrough.push(i)
    })

    const col = incoming.length ? incoming[0] : freeLane()
    for (const i of incoming) lanes[i] = null

    const outgoing = commit.parents.map((parent, index) => {
      let target = lanes.indexOf(parent)
      if (target < 0) {
        target = index === 0 && lanes[col] === null ? col : freeLane()
        lanes[target] = parent
      }
      return target
    })

    maxWidth = Math.max(maxWidth, lanes.length, col + 1)
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({ hash: commit.hash, col, incoming, outgoing, passthrough })
  }

  return { rows, maxWidth }
}

// Com pouco espaço, o mínimo vence o máximo: a seção nunca some.
export function clampPane(value, min, max) {
  return Math.max(min, Math.min(value, max))
}

// Porcelain: X é o stage e Y a pasta de trabalho. Um arquivo "MM" aparece nos dois grupos.
export function splitChanges(files) {
  const staged = []
  const unstaged = []
  for (const file of files) {
    const [x, y] = file.status
    const conflict = x === 'U' || y === 'U' || file.status === 'AA' || file.status === 'DD'
    if (!conflict && x !== ' ' && x !== '?') staged.push(file)
    if (conflict || y !== ' ') unstaged.push(file)
  }
  return { staged, unstaged }
}

// "HEAD -> feature/x, origin/develop, tag: v1" já vem separado; aqui só classifica.
export function classifyRef(ref) {
  if (ref === 'HEAD') return { label: 'HEAD', kind: 'head' }
  if (ref.startsWith('HEAD -> ')) return { label: ref.slice(8), kind: 'head' }
  if (ref.startsWith('tag: ')) return { label: ref.slice(5), kind: 'tag' }
  if (ref.startsWith('origin/') || ref.includes('/HEAD')) return { label: ref, kind: 'remote' }
  return { label: ref, kind: 'local' }
}

export function diffLineKind(line) {
  if (line.startsWith('@@')) return 'hunk'
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line)) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}
