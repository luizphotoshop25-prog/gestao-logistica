# Digital Sync Service — fase 01

O serviço é exclusivo do backend. Ele permanece desabilitado por padrão e não é
importado pelo processo da API, não possui agendador e não executa escritas no
banco. A execução explícita `npm run digital-sync:dry-run` usa
`GESTAO_SERVER_DATA` para localizar o SQLite central e abre o banco em modo
read-only com `query_only`.

O primeiro dry-run cria somente um baseline em `work/digital-sync/`. Não planeja
importar pedidos ausentes nessa primeira observação. Execuções posteriores
comparam os identificadores da listagem com o snapshot anterior, consultam
detalhes apenas de pedidos novos ou pendentes e geram um plano sem aplicá-lo.
Uma lacuna de paginação impede o avanço do snapshot. Esses arquivos são
artefatos de teste, não estado de produção: a futura ativação precisa de
persistência transacional de baseline e pendências antes de habilitar escritas.

No servidor Windows, `node scripts/provision-digital-credential.cjs` recebe
login e senha por entrada interativa oculta, sem argumentos, e grava apenas
dados protegidos por DPAPI no diretório `GESTAO_SERVER_DATA`. Execute-o sob a
mesma conta Windows que executará o serviço. O comando pode ser repetido para
trocar a credencial. Nenhuma credencial real é provisionada por este código.
Sem o arquivo protegido, o dry-run termina com `DIGITAL_CREDENTIAL_MISSING`
antes de consultar a Digital Fotos.

`npm run digital-sync:test` usa respostas e SQLite sintéticos. Os relatórios do
dry-run contêm identificadores operacionais, categorias e contagens, sem
credenciais, estado de sessão, nomes individuais de arquivos ou dados de
clientes. Não use os artefatos de `work/` como fonte de produção.
