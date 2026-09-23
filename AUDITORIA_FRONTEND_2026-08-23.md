# Auditoria e modernização do frontend — 23/08/2026

## Resultado executivo

A interface foi consolidada como uma mesa operacional para uma única pessoa acompanhar todo o fluxo: galeria, seleção, tratamento, Digital Fotos, etiqueta, remessa e entrega. A página principal prioriza ações e exceções; a ficha preserva o contexto da fila e revela os detalhes por etapa.

O trabalho foi incremental. Regras, IPC, integrações e persistência existentes foram preservados. Nenhum comando de escrita foi executado contra o SIWIN; o conector continua limitado a `SELECT`/`WITH`.

## Stack atual

- Shell: Electron 43.
- Frontend: React 19 + TypeScript 5.9 + Vite 8.
- Estilos: CSS próprio com tokens e componentes visuais reutilizáveis.
- Ícones: Lucide React.
- Estado: estado local do React; preferências operacionais em `localStorage`.
- Dados: IPC tipado em `window.gestaoAPI`, SQLite local e sincronizações existentes.
- UI/query/store externos: não utilizados. Não há necessidade atual de TanStack Query, Zustand ou uma biblioteca de componentes.

Não foi feita migração para Next.js, Tailwind ou shadcn. O produto é um aplicativo Electron local, não um site SSR. A migração aumentaria o risco e o volume de dependências sem melhorar os fluxos principais.

## Fluxos principais mapeados

1. Identificar o que exige ação hoje e abrir diretamente a fila correspondente.
2. Localizar pedido por sessão, cliente, telefone, e-mail, CAD ou rastreio.
3. Registrar galeria e envio do link.
4. Receber e conferir seleção do Thunderbird; preparar a separação no GerenciadorFotos.
5. Controlar tratamento pelos prazos de 20 e 60 dias corridos.
6. Registrar envio e retorno da Digital Fotos.
7. Criar etiqueta, organizar remessa de sexta, postar e acompanhar entrega.
8. Consultar produtos, itens gratuitos e observações do SIWIN sem alterar sua origem.

## Problemas encontrados e prioridade

### P0 — segurança e integridade

- Nenhum P0 novo no frontend após as proteções anteriores.
- A integração do SIWIN permanece explicitamente somente leitura.
- A captura visual e os testes utilizam cópia isolada do SQLite local.

### P1 — produtividade

- Lista extensa renderizava registros demais de uma vez.
- Busca rápida não existia em qualquer contexto.
- Ordenação e fila escolhida eram perdidas entre sessões.
- Respostas concorrentes de busca poderiam chegar fora de ordem.
- Ações rotineiras exigiam confirmação desnecessária.
- Seleção em lote não oferecia seleção da página visível.

### P2 — UX/UI e acessibilidade

- Estados de loading e vazio não representavam a estrutura real.
- A ficha concentrava informação demais sem separação operacional.
- Tabelas e modais precisavam de semântica acessível explícita.
- O CSS bloqueava telas menores com largura mínima de 1100 px.
- Foco, movimento reduzido e atalhos precisavam de tratamento consistente.

### P3 — arquitetura e polimento

- `App.tsx` ainda concentra regras de apresentação de várias áreas.
- O sistema visual anterior possuía medidas e estilos repetidos.
- Ainda não existe uma suíte automatizada de interação do renderer com preload simulado.

## Implementações realizadas

### Mesa operacional

- Cabeçalho profissional com estado local e proteção do SIWIN.
- Sinais acionáveis: seleções novas, próximos vencimentos, alertas e etiquetas.
- Filas exclusivas: Precisa de mim, Aguardando terceiros e Alertas.
- Próxima ação, responsabilidade, urgência e última movimentação visíveis na tabela.
- Pesquisa ampla, ordenação persistente e paginação de 50 itens.
- Seleção múltipla com seleção da página e ações em lote validadas pelo backend existente.

### Busca e teclado

