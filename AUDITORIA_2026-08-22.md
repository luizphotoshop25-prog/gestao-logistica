# Auditoria técnica e de UX — 22/08/2026

## Escopo e segurança

- Projeto auditado: `E:\GestaoLogistica_DEV`.
- Banco alterado: somente o SQLite local da Gestão Logística.
- SIWIN: exclusivamente leitura. O conector aceita consultas `SELECT`/`WITH` e rejeita instruções de alteração antes de enviá-las.
- Nenhuma tabela, arquivo ou configuração do SIWIN foi alterada ou excluída.
- Testes de fluxo que gravam dados foram executados em cópia temporária isolada do SQLite.

## Linha de base

| Medida | Antes | Depois |
|---|---:|---:|
| Clientes totais no SQLite local | 71.028 | 71.028 |
| Clientes do escopo do Estúdio | 42.529 | 42.529 |
| Pedidos/sessões | 1.215 | 1.215 |
| Itens de pedidos | 5.589 | 5.589 |
| Observações do SIWIN | 1.964 | 1.964 |
| E-mails de seleção | 217 | 217 |
| Anexos | 2 | 2 |
| Divergências entre total de fotos e itens cobrados | detectadas | 0 |
| Integridade SQLite | ok | ok |

Os totais de entidades foram preservados. A migração local alterou apenas o total derivado de fotos cobradas quando ele divergia dos itens já sincronizados.

## Problemas de prioridade alta corrigidos

1. Rastreio sem data de postagem era interpretado como pedido postado. Agora a postagem depende da data explícita; há 76 registros antigos nessa condição para revisão, sem alteração automática.
2. O total de fotos podia vir da planilha e divergir dos itens do SIWIN. Agora é a soma das fotos dos itens com valor total maior que zero; itens gratuitos continuam visíveis.
3. Ações em massa podiam avançar pedidos fora da etapa correta. O backend agora valida cada pedido, ignora os incompatíveis, exige rastreio para remessa/postagem e informa os protegidos.
4. Era possível registrar etapas fora de ordem. Foram incluídas validações de pré-requisitos no backend.
5. Salvar uma ficha sem alteração gerava ruído no histórico. Agora retorna “nenhuma alteração” e não cria evento.
6. Cálculos de sexta-feira podiam avançar um dia por conversão UTC. Datas operacionais agora usam `America/Sao_Paulo` e os prazos continuam corridos.
7. A integração do SIWIN não tinha uma trava explícita contra comandos de escrita. O conector agora rejeita SQL que não seja de leitura.

## UX/UI aplicada

- Mesa diária dividida em categorias exclusivas: **Precisa de mim**, **Aguardando terceiros** e **Alertas**.
- Remoção das filas extensas de simples consulta da navegação principal.
- Próxima ação, responsável, urgência e última movimentação visíveis na tabela.
- Busca por sessão, cliente, telefone, celular, e-mail, CAD e rastreio.
- Integrações agrupadas em um único menu, com indicação da última sincronização.
- Seleção múltipla com confirmação e resultado parcial seguro.
- Ficha do pedido em abas reais: Resumo, Seleção, Produção, Envio e Histórico.
- Aviso de alterações não salvas, botão Salvar desabilitado quando nada mudou e foco visível por teclado.
- Estados vazios contextuais e indicador de carregamento.

## Regras de negócio preservadas

- Seleção finalizada é informação manual ou recebida do Thunderbird; nunca vem do SIWIN.
- Tratamento: seleção + 20 dias corridos.
- Limite máximo: seleção + 60 dias corridos.
- Após receber as impressões, a próxima etapa é criar a etiqueta.
- Remessa é planejada para a próxima sexta-feira; postagem continua explícita.
- Produtos gratuitos são exibidos para conferência, mas não entram no total de fotos cobradas.
- O fornecedor padrão ao enviar para impressão é Digital Fotos quando ainda não informado.

## Importação, integrações e proteção de dados

- Importação aceita XLSX e CSV (vírgula ou ponto e vírgula), com prévia e bloqueio de sessão inválida/duplicada.
- Planilha real analisada: 602 linhas, 584 elegíveis, 18 bloqueadas, 246 sem identificação de cliente e 76 com rastreio sem data de postagem.
- Thunderbird: 217 mensagens únicas vinculadas; repetição de `Message-ID` é eliminada.
- Anexos existentes conferidos no armazenamento local.
- Backup diário usa checkpoint do WAL. Importações, correções derivadas e ações críticas criam backup anterior.

## Validações executadas

- `npm run check`: aprovado.
- `npm run build`: aprovado.
- CSV de teste: aprovado.
- Fluxo completo em banco copiado: aprovado.
- Seleção em 22/08/2026 resultou em 11/09/2026 (20 dias) e 21/10/2026 (60 dias).
- Próxima remessa calculada para 28/08/2026, uma sexta-feira.
- Tentativa de salvar sem mudança não criou histórico.
- `PRAGMA integrity_check` do banco local após a migração: `ok`.
- Conferência visual do executável reiniciado: tela principal e ficha do pedido aprovadas.

## Backups principais

- Antes da auditoria: `antes-auditoria-ux-consistente-20260822-231251.sqlite3` — 26.013.696 bytes — SHA-256 `74F1E61ACD2BF9353BB92EB4A9C884456D9B4332B15DA04FBF6C38B48ED39A78`.
- Antes do recálculo local de fotos: `antes-recalculo-fotos-cobradas-2026-08-23T02-25-25-547Z.sqlite3`.
- Backup diário local após a correção de fuso: `gestao-logistica-2026-08-22.sqlite3`.

## Pendências e decisões de negócio

1. Há 527 sessões antigas do SIWIN apenas para revisão histórica. Elas não foram arquivadas automaticamente. É preciso decidir a regra de encerramento.
2. Há 91 pedidos antigos postados ainda ativos na janela provisória de 120 dias. Também não foram encerrados automaticamente.
3. Os perfis Administrador, Logística, Produção e Consulta estão documentados, mas autenticação real depende da decisão sobre usuários e compartilhamento do banco. Nenhum controle falso apenas de interface foi criado.
4. A sincronização manual do SIWIN encontrou indisponibilidade temporária de conexão na validação final. O aplicativo local continua funcionando; a última sincronização bem-sucedida permanece registrada.
5. O repositório Git ainda não possui uma linha de base versionada: os arquivos aparecem como não rastreados. Criar o primeiro commit será importante antes da próxima rodada de mudanças.

## Arquivos principais alterados

- `electron/database.cjs`: regras, migração local, backups, filtros, validações e ações em massa.
- `electron/siwin.cjs`: guarda de somente leitura.
- `electron/importer.cjs`: XLSX/CSV e campos opcionais seguros.
- `electron/main.cjs`: seleção de arquivos XLSX/CSV.
- `src/App.tsx`: mesa operacional, ficha, busca, integrações e prevenção de perda de alterações.
- `src/styles.css`: layout, foco, carregamento e estados.
- `src/global.d.ts`: contratos IPC atualizados.
- `tests/smoke-database.cjs`: teste isolado do fluxo e das datas.
- `README.md`: regras e matriz futura de perfis.
