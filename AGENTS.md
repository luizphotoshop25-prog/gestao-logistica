# Gestão Logística — Manual para Agentes

## Leitura obrigatória

Antes de alterações relevantes, leia `AGENTS.md`, `PROJECT_CONTEXT.md` e `ARCHITECTURE.md`, nessa ordem. Depois, leia os módulos envolvidos e seus chamadores. O código é a fonte de verdade.

## Stack e comandos

- Electron + React + TypeScript + Vite; SQLite local via `node:sqlite`.
- `npm run check` valida tipos e sintaxe sem emissão.
- `npm run build` escreve `dist/`; `npm run dev` inicia aplicativo; `npm run capture:ui` escreve perfil/imagens em `work/`; `npm run dist` empacota Windows.
- `node tests/smoke-database.cjs` cria SQLite temporário com fixture sintético; não exige fonte externa.

## Responsabilidades

- `electron/database.cjs`: esquema, fluxo, prazos, transações, backups e escritas SQLite.
- `electron/main.cjs`: lifecycle Electron, IPC e diálogos.
- `electron/preload.cjs` + `src/global.d.ts`: contrato main/renderer; atualize juntos.
- `electron/siwin.cjs`: SIWIN em leitura; preserve o bloqueio de SQL de escrita.
- `electron/thunderbird.cjs`: parsing local Thunderbird; `electron/importer.cjs`: prévia CSV/XLSX.
- `src/App.tsx`: interface e orquestração do fluxo.

## Restrições críticas

- Nunca escrever no SIWIN ou enfraquecer `assertReadOnlyQuery`.
- Nunca acessar Node/filesystem diretamente no renderer; use a API IPC tipada.
- Não criar status concorrente: a etapa é derivada por marcos no backend.
- Preservar prazos de +20/+60 dias, `America/Sao_Paulo`, idempotência de e-mails e preservação da primeira seleção.
- Não remover WAL, backups preventivos, transações, validação de etapa, eventos ou proteção de ações em massa sem análise explícita.
- Não tratar `work/` como dado de produção; contém artefatos de teste/captura.

## Convenções

- Alterações mínimas e focadas; não refatore módulos alheios.
- Para novo IPC, atualizar `main.cjs`, `preload.cjs`, `global.d.ts` e consumidor React de forma compatível.
- Para mudança SQLite, manter evolução compatível na inicialização: não presuma banco vazio.
- Antes de escrever/migrar, planejar backup, transação, rollback, idempotência e efeitos em eventos, filas e dashboard.
- Rode `npm run check` antes de finalizar quando alterar código. Testes que escrevem dados só em ambiente descartável.
- Não execute operações destrutivas Git nem altere dados reais sem solicitação explícita.

## Estado Git

O baseline recuperado está no branch `master`; não assuma que exista remote ou histórico anterior ao baseline.
