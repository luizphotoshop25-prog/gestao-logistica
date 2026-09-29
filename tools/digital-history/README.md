# Ferramentas do histórico da Digital Fotos

Ferramentas locais de extração, planejamento e importação histórica, fora do domínio normal do aplicativo. A janela aprovada contém os 200 pedidos recentes em `work/digital-history/listing.json` e seus detalhes em `details.json`.

## Seed autenticado sem arquivo

No Chrome DevTools, abra **Network**, selecione uma requisição real `Pedido/Pedidos` do host `online-ws.sigi.com.br`, use **Copy → Copy as cURL (bash)** e, no PowerShell do projeto, rode:

```powershell
Get-Clipboard -Raw | node tools/digital-history/extractor.cjs --seed-stdin --db 'E:\GestaoLogistica_Server_Pilot\data\gestao-logistica.sqlite3' --mode sample --sample-orders 'NUMERO1,NUMERO2,NUMERO3'
```

O cURL contém estado autenticado. Não o cole no chat, terminal, arquivo ou Git; o comando o envia pela stdin diretamente ao processo. O extrator mantém cabeçalhos e os campos `Zid`, `Chave` e `DadosRepositorioSerializado` somente em memória. Ele valida HTTPS, host e rota antes de qualquer chamada, rejeita redirects/TLS inseguro e nunca grava ou imprime seed, cookie, token, corpo bruto ou nomes de arquivos.

Use a sessão autorizada e atual, sem automatizar login. Respostas 401/403 interrompem como `SESSION_EXPIRED`; 429 interrompe; falhas de rede/5xx recebem no máximo duas novas tentativas com espera crescente. As requisições são sequenciais com atraso padrão de 500 ms (configurável de 400 a 750 ms).

## Extração e plano

1. Rode o comando inicial com `--sample-orders` e os três números conhecidos, após validação/autorização humana. Esse modo testa somente esses detalhes e não dispara a listagem histórica.
2. Somente após autorização explícita, execute `--mode list`. A constante `MAX_HISTORY_ORDERS` no extrator limita a consulta aos pedidos mais recentes e a paginação para imediatamente ao alcançar esse limite, truncando a última página se necessário. A quantidade total serve apenas para o relatório; nunca amplia o trabalho. IDs e números duplicados interrompem a etapa. O relatório `listing.json` registra disponíveis, considerados e ignorados pelo limite. Nenhum detalhe é consultado.
3. A etapa `--mode details` exige uma nova execução autorizada, lê esse inventário limitado e processa apenas os pedidos nele listados, sequencialmente. Pode ser retomada com novo seed; o checkpoint guarda dados normalizados e nunca guarda credenciais ou respostas brutas.
4. `node tools/digital-history/extractor.cjs --mode import-plan --db '<caminho-do-banco>'` não usa seed nem chama a Digital Fotos. Abre o SQLite somente para leitura, compara o conjunto congelado com as relações existentes e gera `import-plan.json` e `import-plan.txt` em `work/digital-history`.

## Importação autorizada

`tools/digital-history/import-real.cjs` valida o plano aprovado, revalida o conjunto congelado e as contagens do banco, cria backup consistente usando a API nativa `node:sqlite` e valida o backup antes de abrir uma transação de escrita. A transação usa `BEGIN IMMEDIATE`, insere somente `digital_envios`, `digital_envio_itens` e um evento `created` por envio; deixa a autoria histórica nula e não altera pedidos, clientes ou solicitações. Conta, integridade e FKs são verificadas antes do commit; falhas provocam rollback. Um dry-run posterior confirma 172 envios e 780 relações existentes como no-op.

No piloto Windows, `scripts/import-pilot-digital-history.ps1` confirma a identidade da API na porta 8787 e do Quick Tunnel, interrompe apenas a API, executa preflight/backup/importação e reinicia a API local sem recriar ou reconfigurar o túnel. Execute-o somente depois de autorização explícita para o lote congelado; o Windows pode solicitar elevação administrativa. O resultado vai para `import-result.json` e `import-result.txt`; backups ficam fora do repositório em `E:\GestaoLogistica_Server_Pilot\backups`.

O diretório `work/` já é ignorado pelo Git. Relatórios e checkpoints contêm identificadores operacionais mínimos, datas, status, contagens e sessões; não contêm dados de clientes, pagamento, endereço, CPF, telefone ou nomes de arquivos. O backup SQLite contém a base operacional completa, portanto permanece fora do Git.

## Testes

```powershell
npm run digital-history:test
```

Os testes são sintéticos e não chamam o site nem abrem o banco operacional. Cobrem leitura somente, plano, transação, rollback e idempotência.
