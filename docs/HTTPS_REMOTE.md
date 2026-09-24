# Acesso remoto HTTPS — preparação

Esta etapa mantém o SQLite no servidor e usa a API existente. O Cloudflare Tunnel roda somente no PC servidor; a origem do túnel deve ser `http://127.0.0.1:8787`. Não abra a porta 8787 no roteador.

## Servidor

Configure `GESTAO_SERVER_DATA` para o diretório central autorizado, `GESTAO_API_HOST=127.0.0.1` e `GESTAO_API_PORT=8787`, e inicie `npm run server:lan`. O nome do comando permanece por compatibilidade; com esse host, a API aceita apenas conexões locais. Confirme `http://127.0.0.1:8787/health` no próprio servidor antes de ativar o túnel. Use um túnel nomeado e domínio HTTPS estável; configure o serviço `cloudflared` para iniciar com o Windows. Faça backup e defina qual cópia SQLite será a fonte oficial antes de usar dados reais.

## Cliente

O administrador provisiona `gestao-client.json` no diretório `userData` do usuário que executará o aplicativo, antes da primeira abertura:

```json
{
  "transport": "http",
  "apiUrl": "https://SEU-DOMINIO-ESTAVEL",
  "mode": "https-remote"
}
```

A URL deve ser uma origem HTTPS pública exata, sem caminho, usuário, senha ou query. Também é aceito `GESTAO_CLIENT_CONFIG` apontando para um arquivo absoluto administrado. Configuração remota inválida ou arquivo explicitamente indicado mas ausente interrompem a inicialização; não há retorno silencioso ao SQLite local. O funcionário não precisa de `cloudflared`, Node ou comandos durante o uso normal. **O instalador atual ainda não provisiona esse arquivo**; portanto o fluxo “instalar, abrir, entrar” depende de uma etapa de implantação administrada até que a URL definitiva seja fornecida e incorporada à distribuição.

O cliente HTTPS atual oferece login, listagem, ficha, dashboard e edição. Clientes, anexos, importação, marcos, ações em massa e integrações continuam indisponíveis no transporte HTTP. Não se deve anunciar operação remota completa antes de implementar e testar essas rotas.

## Validação antes do uso real

O login limita a dez falhas por IP em quinze minutos e responde `429` durante o bloqueio. Quando a API é acessada pelo Cloudflare Tunnel, usa o cabeçalho `CF-Connecting-IP`; como a API deve ficar vinculada ao loopback, clientes externos não podem enviar esse cabeçalho diretamente à origem. A limitação é mantida em memória do processo e reinicia junto com a API.

Execute os smokes locais, valide o certificado e a URL HTTPS a partir de outra rede, teste login, edição, conflito 409, queda e volta do servidor, e confirme que os dois PCs observam o mesmo pedido. Verifique backup e integridade do SQLite central. O teste por túnel e dois computadores físicos exige a URL e acesso ao servidor da empresa.
