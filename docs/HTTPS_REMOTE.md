# Cliente remoto HTTPS — piloto Quick Tunnel

Esta etapa mantém o SQLite no servidor e usa a API existente. O Cloudflare Tunnel roda somente no PC servidor; a origem do túnel deve ser `http://127.0.0.1:8787`. Não abra a porta 8787 no roteador.

## Configuração pública do cliente

O cliente remoto consulta `https://raw.githubusercontent.com/luizphotoshop25-prog/gestao-logistica/master/remote-config.json` em toda inicialização. O arquivo contém somente `apiBaseUrl`, `environment` e `enabled`; não contém tokens, senhas ou dados operacionais. A aplicação aceita apenas HTTPS em `*.trycloudflare.com` durante o piloto.

Uma URL válida é armazenada atomicamente em `%APPDATA%` no arquivo `gestao-client-cache.json`. Se o GitHub estiver indisponível, o aplicativo reutiliza esse último valor válido. Sem cache, ou com a configuração explicitamente desativada, não abre janela local nem inicializa SQLite; mostra a mensagem de conexão com opções para tentar novamente ou fechar. Se a API ficar indisponível depois da leitura da configuração, o aplicativo permanece em HTTP e exibe a tela de login com tentativa de reconexão.

## Servidor

No PC servidor, o script `E:\GestaoLogistica_Server_Pilot\tools\start-gestao-logistica-pilot.ps1` inicia a API em `127.0.0.1:8787` usando `E:\GestaoLogistica_Server_Pilot\data`, inicia o Quick Tunnel, testa `/health` no loopback e na origem HTTPS, e atualiza somente `remote-config.json` pelo `gh` já autenticado. Ele confirma o arquivo público no GitHub sem imprimir token. Não execute esse script no PC do funcionário.

Ao reiniciar o script, ele substitui somente o processo Quick Tunnel anterior registrado pelo próprio script, obtém uma URL nova, valida `/health` e publica a URL atual. A API central precisa permanecer ativa para os funcionários acessarem clientes, pedidos e solicitações.

## Instalador cliente remoto

As releases Windows do workflow são explicitamente compiladas como CLIENTE REMOTO e incluem um manifesto de perfil em `resources/client-build.json`. Os builds locais sem a flag continuam sendo perfil local/desenvolvimento. Um pacote sem manifesto válido interrompe a inicialização, sem abrir o SQLite local.

O NSIS cria os atalhos “Gestão Logística” na Área de Trabalho e no Menu Iniciar. Ambos abrem o mesmo executável e perfil remoto. A abertura automática pós-instalação também consulta `remote-config.json`; a falta de configuração não permite retorno silencioso a IPC.

O cache e a sessão protegida pelo `safeStorage` ficam no perfil do usuário e são mantidos por atualizações normais. Uma mudança de Quick Tunnel atualiza apenas o JSON público, sem reinstalação do cliente.

## Validação antes do uso real

O login limita a dez falhas por IP em quinze minutos e responde `429` durante o bloqueio. Quando a API é acessada pelo Cloudflare Tunnel, usa o cabeçalho `CF-Connecting-IP`; como a API deve ficar vinculada ao loopback, clientes externos não podem enviar esse cabeçalho diretamente à origem. A limitação é mantida em memória do processo e reinicia junto com a API.

Execute os smokes locais, valide o certificado e a URL HTTPS a partir de outra rede, teste login, edição, conflito 409, queda e volta do servidor, e confirme que os dois PCs observam os mesmos pedidos e solicitações. O transporte HTTP disponível também dá suporte a clientes e Solicitações. A validação final em dois computadores físicos depende da disponibilidade do PC servidor e do Quick Tunnel.
