# Plugins do Orca

Plugins do Orca usados pelo time de Tecnologia.

| Plugin | O que faz |
|---|---|
| [`git-graph`](git-graph/) | Source Control no formato do VS Code: arquivos alterados, stage, commit local, grafo de commits e diff em aba |

## Instalar

Precisa do Orca 1.4.246 ou mais novo, com a CLI `orca` no terminal.

1. Clone este repositório:

       git clone https://github.com/Mateusrlohnn/orca-plugins.git

2. Entre na pasta do plugin e carregue no Orca:

       cd orca-plugins/git-graph
       orca plugin dev load .

3. Na primeira vez, o Orca recusa e mostra o que o plugin vai acessar, com o comando de aprovação. Leia e, se concordar, rode o comando que ele mostrar:

       orca plugin dev load . --approve <fingerprint>

4. Abra o painel **Git Graph** na barra lateral direita do Orca.

A pasta precisa continuar no lugar onde foi clonada: o Orca carrega o plugin direto dela.

## Atualizar

    cd orca-plugins
    git pull

O Orca recarrega o plugin sozinho. Se uma versão nova pedir acesso diferente, ele pede aprovação de novo.

## Antes de instalar

- **Acesso:** o plugin roda como `trusted-worker`, com as permissões da sua conta. Ele faz stage, unstage e commit local; nunca faz push, checkout, reset nem descarta alterações.
- **Diff em aba:** para abrir o diff como aba, o plugin chama a CLI do Orca, fora das permissões que declara. Se a chamada falhar, o diff abre no próprio painel.
- **Testado só no Windows.** No Mac ou no Linux, o diff em aba pode não abrir e cair no painel.
- **Commit em `main` e `develop`** é recusado nos repositórios da Otus Engenharia.
- **Dois workspaces com o mesmo nome na mesma branch:** o painel recusa e pede para renomear um deles, porque o Orca não informa qual está em foco.
- Só funciona em workspaces locais, não em SSH.
