# Digital Sync Service — fase 04 (pré-ativação)

O serviço é exclusivo do backend. `DIGITAL_SYNC_ENABLED` e
`DIGITAL_SYNC_WRITE_ENABLED` são independentes e ambos começam `false`.
Com o primeiro desligado, nenhum ciclo inicia, mesmo que o segundo seja `true`.
Com apenas o primeiro ligado, o ciclo consulta e planeja sem escrever envios.
Somente ambos `true` permitem o executor, que verifica os dois interruptores
internamente e recusa IDs observados no baseline inicial. Nesta fase os dois
continuam desligados no servidor real. A execução explícita `npm run digital-sync:dry-run` usa
`GESTAO_SERVER_DATA` para localizar o SQLite central e abre o banco em modo
read-only com `query_only`.

O baseline real foi importado do artefato de teste para
`GESTAO_SERVER_DATA/digital-sync/digital-sync-state.sqlite3`. Um marcador em
`GESTAO_SERVER_DATA/digital-sync.initialized` distingue instalação inicial de
estado posteriormente ausente. A importação valida duplicatas, preserva o
horário da primeira observação e é idempotente. O serviço usa o SQLite auxiliar
para recuperar a última janela após reinício. A execução cria um registro
`STARTED`; só uma transação completa atualiza observações, janela e
`last_successful_sync`. Falha, lacuna ou término abrupto não avançam o
checkpoint. Estado ausente ou corrompido bloqueia o serviço sem recriá-lo.
Arquivos em `work/` são relatórios, não estado operacional.
Os quatro pedidos ausentes na primeira observação são
`BASELINE_EXISTING_UNIMPORTED`: ficam para conferência manual e não viram
candidatos automáticos apenas por estarem ausentes no Gestão.

No servidor Windows, `scripts/provision-digital-credential-local.cjs` abre uma
página temporária em `127.0.0.1`, com token CSRF, cookie SameSite e validação
de Origin. O navegador lateral usa `Origin: null`; nesse caso também se exige
`Sec-Fetch-Site: same-origin`. A senha é digitada somente nessa página. O
provisionador grava o arquivo DPAPI no diretório `GESTAO_SERVER_DATA` com ACL
restrita à conta Windows atual e ao sistema. Execute-o sob a mesma conta que
executará o serviço. O comando interativo
`node scripts/provision-digital-credential.cjs` continua disponível para
recuperação. O provisionamento pode ser repetido para trocar a credencial.
Sem o arquivo protegido, o dry-run termina com `DIGITAL_CREDENTIAL_MISSING`
antes de consultar a Digital Fotos.

O baseline inicial é mantido em `baseline-preview.json`; avaliações seguintes
atualizam `latest-snapshot-preview.json`. Ambos permanecem em `work/`, fora do
SQLite central e sem uso como estado de produção.

O executor da simulação da fase 03 continua limitado, por código, a cópias
SQLite no diretório temporário. O caminho operacional exige os dois
interruptores e estado auxiliar válido; não é chamado com o serviço desativado.
Ele revalida número, sessão, revisão e quantidades dentro de `BEGIN IMMEDIATE`,
grava envio, relações e evento `digital_sync_created` com usuário nulo em uma
única transação, e permite reenvio da mesma sessão em outro pedido. Repetições
encontram o número já presente; o evento e os dados efetivos distinguem uma
importação automática intacta de um registro manual ou editado. A cópia
temporária operacional é feita com a API `node:sqlite.backup`.

O banco auxiliar e o banco principal são arquivos distintos: não há transação
distribuída entre eles. Quando uma futura importação gravar o banco principal
e cair antes de registrar o resultado auxiliar, a recuperação deverá reler o
envio, suas relações, quantidades, revisão e evento de origem. Só um envio
automático correspondente pode avançar a pendência auxiliar para `IMPORTED`;
um envio manual ou alterado exige revisão. O teste simula exatamente essa
queda e repetição. O agendador de 30 minutos está desligado por padrão. A API
LAN só o cria quando `DIGITAL_SYNC_ENABLED=true`, sem execução imediata após
reinício, e o interrompe ao fechar. A rota autenticada
`GET /api/digital-sync/status` aceita apenas coordenação e retorna os
interruptores, último checkpoint, contagens e erro sanitizado, sem sessão SIGI.

Para o ensaio de recuperação, execute `npm run digital-sync:recovery-rehearsal`
com `GESTAO_SERVER_DATA` apontando para o diretório autorizado. O script faz
backups consistentes dos dois bancos com `node:sqlite.backup`, confere
`integrity_check`, `foreign_key_check`, versões e contagens, restaura ambos
somente em diretório temporário, compara os resultados e remove o temporário.
Para uma recuperação real futura, pare o agendador, preserve os arquivos
afetados, valide backups dos **dois** bancos separadamente, restaure-os de
cópias verificadas e reconcilie cada pedido pendente pelo número, relações e
evento de origem no SQLite operacional antes de liberar nova execução. Não há
transação distribuída entre esses bancos.

`npm run digital-sync:test` usa respostas e SQLite sintéticos. Os relatórios do
dry-run contêm identificadores operacionais, categorias e contagens, sem
credenciais, estado de sessão, nomes individuais de arquivos ou dados de
clientes. Não use os artefatos de `work/` como fonte de produção.
