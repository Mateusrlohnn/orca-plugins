import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { clampPane, classifyRef, diffLineKind, layoutGraph, splitChanges } from '../panel/graph.js'
import { commitBlockReason, createCommit, isProtectedBranch, openDiffTab, stagePaths, unstagePaths } from './git'
import { isHash, isSafePath, parseLog, parseNameStatus, parseStatus, pickWorkspace } from './parse'

const OTUS = 'https://github.com/Otus-Engenharia/plataformaotus.git'

/** Repositório descartável: nenhum teste de escrita toca um repositório real. */
async function withRepo(branch: string, origin: string | null, run: (dir: string, sh: (...a: string[]) => string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'git-graph-test-'))
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  try {
    sh('init', '-q', '-b', branch)
    sh('config', 'user.name', 'Teste')
    sh('config', 'user.email', 'teste@example.com')
    if (origin) sh('remote', 'add', 'origin', origin)
    writeFileSync(join(dir, 'a.txt'), '1')
    sh('add', '-A')
    sh('commit', '-q', '-m', 'inicial')
    await run(dir, sh)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const rejects = async (work: Promise<unknown>, pattern: RegExp) => {
  let failure: Error | null = null
  await work.catch((error) => { failure = error })
  assert.ok(failure, 'deveria recusar')
  assert.match((failure as unknown as Error).message, pattern)
}

test('acha o workspace em foco e recusa quando não dá para saber qual é', () => {
  const w = (name: string, path: string, branch: string, hostId = 'local') => ({ name, path, branch, hostId })
  const ctx = { displayName: 'main', branch: 'main' }
  assert.equal(pickWorkspace(ctx, [w('main', 'A', 'refs/heads/main'), w('dev', 'B', 'refs/heads/dev')]).path, 'A')
  assert.throws(() => pickWorkspace(ctx, [w('main', 'A', 'refs/heads/main'), w('main', 'B', 'refs/heads/main')]), /mesma branch/)
  assert.throws(() => pickWorkspace(ctx, [w('main', 'A', 'refs/heads/x'), w('main', 'B', 'refs/heads/y')]), /mesma branch/)
  assert.throws(() => pickWorkspace(ctx, [w('main', 'A', 'refs/heads/main', 'ssh-1')]), /SSH/)
  assert.throws(() => pickWorkspace(ctx, [w('outro', 'A', 'refs/heads/main')]), /não encontrado/)
  assert.equal(pickWorkspace(ctx, [w('main', 'A', 'refs/heads/renomeada')]).path, 'A')
})

test('não chama o Orca com caminho perigoso', async () => {
  await rejects(openDiffTab('C:/repo', '--focus', false), /Caminho/)
  await rejects(openDiffTab('C:/repo', '../fora', false), /Caminho/)
  await rejects(openDiffTab('C:/repo', undefined, true), /Caminho/)
})

test('limita o tamanho da seção e o mínimo vence o máximo', () => {
  assert.equal(clampPane(300, 110, 500), 300)
  assert.equal(clampPane(50, 110, 500), 110)
  assert.equal(clampPane(900, 110, 500), 500)
  assert.equal(clampPane(300, 110, 40), 110)
})

test('separa stage de pasta de trabalho', () => {
  const f = (status: string) => ({ status, path: status })
  const { staged, unstaged } = splitChanges([f('M '), f(' M'), f('MM'), f('??'), f('UU'), f('R ')])
  assert.deepEqual(staged.map((x) => x.status), ['M ', 'MM', 'R '])
  assert.deepEqual(unstaged.map((x) => x.status), [' M', 'MM', '??', 'UU'])
})

test('protege main e develop só nos repositórios da Otus', () => {
  assert.equal(isProtectedBranch(OTUS, 'develop'), true)
  assert.equal(isProtectedBranch(OTUS, 'main'), true)
  assert.equal(isProtectedBranch(OTUS, 'feature/x'), false)
  assert.equal(isProtectedBranch('https://github.com/outro/jogo.git', 'main'), false)
  assert.equal(isProtectedBranch('', 'main'), false)
})

test('commit só do que está em stage, sem levar o resto', async () => {
  await withRepo('feature/x', OTUS, async (dir, sh) => {
    writeFileSync(join(dir, 'a.txt'), '2')
    writeFileSync(join(dir, 'b.txt'), 'novo')
    await stagePaths(dir, ['a.txt'])
    const { branch } = await createCommit(dir, { message: 'só a', expectedBranch: 'feature/x' })
    assert.equal(branch, 'feature/x')
    assert.equal(sh('show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt')
    assert.match(sh('status', '--porcelain'), /\?\? b\.txt/)
  })
})

test('commit tudo inclui arquivo novo', async () => {
  await withRepo('feature/x', OTUS, async (dir, sh) => {
    writeFileSync(join(dir, 'b.txt'), 'novo')
    await createCommit(dir, { message: 'tudo', all: true, expectedBranch: 'feature/x' })
    assert.equal(sh('status', '--porcelain').trim(), '')
  })
})

test('unstage não mexe no arquivo', async () => {
  await withRepo('feature/x', null, async (dir, sh) => {
    writeFileSync(join(dir, 'a.txt'), '2')
    await stagePaths(dir, ['a.txt'])
    await unstagePaths(dir, ['a.txt'])
    assert.equal(sh('status', '--porcelain').trim(), 'M a.txt')
  })
})

test('recusa commit em develop e main da Otus', async () => {
  for (const branch of ['develop', 'main']) {
    await withRepo(branch, OTUS, async (dir, sh) => {
      const before = sh('rev-parse', 'HEAD')
      writeFileSync(join(dir, 'a.txt'), '2')
      await rejects(createCommit(dir, { message: 'x', all: true, expectedBranch: branch }), /bloqueado/)
      assert.equal(sh('rev-parse', 'HEAD'), before)
      assert.equal(sh('status', '--porcelain').trim(), 'M a.txt')
    })
  }
})

test('permite main em repositório de fora da Otus', async () => {
  await withRepo('main', 'https://github.com/outro/jogo.git', async (dir) => {
    writeFileSync(join(dir, 'a.txt'), '2')
    await createCommit(dir, { message: 'x', all: true, expectedBranch: 'main' })
    assert.equal(await commitBlockReason(dir), null)
  })
})

test('recusa mensagem vazia, branch trocada, HEAD destacado e caminho perigoso', async () => {
  await withRepo('feature/x', null, async (dir, sh) => {
    writeFileSync(join(dir, 'a.txt'), '2')
    await rejects(createCommit(dir, { message: '   ', all: true, expectedBranch: 'feature/x' }), /mensagem/)
    await rejects(createCommit(dir, { message: 'x', all: true, expectedBranch: 'outra' }), /branch mudou/)
    await rejects(stagePaths(dir, ['../fora']), /Caminho/)
    await rejects(stagePaths(dir, ['--all']), /Caminho/)
    await rejects(stagePaths(dir, []), /Caminho/)
    sh('checkout', '-q', '--detach')
    await rejects(createCommit(dir, { message: 'x', all: true, expectedBranch: '' }), /destacado/)
    assert.equal(sh('status', '--porcelain').trim(), 'M a.txt')
  })
})

const c = (hash: string, ...parents: string[]) => ({ hash, parents })

test('história linear fica em uma raia', () => {
  const { rows, maxWidth } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0])
  assert.equal(maxWidth, 1)
})

