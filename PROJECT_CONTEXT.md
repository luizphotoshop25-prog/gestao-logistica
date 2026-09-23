# Contexto do Projeto — Gestão Logística

_Contexto recuperado em 23/09/2026 a partir do código deste diretório. O código é a fonte de verdade._

## Visão geral

Gestão Logística é um aplicativo desktop local para acompanhar pedidos fotográficos da sessão/galeria até a entrega. Centraliza clientes, pedidos, seleção de fotos, tratamento, impressão, etiqueta, remessa, rastreio, anexos e histórico. A versão atual é de usuário único: não há autenticação, autorização por perfil nem serviço web próprio implementados. Perfis citados no `README.md` são planejamento futuro.

## Stack e execução

- Electron 43 no processo principal (`electron/`), React 19 + TypeScript + Vite 8 no renderer (`src/`).
- SQLite via `node:sqlite`; `foreign_keys=ON`, WAL e `synchronous=NORMAL`.
- `mssql` para SIWIN, `exceljs` para CSV/XLSX, leitura do Thunderbird local, Radix/Lucide/Inter na UI.
- `npm run check` verifica tipos e sintaxe; `npm run build` gera `dist/`; `npm run dev` inicia Vite em `127.0.0.1:8090` e Electron; `npm run dist` empacota Windows.
- `ABRIR_GESTAO_LOGISTICA.cmd` é um atalho de inicialização Windows.

## Arquitetura

1. `electron/main.cjs` inicializa banco/integrações, abre a janela e registra IPC.
2. `electron/preload.cjs` fornece uma API controlada em `window.logistica` com `contextBridge`.
3. `src/main.tsx` monta `src/App.tsx`; este concentra a mesa operacional, filtros, ficha, importação e clientes.
4. `electron/database.cjs` contém o esquema, regras de estágio, persistência, transações, histórico e backups.

O banco é criado em `<Electron userData>/GestaoLogistica/gestao-logistica.sqlite3`; os diretórios `backups/` e `comprovantes/` coexistem ali. Não é o banco dentro do repositório.

## Funcionalidades confirmadas

- Listagem, busca global, filtros, ordenação, paginação e dashboard operacional.
- Filas mutuamente exclusivas: “Precisa de mim”, “Aguardando terceiros” e “Alertas”.
- Ficha com abas de resumo, seleção, produção, envio e histórico, além de alerta de edição não salva.
- Ações individuais/em massa para marcos, impressão, etiqueta, remessa, postagem e acompanhamento.
- Clientes, anexos e eventos de histórico.
- Prévia/importação de planilhas CSV e XLSX, com linhas inelegíveis descartadas.
- Sincronização de clientes, pedidos, itens e observações de SIWIN para o SQLite local.
- Leitura de e-mails EPICS do Thunderbird, vinculação por sessão e marcação de seleção conferida/fotos separadas.
- Remessa semanal planejada para a próxima sexta-feira; agrupamento não implica postagem.
- Backup diário e backups preventivos antes de operações sensíveis, incluindo importação.

## Regras confirmadas pelo código

- A etapa é derivada por marcos, sem campo de status concorrente: `sessao_criada → galeria_publicada → aguardando_selecao → em_tratamento → tratamento_concluido → em_impressao → impressoes_recebidas → etiqueta_criada → em_remessa → postado → entregue`.
- `updateMilestone` aceita apenas o próximo marco permitido para a etapa atual, evitando avanço indevido por ação rápida.
- Datas operacionais usam `America/Sao_Paulo`. Seleção finalizada calcula prazo interno em +20 dias e máximo em +60 dias.
- Primeira seleção trazida pelo Thunderbird preenche a data somente se ela estiver ausente; repetições geram histórico e preservam a original.
- Falta de cliente/endereço/rastreio, prazo vencido e prazo em até três dias geram alertas. Histórico não é arquivado automaticamente.
- Ações em massa ignoram etapas incompatíveis e informam itens protegidos.
- Fotos cobradas em itens SIWIN somam `FOTOS_PB + FOTOS_CL` apenas para `VL_TOTAL > 0`; gratuitos ficam visíveis.
- SIWIN rejeita comandos SQL de escrita/DDL/execução. Somente o SQLite local é alterado.

## Dados, integrações e estado

As entidades SQLite são `configuracoes`, `clientes`, `pedidos`, `remessas`, `anexos`, `pedido_itens`, `pedido_observacoes_siwin`, `selecoes_email` e `eventos`. Há evolução compatível de colunas na inicialização, mas não há migrations versionadas.

SIWIN lê `C:\siwin\Siwin-Master\arqini.ini`, consulta SQL Server somente em leitura e espera o executável em `C:\siwin\Siwin-Master\Siwin\Siwin.exe`. Thunderbird é localizado em `%APPDATA%\Thunderbird`; são aceitos e-mails de `nao-responda@epics.com.br` associados a sessões `M<dígitos>`. A preparação de códigos pode escrever em `C:\GerenciadorFotos\lista_formatada.txt` quando acionada.

