# Gestão Logística

Novo aplicativo desktop, criado separadamente do FocusEdit, para acompanhar clientes e sessões desde a publicação da galeria até a entrega pelos Correios.

## Regras confirmadas

- Prazo interno de tratamento: 20 dias corridos após a seleção.
- Prazo máximo: 60 dias corridos após a seleção.
- Após receber as impressões, a próxima etapa é criar a etiqueta.
- Datas operacionais e remessas são calculadas no fuso `America/Sao_Paulo`, evitando mudança de dia por conversão UTC.

## Fluxo

1. Sessão criada.
2. Galeria publicada.
3. Link enviado ao cliente.
4. Seleção finalizada.
5. Tratamento concluído.
6. Enviado para impressão.
7. Impressões recebidas.
8. Etiqueta criada.
9. Incluído em remessa.
10. Postado.
11. Entregue.

A etapa atual é calculada pelas datas registradas; não existem três campos de status concorrentes.

## Importação da planilha original

- Aceita arquivos XLSX e CSV; em CSV, reconhece automaticamente vírgula ou ponto e vírgula como separador.
- Usa somente `LOGISTICA` como fonte principal.
- `BACKUP 2304` não é somado à fonte, pois quase todas as sessões já existem em `LOGISTICA`.
- Sessões duplicadas ficam bloqueadas na prévia.
- Registros sem dados do cliente são importáveis como pendência, sem inventar cliente.
- `ENVIADOS DIGITAL` será migrada separadamente como histórico de lotes de impressão.
- Nenhuma importação é gravada antes da confirmação visual.

## Sincronização com o SIWIN

- O aplicativo lê novos clientes diretamente do banco `intra2br` usado pelo SIWIN.
- O pertencimento ao Estúdio é determinado pela existência de uma sessão com prefixo `M`.
- O cadastro pesquisável inclui clientes históricos com sessão `M`; a fila operacional recebe somente sessões recentes, além do histórico da planilha.
- A identificação é feita pelo código `CAD`, impedindo duplicações nas sincronizações seguintes.
- Pedidos locais são vinculados automaticamente ao cliente pela sessão em `CAD_CLIEN_SESSAO`, com consulta a `PED` como alternativa.
- A primeira sincronização importa a base de clientes; depois, somente códigos novos são consultados.
- A verificação ocorre ao abrir o programa, a cada dois minutos e também pelo botão **Sincronizar SIWIN**.
- A integração executa somente consultas `SELECT` no SIWIN. Uma trava no conector rejeita qualquer instrução de alteração antes de enviá-la. As gravações ocorrem exclusivamente no SQLite local.
- A senha não é exibida nem copiada para os arquivos do novo aplicativo; a configuração da instalação local do SIWIN é lida em memória.

## Uso da tela

- Indicadores e filas são filtros clicáveis.
- Clique na sessão ou no cliente para abrir os detalhes operacionais do pedido.
- A tela de detalhes permite registrar galeria, envio do link, seleção, tratamento, impressão, etiqueta, rastreio, postagem e entrega.
- A quantidade de fotos cobradas é recalculada pelos itens sincronizados: soma `FOTOS_PB + FOTOS_CL` somente onde `VL_TOTAL` é maior que zero. Itens gratuitos continuam visíveis para conferência, mas não entram no total.
- A ficha da sessão mostra todos os produtos e serviços de `PED_MS`, incluindo quantidade, fotos, valores, tipo/ampliação e indicação de item cobrado ou não cobrado.
- As observações internas de `PED_OBS` são sincronizadas com autor, data, horário e texto, e aparecem separadas das anotações locais do pedido.

## Seleções recebidas pelo Thunderbird

- A caixa de entrada local da conta `logistica@manoelguimaraes.com.br` é verificada ao abrir o programa, a cada dois minutos e pelo botão **Verificar seleções**.
- Somente mensagens de finalização enviadas por `nao-responda@epics.com.br` são consideradas.
- A sessão, a data do e-mail, a quantidade e os códigos das fotos são armazenados no SQLite local.
- A primeira mensagem preenche a data da seleção somente quando o pedido ainda está sem data; datas existentes nunca são sobrescritas.
- Novas finalizações da mesma sessão ficam registradas no histórico sem redefinir os prazos automaticamente.
- O botão **Preparar no GerenciadorFotos** grava a lista em `C:\GerenciadorFotos\lista_formatada.txt` e abre o separador.
- Comprovantes do WhatsApp, arquivos da seleção e etiquetas podem ser anexados em imagem ou PDF.
- O cartão de clientes abre a consulta do cadastro sincronizado do SIWIN.

## Filas operacionais e tratamento do histórico

- A tela inicial funciona como uma mesa de trabalho com três áreas exclusivas: **Precisa de mim**, **Aguardando terceiros** e **Alertas**.
- Cada pedido aparece em apenas uma dessas áreas, conforme a responsabilidade e a prioridade mais alta.
- A tabela mostra a próxima ação, quem está responsável, urgência em dias e última movimentação.
- A busca é global e também encontra pedidos históricos que ficam fora da mesa diária.
- Sincronização e importação ficam agrupadas no menu **Integrações**.
- Os pedidos podem ser selecionados e atualizados em conjunto para impressão, recebimento, remessa de sexta, postagem e acompanhamento.
- Ações em massa ignoram pedidos em etapa incompatível e informam quantos foram protegidos contra avanço incorreto.
- Cada pedido possui um estado independente de acompanhamento: ativo, arquivado ou concluído anteriormente.
- Nenhum pedido antigo é arquivado ou concluído automaticamente; a fila **Revisar histórico** existe para classificação manual segura.
- A remessa semanal usa a próxima sexta-feira e apenas agrupa os pedidos. A postagem continua sendo uma ação explícita.
- E-mails importados antes desta versão foram marcados como histórico já conferido. Novos e-mails entram na fila **Seleções novas**.
- Na ficha do pedido, cada finalização pode ser marcada separadamente como **Seleção conferida** e **Fotos separadas**.
- A ficha usa abas reais e independentes para resumo, seleção, produção, envio e histórico.
- A ficha avisa sobre alterações não salvas e evita criar eventos de histórico quando nenhum campo mudou.

## Desenvolvimento

```powershell
npm install
npm run check
npm run build
npm run dev
```

## Perfis previstos

O aplicativo continua local e de usuário único nesta versão; portanto, ainda não simula autenticação nem esconde funções apenas visualmente. A matriz preparada para uma futura implantação multiusuário é:

- **Administrador:** configurações, importação, backups e gestão de acessos.
- **Logística:** fluxo operacional completo, remessas, etiquetas e rastreios.
- **Produção:** consulta da fila de tratamento e conclusão das etapas de produção.
- **Consulta:** acesso somente para leitura.

A ativação desses perfis exige definir onde os usuários serão autenticados e em quais computadores o banco local será compartilhado. Até essa decisão, todas as proteções importantes permanecem no backend do aplicativo, e não apenas na interface.

O banco de produção fica na pasta de dados do usuário e recebe um backup diário consistente após o fechamento do WAL. Importações e ações críticas também geram um backup anterior com data e hora. O FocusEdit e seu banco não são lidos nem modificados pelo novo aplicativo.