test('merge abre raia para o segundo pai e fecha quando os ramos se encontram', () => {
  const { rows } = layoutGraph([c('m', 'a', 'b'), c('b', 'r'), c('a', 'r'), c('r')])
  assert.equal(rows[0].col, 0)
  assert.deepEqual(rows[0].outgoing, [0, 1])
  assert.equal(rows[1].col, 1)
  assert.deepEqual(rows[1].passthrough, [0])
  // 'a' encontra a raia que já espera 'r' e deixa a própria livre, mantendo o grafo estreito.
  assert.equal(rows[2].col, 0)
  assert.deepEqual(rows[2].outgoing, [1])
  assert.deepEqual(rows[3].incoming, [1])
  assert.equal(rows[3].col, 1)
  assert.deepEqual(rows[3].passthrough, [])
})

test('dois ramos com a mesma ponta usam raias próprias', () => {
  const { rows } = layoutGraph([c('x', 'r'), c('y', 'r'), c('r')])
  assert.equal(rows[0].col, 0)
  assert.equal(rows[1].col, 1)
  assert.deepEqual(rows[1].outgoing, [0])
})

test('raia liberada é reaproveitada', () => {
  const { rows } = layoutGraph([c('x', 'p'), c('p'), c('z')])
  assert.equal(rows[2].col, 0)
})

test('lê o log com refs e assunto vazio', () => {
  const [one, two] = parseLog(
    'aaa\x1fbbb ccc\x1fHEAD -> main, tag: v1\x1fAna\x1f100\x1fmsg\x1e\nbbb\x1f\x1f\x1fBia\x1f50\x1f\x1e\n'
  )
  assert.deepEqual(one.parents, ['bbb', 'ccc'])
  assert.deepEqual(one.refs, ['HEAD -> main', 'tag: v1'])
  assert.deepEqual(two.parents, [])
  assert.equal(two.subject, '')
})

test('lê status com renomeado e não rastreado', () => {
  assert.deepEqual(parseStatus(' M a b.js\0R  novo.js\0velho.js\0?? pasta/x.js\0'), [
    { status: ' M', path: 'a b.js' },
    { status: 'R ', path: 'novo.js', oldPath: 'velho.js' },
    { status: '??', path: 'pasta/x.js' }
  ])
})

test('lê name-status com renomeado', () => {
  assert.deepEqual(parseNameStatus('M\0a.js\0R100\0velho.js\0novo.js\0D\0c.js\0'), [
    { status: 'M', path: 'a.js' },
    { status: 'R', oldPath: 'velho.js', path: 'novo.js' },
    { status: 'D', path: 'c.js' }
  ])
})

test('recusa hash e caminho perigosos', () => {
  assert.equal(isHash('--output=x'), false)
  assert.equal(isHash('abc1234'), true)
  for (const bad of ['', '-x', '--output=a', '/etc/passwd', '\\\\srv\\x', 'C:\\a', '../a', 'a/../../b', 'a\\..\\b']) {
    assert.equal(isSafePath(bad), false, bad)
  }
  assert.equal(isSafePath('frontend/src/a b.js'), true)
})

test('classifica refs e linhas de diff', () => {
  assert.deepEqual(classifyRef('HEAD -> main'), { label: 'main', kind: 'head' })
  assert.deepEqual(classifyRef('tag: v1'), { label: 'v1', kind: 'tag' })
  assert.equal(classifyRef('origin/develop').kind, 'remote')
  assert.equal(classifyRef('main').kind, 'local')
  assert.equal(diffLineKind('+++ b/a.js'), 'meta')
  assert.equal(diffLineKind('+novo'), 'add')
  assert.equal(diffLineKind('-velho'), 'del')
  assert.equal(diffLineKind('@@ -1 +1 @@'), 'hunk')
  assert.equal(diffLineKind(' igual'), 'ctx')
})
