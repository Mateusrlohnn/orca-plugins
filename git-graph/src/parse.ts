// Interpretação pura da saída do Git. Sem acesso a processo nem a disco, para poder ser testada.

export type Commit = {
  hash: string
  parents: string[]
  refs: string[]
  author: string
  time: number
  subject: string
}

export type ChangedFile = { path: string; oldPath?: string; status: string }

export const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e'

export function parseLog(output: string): Commit[] {
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, refs, author, time, subject] = record.split('\x1f')
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(', ') : [],
        author,
        time: Number(time),
        subject: subject ?? ''
      }
    })
}

/** `git status --porcelain=v1 -z`: renomeado traz o caminho novo e depois o antigo. */
export function parseStatus(output: string): ChangedFile[] {
  const parts = output.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const file: ChangedFile = { status, path: entry.slice(3) }
    if (status[0] === 'R' || status[0] === 'C') file.oldPath = parts[++i]
    files.push(file)
  }
  return files
}

/** `git diff-tree --name-status -z`: renomeado traz o caminho antigo e depois o novo. */
export function parseNameStatus(output: string): ChangedFile[] {
  const parts = output.split('\0').filter(Boolean)
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    if (status[0] === 'R' || status[0] === 'C') {
      files.push({ status: status[0], oldPath: parts[i + 1], path: parts[i + 2] })
      i += 2
    } else {
      files.push({ status, path: parts[++i] })
    }
  }
  return files
}

export type WorkspaceRef = { name: string; path: string; branch: string | null; hostId: string | null }

const stripRef = (branch: string | null | undefined) => (branch ?? '').replace(/^refs\/heads\//, '')

/**
 * O Orca informa nome e branch do workspace em foco, mas não o caminho, e o nome costuma ser a
 * própria branch. Dois projetos em `main` ficam iguais: como o plugin commita, recusa em vez de
 * adivinhar o repositório.
 */
export function pickWorkspace(
  context: { displayName: string; branch: string },
  workspaces: readonly WorkspaceRef[]
): WorkspaceRef {
  const sameName = workspaces.filter((w) => w.name === context.displayName)
  if (!sameName.length) throw new Error(`Workspace "${context.displayName}" não encontrado.`)
  const sameBranch = sameName.filter((w) => stripRef(w.branch) === stripRef(context.branch))
  const candidates = sameBranch.length ? sameBranch : sameName
  if (candidates.length > 1) {
    throw new Error(
      `Há ${candidates.length} workspaces chamados "${context.displayName}" na mesma branch, e o Orca não informa qual está em foco. Renomeie um deles para usar este painel.`
    )
  }
  const [workspace] = candidates
  if (workspace.hostId && workspace.hostId !== 'local') {
    throw new Error('Este painel só funciona em workspaces locais, não em SSH.')
  }
  return workspace
}

const HASH = /^[0-9a-f]{7,64}$/i

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value)
}

/** Caminho relativo dentro do repositório; nunca absoluto, com `..` ou parecendo opção. */
export function isSafePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('-')) return false
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return false
  return !value.split(/[\\/]/).includes('..')
}
