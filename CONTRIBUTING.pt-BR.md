# Contribuindo para o rate-guard

> Languages: [English](./CONTRIBUTING.md) • [Português](./CONTRIBUTING.pt-BR.md)

Obrigado pelo interesse em contribuir! Este documento descreve o processo.

## Setup do ambiente

Pré-requisitos:

- Node.js 20+ (recomendado 22 LTS).
- npm 10+.

Passos:

```bash
# Clone o repo
git clone https://github.com/YOUR_GITHUB_USERNAME/rate-guard.git
cd rate-guard

# Instale as deps
npm install

# Verifique que tudo está verde:
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # node --test com tsx
```

Se algum comando falhar após instalação limpa, isso é um bug — abra uma issue.

## Processo de Pull Request

1. Abra uma issue primeiro para mudanças grandes (>50 linhas de diff ou
   que alteram API pública). Para fixes triviais, pule.
2. Faça um fork e crie um branch feature:
   `git checkout -b feat/minha-feature`.
3. Escreva código seguindo as convenções já presentes no projeto
   (TypeScript strict, ESM, `import type` para tipos, sem tabs).
4. **Adicione ou atualize testes.** Cobertura deve permanecer estável ou
   crescer — cada PR que adiciona comportamento sem teste será rejeitado.
5. Rode `npm run typecheck && npm run lint && npm test` localmente.
6. Commits no estilo [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` nova funcionalidade
   - `fix:` correção de bug
   - `docs:` apenas documentação
   - `refactor:` refatoração sem mudança de comportamento
   - `test:` adição/correção de testes
   - `chore:` tarefas não-funcionais
7. Abra o PR comreferência à issue (ex.: `Closes #42`).

## Checklist do PR

Antes de abrir, garanta que:

- [ ] `npm run typecheck` passa sem erros.
- [ ] `npm run lint` passa sem erros.
- [ ] `npm test` passa todos os testes.
- [ ] Novos comportamentos têm testes novos.
- [ ] Documentação pública (README, `docs/`) atualizada quando aplicável.
- [ ] CHANGELOG.md atualizado em `[Unreleased]` descrevendo a mudança.
- [ ] Sem `console.log` em `src/` (núcleo deve permanecer silencioso;
      `console.*` é permitido apenas em `examples/`).

## Estilo de código

- Indentação: 2 espaços.
- Strings: aspas duplas (`"..."`).
- Sem ponto e vírgula opcional — siga o estilo do arquivo (atualmente usa
  ponto e vírgula no final).
- `import type` para tipos (`verbatimModuleSyntax: true`).
- Sem `any` sem justificativa — prefira `unknown` ou tipo genérico.
- Em arquivos novos, comente apenas o "porquê", não o "o quê".

## Adicionando uma nova feature

Antes de implementar, considere:

1. Ela se encaixa no escopo do `rate-guard`? (anti-429 / fila / rate-limit)
2. Pode ser expressa sem aumentar a API pública desnecessariamente?
3. Tem um modo `opt-in` (default: off / seguro) para não quebrar consumidores
   existentes?

Se sim a tudo, vá em frente. Se não, abra uma issue para discussão.

## Lançamentos

Seguimos SemVer. Categorias:

- **MAJOR**: quebra de API pública.
- **MINOR**: nova feature compatível com versão anterior.
- **PATCH**: correção de bug compatível.

Mantemos o `CHANGELOG.md`em `[Unreleased]` e transferimos para uma nova
seção `[X.Y.Z] - AAAA-MM-DD` no lançamento.