- `Ctrl+K`: paleta global para pedidos, filas e clientes.
- `/`: foco imediato na pesquisa da mesa.
- `Esc`: fecha a camada ativa respeitando alterações não salvas.
- Navegação por setas e Enter na paleta.

### Ficha do pedido

- Modal amplo que mantém a mesa ao fundo e preserva filtros/contexto.
- Cabeçalho com sessão, cliente, status, CAD, contato e localidade.
- Linha visual das sete etapas do pedido.
- Abas reais: Resumo, Seleção, Produção, Envio e Histórico.
- Produtos cobrados e gratuitos, observações do SIWIN, e-mails de seleção, anexos e histórico.
- Rodapé persistente, indicação de alterações e salvamento desabilitado quando nada mudou.

### Sistema visual e responsividade

- Inter Variable incorporada localmente, limitada ao subconjunto latino para não depender da internet.
- Tokens centralizados de cor, superfície, borda, texto e sombra.
- Paleta semântica discreta e consistente.
- Tipografia compacta e legível para uso prolongado.
- Skeletons estruturados, empty states orientativos e feedback inline.
- Layout desktop-first adaptado para notebooks, tablets e telas estreitas.
- `prefers-reduced-motion`, foco visível, labels e papéis de diálogo.

### Performance e confiabilidade

- Apenas 50 pedidos são montados no DOM por página.
- Resultados de buscas obsoletas são descartados.
- A paleta limita resultados imediatos a oito registros.
- Build continua pequeno para um aplicativo operacional: cerca de 244 kB de JavaScript antes de gzip e 74 kB após gzip.

## Componentes criados

- `src/components/CommandPalette.tsx`: busca e comandos globais.
- `src/components/IntegrationMenu.tsx`: menu acessível das integrações locais.
- `src/components/OrderActionsMenu.tsx`: ações secundárias por pedido sem poluir a tabela.
- `src/components/Hint.tsx`: tooltips consistentes para controles compactos.
- `src/components/Pagination.tsx`: paginação operacional.
- `src/components/TableSkeleton.tsx`: loading fiel à tabela.
- `tests/capture-ui.cjs`: captura visual invisível usando perfil e SQLite isolados.

## Decisões arquiteturais

- React local state foi mantido porque existe uma única tela principal e o IPC é local.
- Radix Dropdown Menu e Tooltip foram adotados para foco, teclado, colisão e camadas acessíveis sem impor aparência de template.
- A fonte Inter é distribuída com o executável; o programa não precisa acessar Google Fonts ou outro CDN.
- `localStorage` guarda somente preferências de interface, nunca dados de negócio.
- Paginação foi implementada sem nova dependência.
- Confirmações permanecem para ações em lote, descarte e registros sensíveis; ações individuais rotineiras agora são diretas e fornecem feedback.
- Não foi aplicada optimistic UI nas transições de etapa: a validação do backend deve vencer para evitar mostrar um estado que as regras rejeitem.

## Validação

- `npm run check` — TypeScript e arquivos Electron aprovados.
- `npm run build` — Vite aprovado.
- `npm run capture:ui` — mesa e ficha capturadas em Electron real, sem abrir janela.
- `node tests/smoke-database.cjs` — regras e banco temporário.
- `PRAGMA integrity_check` — SQLite local íntegro.

## Pendências recomendadas

1. Dividir gradualmente `App.tsx` por feature quando novas telas forem adicionadas; fazê-lo agora seria uma refatoração grande sem ganho funcional imediato.
2. Criar testes de renderer com preload simulado para automatizar busca, filtros, paleta, abas e formulários.
3. Adotar virtualização somente se uma fila operacional passar a exibir milhares de itens simultâneos; a paginação atual resolve o caso real com menos complexidade.
4. Implementar tema escuro apenas se houver demanda de uso — os tokens já permitem essa evolução.
5. Versionar a linha de base no Git antes da próxima rodada grande de funcionalidades.
