# Arquitetura Técnica — Gestão Logística

_Reconstruída a partir do código em 23/09/2026._

## Componentes

Fluxo padrão: React → `dataService` → `ipcDataService` → `window.gestaoAPI` → preload → IPC → main → domínio/banco.

O protótipo HTTP de teste oferece um segundo caminho: `dataService` → `httpDataService` → API HTTP em `127.0.0.1` → `electron/database.cjs` → SQLite temporário. O seletor explícito exposto pelo preload usa `GESTAO_DATA_TRANSPORT=http` e `GESTAO_API_URL`; sem essa configuração o IPC continua sendo o padrão.

O modo `LAN PILOT` é iniciado separadamente com `npm run server:lan`. Ele exige `GESTAO_SERVER_DATA`, `GESTAO_API_HOST` e `GESTAO_API_PORT`, usa um único SQLite central e não inicializa Electron, SIWIN, Thunderbird, EPICS ou GerenciadorFotos. Loopback e portas dinâmicas continuam sendo o padrão dos testes automatizados.

Fluxo LAN: Electron cliente → Login → Sessão → DataService HTTP → API LAN → Usuário autenticado → Domínio → SQLite piloto.

O cliente remoto lê `gestao-client.json` por `GESTAO_CLIENT_CONFIG`, portanto IP e porta podem mudar sem recompilação. O arquivo exige transporte HTTP, origem privada com porta e `mode: "lan-pilot"`. Nesse modo o Electron não inicializa SQLite local nem oferece fallback para IPC.

`src/services/dataService.ts` reutiliza as assinaturas existentes de `src/global.d.ts`. O adaptador IPC delega argumentos, retornos e callbacks sem transformação. O adaptador HTTP implementa somente listagem, ficha, dashboard e atualização; integrações, arquivos e ações específicas do cliente retornam indisponibilidade previsível, sem fallback para IPC.

`server/api-server.cjs` usa somente módulos nativos, exige um `userDataPath` absoluto e explícito, recusa host diferente de `127.0.0.1` e disponibiliza autenticação simples, além das rotas de pedidos e dashboard. `GET /health` é público; as rotas operacionais exigem token de sessão válido. A API reutiliza diretamente as regras existentes em `electron/database.cjs`.

Para o piloto LAN, `server/lan-server.cjs` habilita explicitamente host de rede e porta estável. `GESTAO_SERVER_DATA` aponta diretamente para o diretório que contém `gestao-logistica.sqlite3`, `backups/` e `comprovantes/`. O health check informa apenas disponibilidade da API e do banco.

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
| `usuarios` | Identidade local, hash de senha e estado ativo. |
| `sessoes` | Hash do token, validade e revogação da sessão HTTP. |

Clientes e remessas possuem pedidos; pedidos possuem anexos, itens, observações, seleções e eventos.

## Fluxos e build

`listOrders` junta pedido/cliente/remessa, `deriveStage` determina a etapa e `operationalInfo` calcula fila, responsabilidade e urgência. O renderer apenas apresenta e solicita detalhes. `updateMilestone` valida próximo marco/data, ajusta prazos de seleção e grava evento.

Cada pedido possui `revisao`, iniciada em `1` e aumentada por qualquer escrita no pedido. A ficha devolve essa revisão e `updateOrder` exige a revisão recebida: o `UPDATE` transacional só ocorre quando ela ainda é a atual. Divergências retornam `REVISION_CONFLICT` (e HTTP `409`) sem sobrescrever dados. Não há repetição automática: a tentativa rejeitada retorna ao cliente sem gerar evento de alteração. O smoke HTTP simultâneo com duas requisições na mesma revisão confirmou um sucesso, um `409`, uma única incrementação e banco íntegro.

A autenticação HTTP usa senha com `scrypt` e sal aleatório. O token de sessão é aleatório, expira em 12 horas e somente seu hash SHA-256 é armazenado no SQLite; logout e desativação revogam sessões. No Electron, `safeStorage` protege o token persistido, enquanto o renderer o mantém somente em memória. O transporte IPC continua utilizável sem login nesta fase.

Ao atualizar um pedido por HTTP, a API obtém o autor da sessão e passa seu identificador ao banco; o cliente não informa `usuario_id`. O evento só é criado depois do `UPDATE` condicional bem-sucedido, portanto conflitos `409` não produzem autoria ou histórico falsos. Eventos anteriores permanecem compatíveis com `usuario_id` nulo.

`importer.cjs` normaliza planilhas; `importSafeRows` faz backup, localiza/cria cliente, grava em transação e ignora sessão duplicada. SIWIN é espelhado no SQLite após consultas bloqueadas contra escrita. Thunderbird é idempotente por `message_id`, vincula por sessão e não sobrescreve seleção existente.

Vite produz `dist/` com `base: "./"`; `electron-builder` gera instalador Windows NSIS com os módulos descritos em `package.json`.
