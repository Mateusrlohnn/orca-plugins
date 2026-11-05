# Git Graph para o Orca

Painel lateral do workspace em foco, no formato do Source Control do VS Code:

- **Changes:** arquivos alterados, stage e unstage, mensagem e commit local;
- **Graph:** grafo de commits, com branches e tags;
- detalhe de cada commit e diff de cada arquivo. O arquivo alterado abre como aba do Orca; o arquivo de um commit abre no painel.

As únicas escritas ficam em `src/git.ts`: stage, unstage e commit local. O plugin nunca faz push,
checkout, reset de arquivo nem descarta alterações. Commit direto em `main` e `develop` é recusado
nos repositórios da Otus Engenharia. Só funciona em workspaces locais.

## Desenvolvimento

    orca plugin test . --json
    orca plugin dev watch . --check --json
