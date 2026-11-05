// Execução do Git, sem shell. As únicas escritas do plugin estão aqui: stage, unstage e commit.
// Nada de push, reset de arquivo, checkout ou descarte: alterações nunca são apagadas.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isSafePath } from './parse'

const MAX_BUFFER = 20 * 1024 * 1024
const BASE_ARGS = ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false']
const COMMIT_TIMEOUT_MS = 110_000 // hooks de pre-commit podem demorar
const PROTECTED = new Set(['main', 'develop'])

export type Result = { stdout: string; code: number; stderr: string }

export function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 20_000
): Promise<Result> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, maxBuffer: MAX_BUFFER, timeout, windowsHide: true, signal },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (error && typeof code !== 'number') return reject(error)
        resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 })
      }
    )
  })
}

// No worker, "orca" pelo PATH resolve para o próprio Orca.exe, que não é a CLI: o Windows procura
// primeiro na pasta do executável. A CLI fica em resources/bin da instalação.
function orcaCli(): string {
  const name = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const bundled = join(dirname(process.execPath), 'resources', 'bin', name)
  return existsSync(bundled) ? bundled : 'orca'
}

/** Abre o diff do arquivo como aba do Orca, ao lado do terminal, e leva o foco até ela. */
export function openDiffTab(
  repoPath: string,
  filePath: unknown,
  staged: boolean,
  signal?: AbortSignal
): Promise<void> {
  if (!isSafePath(filePath)) return Promise.reject(new Error('Caminho inválido'))
  const args = ['file', 'diff', filePath, '--worktree', `path:${repoPath}`, '--focus', '--json']
  if (staged) args.push('--staged')
  return new Promise((resolve, reject) => {
    // O Orca limpa o ambiente do worker, e a CLI usa APPDATA para achar o Orca em execução.
    const env = { ...process.env, APPDATA: process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') }
    execFile(orcaCli(), args, { env, timeout: 20_000, windowsHide: true, signal }, (error, stdout) => {
      let reply: { ok?: boolean; error?: { message?: string } } | null = null
      try {
        reply = JSON.parse(stdout)
      } catch {
        // Sem JSON na saída: o erro do processo é a única informação que resta.
      }
      if (reply?.ok) return resolve()
      reject(new Error(reply?.error?.message || error?.message || 'O Orca não abriu o diff'))
    })
  })
}

export async function gitOk(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeout?: number
): Promise<string> {
  const result = await git(cwd, args, signal, timeout)
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git saiu com ${result.code}`)
  }
  return result.stdout
}

/** Branch real do repositório; vazio com HEAD destacado. */
export async function currentBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], signal)
  return result.code === 0 ? result.stdout.trim() : ''
}

/** Nos repositórios da Otus, main e develop nunca recebem commit direto (ver CLAUDE.md do repo). */
export function isProtectedBranch(originUrl: string, branch: string): boolean {
  return /otus-engenharia/i.test(originUrl) && PROTECTED.has(branch)
}

export async function commitBlockReason(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const branch = await currentBranch(cwd, signal)
  if (!branch) return 'HEAD destacado: crie ou troque para uma branch antes de commitar.'
  const origin = await git(cwd, ['remote', 'get-url', 'origin'], signal)
  if (isProtectedBranch(origin.code === 0 ? origin.stdout.trim() : '', branch)) {
    return `Commit direto em ${branch} é bloqueado neste repositório: crie uma branch.`
  }
  return null
}

function safePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || !paths.length || !paths.every(isSafePath)) {
    throw new Error('Caminho inválido')
  }
  return paths as string[]
}

export async function stagePaths(cwd: string, paths: unknown, signal?: AbortSignal): Promise<void> {
  await gitOk(cwd, ['add', '-A', '--', ...safePaths(paths)], signal)
}

export async function unstagePaths(cwd: string, paths: unknown, signal?: AbortSignal): Promise<void> {
  // Só tira do stage: o arquivo no disco não muda.
  await gitOk(cwd, ['reset', '-q', '--', ...safePaths(paths)], signal)
}

export type CommitInput = { message?: unknown; all?: unknown; expectedBranch?: unknown }

/**
 * Commit local, sem push. Com `all`, inclui tudo que aparece em Changes.
 * `expectedBranch` é a branch que o botão mostrava: se mudou, recusa em vez de commitar em outra.
 */
export async function createCommit(
  cwd: string,
  { message, all, expectedBranch }: CommitInput,
  signal?: AbortSignal
): Promise<{ hash: string; branch: string }> {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Escreva a mensagem do commit.')
  const block = await commitBlockReason(cwd, signal)
  if (block) throw new Error(block)
  const branch = await currentBranch(cwd, signal)
  if (branch !== expectedBranch) {
    throw new Error(`A branch mudou para ${branch}. Confira antes de commitar.`)
  }
  if (all === true) await gitOk(cwd, ['add', '-A'], signal)
  await gitOk(cwd, ['commit', '-m', message.trim()], signal, COMMIT_TIMEOUT_MS)
  const hash = (await gitOk(cwd, ['rev-parse', '--short', 'HEAD'], signal)).trim()
  return { hash, branch }
}
