// O repositório vem sempre do workspace em foco, nunca do painel. Leituras ficam aqui; as únicas
// escritas (stage, unstage e commit local) estão em ./git.
import { createHash } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  commitBlockReason,
  createCommit,
  currentBranch,
  git,
  gitOk,
  openDiffTab,
  stagePaths,
  unstagePaths
} from './git'
import {
  isHash,
  isSafePath,
  LOG_FORMAT,
  parseLog,
  parseNameStatus,
  parseStatus,
  pickWorkspace,
  type ChangedFile
} from './parse'

const MAX_DIFF_CHARS = 200_000
const MAX_FILES = 500
const MAX_COMMITS = 3000
const DIFF_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv']

const stripRef = (branch: string | null | undefined) => (branch ?? '').replace(/^refs\/heads\//, '')

async function focusedRepo(orca: OrcaWorkerApi) {
  const context = await orca.host.call('workspace.readContext', {})
  if (!context) return null
  const { workspaces } = await orca.host.call('workspace.list', {})
  const match = pickWorkspace(context, workspaces)
  return { name: match.name, path: match.path, branch: stripRef(context.branch) }
}

async function requireRepo(orca: OrcaWorkerApi): Promise<string> {
  const repo = await focusedRepo(orca)
  if (!repo) throw new Error('Nenhum workspace em foco')
  return repo.path
}

const clip = (text: string) =>
  text.length > MAX_DIFF_CHARS
    ? { diff: text.slice(0, MAX_DIFF_CHARS), truncated: true }
    : { diff: text, truncated: false }

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('repo.status', async (_input, { signal }) => {
    const repo = await focusedRepo(orca)
    if (!repo) return { repo: null, files: [], total: 0, fingerprint: '', commitBlock: null }
    const [status, refs, branch, commitBlock] = await Promise.all([
      gitOk(repo.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
      gitOk(repo.path, ['for-each-ref', '--format=%(objectname) %(refname)'], signal),
      currentBranch(repo.path, signal),
      commitBlockReason(repo.path, signal)
    ])
    const head = await git(repo.path, ['rev-parse', 'HEAD'], signal)
    const files = parseStatus(status)
    return {
      repo: { ...repo, branch },
      commitBlock,
      files: files.slice(0, MAX_FILES),
      total: files.length,
      fingerprint: createHash('sha1').update(head.stdout).update(refs).digest('hex')
    }
  })

  orca.panels.handle('repo.log', async (input, { signal }) => {
    const { all, limit } = (input ?? {}) as { all?: boolean; limit?: number }
    const n = Math.min(Math.max(Number(limit) || 200, 1), MAX_COMMITS)
    const cwd = await requireRepo(orca)
    const scope = all === false ? ['HEAD'] : ['--exclude=refs/stash', '--all']
    const result = await git(
      cwd,
      ['log', '--topo-order', `--format=${LOG_FORMAT}`, '-n', String(n + 1), ...scope],
      signal
    )
    // Repositório sem commit nenhum não é erro: o painel mostra o estado vazio.
    if (result.code !== 0 && !/does not have any commits|bad revision 'HEAD'/.test(result.stderr)) {
      throw new Error(result.stderr.trim())
    }
    const commits = parseLog(result.stdout)
    return { commits: commits.slice(0, n), hasMore: commits.length > n }
  })

  orca.panels.handle('commit.files', async (input, { signal }) => {
    const hash = (input as { hash?: unknown })?.hash
    if (!isHash(hash)) throw new Error('Commit inválido')
    const cwd = await requireRepo(orca)
    const body = await gitOk(cwd, ['show', '-s', '--format=%B', hash], signal)
    const parent = await git(cwd, ['rev-parse', '--verify', '--quiet', `${hash}^1`], signal)
    const range = parent.code === 0 ? [parent.stdout.trim(), hash] : ['--root', hash]
    const names = await gitOk(cwd, ['diff-tree', '-r', '-z', '-M', '--name-status', ...range], signal)
    const files: ChangedFile[] = parseNameStatus(names)
    return { body: body.trim(), files: files.slice(0, MAX_FILES), total: files.length }
  })

  orca.panels.handle('changes.stage', async (input, { signal }) => {
    await stagePaths(await requireRepo(orca), (input as { paths?: unknown })?.paths, signal)
    return { ok: true }
  })

  orca.panels.handle('changes.unstage', async (input, { signal }) => {
    await unstagePaths(await requireRepo(orca), (input as { paths?: unknown })?.paths, signal)
    return { ok: true }
  })

  orca.panels.handle('commit.create', async (input, { signal }) =>
    createCommit(await requireRepo(orca), (input ?? {}) as object, signal)
  )

  orca.panels.handle('file.openTab', async (input, { signal }) => {
    const { path, staged } = (input ?? {}) as { path?: unknown; staged?: unknown }
    await openDiffTab(await requireRepo(orca), path, staged === true, signal)
    return { ok: true }
  })

  orca.panels.handle('file.diff', async (input, { signal }) => {
    const { hash, path, oldPath, untracked } = (input ?? {}) as {
      hash?: unknown
      path?: unknown
      oldPath?: unknown
      untracked?: unknown
    }
    if (!isSafePath(path) || (oldPath !== undefined && !isSafePath(oldPath))) {
      throw new Error('Caminho inválido')
    }
    const paths = typeof oldPath === 'string' ? [oldPath, path] : [path]
    const cwd = await requireRepo(orca)

    if (hash !== undefined) {
      if (!isHash(hash)) throw new Error('Commit inválido')
      const parent = await git(cwd, ['rev-parse', '--verify', '--quiet', `${hash}^1`], signal)
      const args = parent.code === 0
        ? ['diff', ...DIFF_ARGS, '-M', parent.stdout.trim(), hash, '--', ...paths]
        : ['show', ...DIFF_ARGS, '--format=', hash, '--', ...paths]
      return clip(await gitOk(cwd, args, signal))
    }

    if (untracked === true) {
      // --no-index sai com 1 quando há diferença, que é o caso esperado aqui.
      const result = await git(cwd, ['diff', ...DIFF_ARGS, '--no-index', '--', '/dev/null', path], signal)
      if (result.code > 1) throw new Error(result.stderr.trim())
      return clip(result.stdout)
    }

    const result = await git(cwd, ['diff', ...DIFF_ARGS, '-M', 'HEAD', '--', ...paths], signal)
    if (result.code === 0) return clip(result.stdout)
    // Sem HEAD (repositório novo): compara com o índice.
    return clip(await gitOk(cwd, ['diff', ...DIFF_ARGS, '--', ...paths], signal))
  })
}
