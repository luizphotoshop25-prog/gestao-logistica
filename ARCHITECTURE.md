# Arquitetura Técnica — Gestão Logística

_Reconstruída a partir do código em 23/09/2026._

## Componentes

Fluxo: React → `dataService` → `ipcDataService` → `window.gestaoAPI` → preload → IPC → main → domínio/banco.

`src/services/dataService.ts` reutiliza as assinaturas existentes de `src/global.d.ts`. O adaptador apenas delega argumentos, retornos e callbacks, sem capturar erros ou transformar payloads. Um futuro adaptador HTTP poderá implementar esse contrato; não existe transporte HTTP nesta fase.

## Camadas

- `src/main.tsx` inicia React; `src/App.tsx` compõe a interface e estado; `src/global.d.ts` declara contrato/modelos; `src/components/` e `src/styles.css` mantêm elementos e aparência.
- `electron/preload.cjs` expõe somente a API necessária; o renderer não acessa Node, SQLite ou filesystem diretamente.
- `electron/main.cjs` cria a janela, inicializa módulos, atende IPC e usa diálogos nativos.
- `electron/database.cjs` reúne esquema, regras, consultas/escritas, transações, anexos, eventos, backup e integridade.

## Modelo de dados

| Tabela | Responsabilidade |
| --- | --- |
| `configuracoes` | Preferências e marcos locais. |
| `clientes` | Cadastro local e dados SIWIN. |
| `pedidos` | Sessão, marcos, rastreio e vínculo. |
| `remessas` | Agrupamentos planejados/postados. |
| `anexos` | Arquivos copiados localmente. |
| `pedido_itens` | Itens `PED_MS` sincronizados. |
| `pedido_observacoes_siwin` | Observações SIWIN. |
| `selecoes_email` | E-mails EPICS e marcações. |
| `eventos` | Histórico de ações. |

Clientes e remessas possuem pedidos; pedidos possuem anexos, itens, observações, seleções e eventos.

## Fluxos e build

`listOrders` junta pedido/cliente/remessa, `deriveStage` determina a etapa e `operationalInfo` calcula fila, responsabilidade e urgência. O renderer apenas apresenta e solicita detalhes. `updateMilestone` valida próximo marco/data, ajusta prazos de seleção e grava evento.

`importer.cjs` normaliza planilhas; `importSafeRows` faz backup, localiza/cria cliente, grava em transação e ignora sessão duplicada. SIWIN é espelhado no SQLite após consultas bloqueadas contra escrita. Thunderbird é idempotente por `message_id`, vincula por sessão e não sobrescreve seleção existente.

Vite produz `dist/` com `base: "./"`; `electron-builder` gera instalador Windows NSIS com os módulos descritos em `package.json`.
