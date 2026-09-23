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
2. `electron/preload.cjs` fornece uma API controlada em `window.gestaoAPI` com `contextBridge`; o renderer a consome pelo adaptador IPC de `src/services/dataService.ts`.
3. `src/main.tsx` monta `src/App.tsx`; este concentra a mesa operacional, filtros, ficha, importação e clientes. O renderer usa `src/services/dataService.ts`, hoje um adaptador IPC sem transformação de payloads, retornos ou erros.
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

- O baseline recuperado está no branch `master`; não há remote configurado nem histórico anterior recuperável.
- `work/` contém perfis Electron, capturas e cópias SQLite de smoke test; `dist/` é build Vite. Não são fonte nem banco de produção.
- As auditorias `AUDITORIA_2026-08-22.md` e `AUDITORIA_FRONTEND_2026-08-23.md` foram preservadas como evidência histórica.
- Em 23/09/2026, `npm run check` passou. Build não foi executado porque altera `dist/`; os smokes criam seus próprios dados temporários e a captura grava imagens ignoradas em `work/`.

## Protótipo HTTP de teste

- Em 23/09/2026 foi aprovado um transporte HTTP local e independente para fixture SQLite sintético. A API usa exclusivamente `127.0.0.1`, porta dinâmica e `userDataPath` temporário explícito; não há fallback para o perfil de produção.
- `DataService` mantém IPC como padrão. Com `GESTAO_DATA_TRANSPORT=http` e `GESTAO_API_URL` loopback explícita, a UI usa HTTP para listar pedidos, abrir ficha, consultar dashboard e atualizar pedido.
- Os smokes de API, adaptador HTTP e UI HTTP usam somente `M99997` / `Cliente HTTP Teste`; encerram servidor/SQLite e removem seus temporários. SIWIN, Thunderbird, EPICS, GerenciadorFotos, anexos e caminhos reais não participam desse modo.
- A equivalência de listagem, ficha e dashboard foi comparada com chamadas diretas ao mesmo domínio SQLite. A comparação final de ficha normaliza somente o protótipo de objeto próprio das linhas SQLite para a serialização JSON HTTP.

## Próximos passos recomendados

1. Validar integrações em ambiente autorizado, sem apontar testes a dados de produção.
2. Antes de mudar dados/esquema, avaliar impacto em prazos, eventos, backup, transações e compatibilidade.

## Baseline de recuperação

- Baseline anterior: `738352b666cdfdfec9370870cbe1fac1acc7278d`, branch `master`.
- Em 23/09/2026, smoke de banco aprovado duas vezes sem `GESTAO_TEST_SOURCE_DB`: inicialização oficial de SQLite vazio em diretório temporário, fixture sintético `M99998`, prazos +20/+60, remessa de sexta, integridade e supressão de histórico duplicado. Conexões fechadas e diretório próprio removido ao finalizar.
- Captura visual aprovada duas vezes com fixture sintético `M99999`, perfil temporário e portas loopback dinâmicas 50608 e 57280. Vite mantém a porta alocada enquanto Electron usa a mesma origem. Perfis removidos após encerramento; imagens ignoradas em `work/`.
- `npm run check` e sintaxe dos scripts validados. Nenhum banco real ou integração externa foi utilizado nestes testes.
- Desenvolvimento normal mantém `8090`; a captura fornece sua origem dinâmica. A data da remessa segue o relógio em `America/Sao_Paulo`; demais datas e dados do fixture são fixos.
- Estes smokes não validam integrações reais nem migração de um banco legado; o resíduo da execução antiga não foi removido nesta etapa.

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

- O baseline recuperado está no branch `master`; não há remote configurado nem histórico anterior recuperável.
- `work/` contém artefatos locais: perfis Electron, capturas e cópias SQLite de smoke test. `dist/` é build Vite. Não são fonte nem banco de produção.
- As auditorias `AUDITORIA_2026-08-22.md` e `AUDITORIA_FRONTEND_2026-08-23.md` foram preservadas como evidência histórica.
- Em 23/09/2026, `npm run check` passou. Build não foi executado porque altera `dist/`; os smokes criam seus próprios dados temporários e a captura grava imagens ignoradas em `work/`.
- A disponibilidade de SIWIN, Thunderbird e GerenciadorFotos depende do ambiente Windows real e não foi inferida como operacional pelo código.

## Próximos passos recomendados

1. Validar integrações em ambiente autorizado, sem apontar testes a dados de produção.
2. Antes de mudar dados/esquema, avaliar impacto em prazos, eventos, backup, transações e compatibilidade.
