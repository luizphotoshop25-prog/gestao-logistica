# Digital Fotos no Cloudflare

O Worker usa a identidade existente `gestao-logistica-production`. O cliente v0.1.19
e seu contrato HTTP não mudam. `SigiClient`, descoberta SIGI, planner, regras de
quantidade e executor são compartilhados com o runtime Node legado.

O armazenamento Cloudflare injeta uma conexão com prefixos internos no
`DigitalSyncState`; não abre arquivos nem chama DPAPI. Cada importação e seu
checkpoint são atômicos em `transactionSync`. A trava persistente expira no
timeout do ciclo (no máximo dez minutos) e tem token de posse: um ciclo antigo
não pode escrever nem liberar a trava de seu sucessor. O orçamento é limitado
a uma importação mesmo se a configuração externa pedir mais.

Secrets nativos necessários: `DIGITAL_SIGI_USERNAME`, `DIGITAL_SIGI_PASSWORD` e
`DIGITAL_SYNC_INTERNAL_TOKEN`. Nunca os coloque em arquivos/configuração Git.
O provider lê exclusivamente o `env` do Worker. A integração não depende de
PowerShell, do PC do estúdio ou de Quick Tunnel.

## Implantação em etapas

1. Implantar `DIGITAL_SYNC_ENABLED=true`, `DIGITAL_SYNC_WRITE_ENABLED=false`, sem Cron.
2. Migrar o SQLite auxiliar autorizado, somente leitura na origem, via
   `scripts/migrate-cloudflare-digital-state.cjs`. O token administrativo fica
   apenas no ambiente em memória do processo. A carga fixa quatro tabelas,
   valida contagens/referências/baseline e recusa conteúdo diferente após a
   primeira importação. Repetir o mesmo payload é idempotente.
3. Executar POST `/__internal/digital-sync/run` com `{"dryRun":true}`. Validar
   login, baseline, zero candidatos históricos, classificação, integridade e
   zero escrita operacional. O estado auxiliar pode registrar a observação.
4. Somente após esse gate, implantar `DIGITAL_SYNC_WRITE_ENABLED=true` e executar
   um ciclo controlado. Validar envio, itens, evento e repetição idempotente.
5. Somente após o ciclo, adicionar a seção `[triggers]` com
   `crons = ["*/30 * * * *"]`. O handler `scheduled` aguarda o mesmo DO.

As rotas internas exigem Bearer com o secret dedicado tanto no Worker quanto no
DO; ausência/erro retorna 404. Migração é recusada com escrita habilitada.
GET `/__internal/digital-sync/status` devolve apenas contagens/diagnóstico.
GET `/api/digital-sync/status` mantém autenticação e perfil coordenador existentes,
com estado persistente, última versão SIGI e próximo horário aproximado de Cron.
O horário aproximado só representa um agendamento ativo depois da etapa 5.

Em erro inesperado, desligar apenas `DIGITAL_SYNC_WRITE_ENABLED`; não substituir
o banco, apagar estado ou recriar baseline. Não há importação inicial automática.
Uma indisponibilidade/cota do armazenamento bloqueia a migração e o gate, não
autoriza iniciar um baseline novo. O plano gratuito tem limite diário de leituras;
esgotamento da cota bloqueia também a API operacional até liberação pelo provedor.

## Validação

`node --test tests/cloudflare-digital-sync.test.cjs` cobre provider, migração,
baseline, classificação, orçamento, rollback, idempotência, reentrada/expiração,
sanitização e encaminhamento Cron. Também executar os testes Digital existentes,
`tests/smoke-cloudflare-do.cjs`, `npm run check` e empacotamento Wrangler dry-run.
Não usar banco operacional como fixture. O adapter ignora somente os marcadores
transacionais geridos pelo DO e `busy_timeout`, incompatível com esse runtime.

Estado em 06/10/2026: primeira implantação sem escrita e secrets provisionados.
Migração e ensaio real bloqueados pela cota de leituras do plano gratuito.
Nenhum Cron ativado; não considerar esta implantação como sincronização ativa.