- Git existe, mas `master` não possui commits, tags, branches nem remote; todos os arquivos de origem estavam não rastreados. Não há histórico Git recuperável.
- `work/` contém perfis Electron, capturas e cópias SQLite de smoke test; `dist/` é build Vite. Não são fonte nem banco de produção.
- As auditorias `AUDITORIA_2026-08-22.md` e `AUDITORIA_FRONTEND_2026-08-23.md` foram preservadas como evidência histórica.
- Em 23/09/2026, `npm run check` passou. Build não foi executado porque altera `dist/`; smoke exige `GESTAO_TEST_SOURCE_DB` e captura visual grava em `work/`, ambos preservados nesta análise.

## Próximos passos recomendados

1. Criar o primeiro commit preservando esta fonte de verdade.
2. Executar smoke de banco somente com cópia SQLite descartável em `GESTAO_TEST_SOURCE_DB`.
3. Validar integrações em ambiente autorizado, sem apontar testes a dados de produção.
4. Antes de mudar dados/esquema, avaliar impacto em prazos, eventos, backup, transações e compatibilidade.

## Baseline de recuperação

- **Data:** 23/09/2026; **commit oficial:** `be1dbe6` (`chore: establish recovered project baseline`) no branch `master`.
- **`npm run check`:** aprovado, sem erros ou warnings relevantes; aproximadamente 152 segundos.
- **Build oficial (`npm run build`):** aprovado; TypeScript e Vite concluíram e escreveram somente o artefato ignorado `dist/`; aproximadamente 279 segundos.
- **Smoke de banco:** passou em cópia SQLite descartável, com fonte aberta em modo somente leitura e alvo temporário. A expectativa de remessa agora acompanha a próxima sexta calculada em `America/Sao_Paulo`; em 23/09/2026, retornou `2026-09-25`.
- **Smoke visual:** aprovado com fixture sintético (`M99999`, `Cliente Teste Visual`) em banco e perfil Electron temporários. O supervisor inicia Vite local, bloqueia IPCs externos/de escrita e tráfego fora de `127.0.0.1:8090`, encerra Electron e remove o perfil temporário. As imagens ficam em `work/` por padrão ou em `GESTAO_CAPTURE_PATH`.
- **Banco real:** não foi aberto para escrita, copiado, migrado ou alterado. A cópia-fonte temporária foi removida após a validação.

## Regras confirmadas pelo código

- A etapa é derivada por marcos, sem campo de status concorrente: `sessao_criada → galeria_publicada → aguardando_selecao → em_tratamento → tratamento_concluido → em_impressao → impressoes_recebidas → etiqueta_criada → em_remessa → postado → entregue`.
- `updateMilestone` aceita apenas o próximo marco permitido para a etapa atual, evitando avanço indevido por ação rápida.
- Datas operacionais usam `America/Sao_Paulo`. Seleção finalizada calcula prazo interno em +20 dias e máximo em +60 dias.
- Primeira seleção trazida pelo Thunderbird preenche a data somente se ela estiver ausente; repetições geram histórico e preservam a original.
- Falta de cliente/endereço/rastreio, prazo vencido e prazo em até três dias geram alertas. Histórico não é arquivado automaticamente.
- Ações em massa ignoram etapas incompatíveis e informam itens protegidos.
- Fotos cobradas em itens SIWIN somam `FOTOS_PB + FOTOS_CL` apenas para `VL_TOTAL > 0`; gratuitos ficam visíveis.
- SIWIN rejeita comandos SQL de escrita/DDL/execução. Somente o SQLite local é alterado.

## Dados e integrações

Entidades SQLite: `configuracoes`, `clientes`, `pedidos`, `remessas`, `anexos`, `pedido_itens`, `pedido_observacoes_siwin`, `selecoes_email` e `eventos`. Há evolução compatível de colunas na inicialização, mas não há migrations versionadas.

SIWIN lê `C:\siwin\Siwin-Master\arqini.ini`, espera o executável em `C:\siwin\Siwin-Master\Siwin\Siwin.exe` e consulta SQL Server em modo leitura. Thunderbird é localizado em `%APPDATA%\Thunderbird`; mensagens elegíveis vêm de `nao-responda@epics.com.br`, reconhecem sessão `M<dígitos>` e têm assunto de finalização. A preparação de códigos pode escrever em `C:\GerenciadorFotos\lista_formatada.txt` quando acionada.

## Estado atual e riscos

- Git existe, mas `master` não possui commits, tags, branches nem remote; todos os arquivos atuais estavam não rastreados no inventário. Não há histórico Git recuperável.
- `work/` contém artefatos locais: perfis Electron, capturas e cópias SQLite de smoke test. `dist/` é build Vite. Não são fonte nem banco de produção.
- As auditorias `AUDITORIA_2026-08-22.md` e `AUDITORIA_FRONTEND_2026-08-23.md` foram preservadas como evidência histórica.
- Em 23/09/2026, `npm run check` passou. Build não foi executado porque altera `dist/`; o smoke de banco exige `GESTAO_TEST_SOURCE_DB` e a captura visual grava em `work/`, ambos preservados nesta análise.
- A disponibilidade de SIWIN, Thunderbird e GerenciadorFotos depende do ambiente Windows real e não foi inferida como operacional pelo código.

## Próximos passos recomendados

1. Criar o primeiro commit preservando esta fonte de verdade.
2. Executar smoke de banco somente com cópia SQLite descartável em `GESTAO_TEST_SOURCE_DB`.
3. Validar integrações em ambiente autorizado, sem apontar testes a dados de produção.
4. Antes de mudar dados/esquema, avaliar impacto em prazos, eventos, backup, transações e compatibilidade.
