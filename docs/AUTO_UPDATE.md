# Auto-update do Gestão Logística para Windows

O aplicativo usa `electron-updater` com o target NSIS já existente. O feed é GitHub Releases público e é gravado dentro do build; a aplicação não lê origem de atualização fornecida pelo usuário. Sem owner/repositório configurados no build, o updater fica desativado e o aplicativo continua funcionando normalmente.

## Primeira instalação e bootstrap

A versão atualmente instalada no PC do funcionário não contém o updater e não pode atualizar a si própria. Instale manualmente uma vez um build novo que contenha esta implementação. O `appId` e o nome de produto continuam iguais, portanto o update/instalador NSIS mantém `%APPDATA%\gestao-logistica` e seus arquivos (configuração remota, sessão protegida por `safeStorage` e preferências). Depois desse bootstrap, as próximas versões podem chegar pelo updater.

## Configuração única do repositório

Não há remote Git configurado neste checkout. Quando o repositório público de releases estiver definido, o build receberá o owner e o nome exato do repo em `GESTAO_UPDATE_GITHUB_OWNER` e `GESTAO_UPDATE_GITHUB_REPO`. Esses valores são embutidos no metadata de update do NSIS; não são inputs do aplicativo instalado. Releases privados não funcionam para os funcionários sem credenciais pessoais no cliente e não são suportados por este fluxo.

O workflow `.github/workflows/publish-updates.yml` publica builds Windows ao enviar uma tag SemVer igual à versão no `package.json`; ele usa o `GITHUB_TOKEN` do próprio GitHub Actions, sem salvar token no repositório. Após conectar este código ao repo público correto:

1. Publique primeiro a versão bootstrap `v0.1.0` com este código e instale manualmente o setup dessa release no PC funcionário. O cliente 0.1.0 antigo não contém updater e não consegue se atualizar sozinho.
2. Incremente a versão SemVer no `package.json` (por exemplo, `npm version patch`, que também atualiza `package-lock.json` e cria a tag local).
3. Envie o commit e a tag correspondente: `git push origin master --follow-tags`.
4. O workflow cria uma GitHub Release e envia os artefatos NSIS e metadata.

Para publicar manualmente no Windows, defina os dois valores acima e `GH_TOKEN` com permissão `contents: write` para o repo; então execute `npm run publish:windows`. O segredo é usado somente no processo de publicação e não é escrito no app.

## Fluxo do funcionário

Ao abrir uma versão empacotada Windows com feed configurado, o app carrega normalmente e verifica após 10 segundos. Ausência de versão nova não exibe mensagem. Uma falha de rede é registrada em `logs/updater.log` dentro do perfil do usuário e não bloqueia o login ou o uso.

Quando existir uma versão SemVer mais nova, aparece um aviso discreto com **Atualizar agora** e **Depois**. O download só começa após clique e exibe progresso. Ao terminar, **Reiniciar e atualizar** chama o instalador NSIS; o aplicativo não fecha nem instala sozinho. O botão **Depois** dispensa o aviso até a próxima abertura.

## Artefatos

`npm run dist` gera o setup Windows em `release/` sem publicar. Com a configuração de release, o pacote NSIS inclui `resources/app-update.yml`. A publicação inclui `latest.yml` (manifesto que anuncia versão, hash e caminho), o instalador `Gestão Logística Setup <versão>.exe` e o `.blockmap` gerado pelo NSIS para downloads diferenciais. Todos os assets emitidos para a release devem permanecer juntos; o cliente consulta o manifesto `latest.yml`.

O teste de eventos/download/reinício sem rede real é `npm run smoke:updater`; `npm run smoke:updater-config` verifica o build metadata. Depois do bootstrap manual 0.1.0, publique 0.1.1 para provar detecção, download, consentimento para reiniciar e preservação do perfil de usuário.

Para um build local isolado sem substituir artefatos existentes em `release/`, defina `GESTAO_BUILD_OUTPUT_DIR` com um nome de pasta e execute `npm run dist`. `GESTAO_ELECTRON_DIST` é um override opcional para apontar a uma distribuição Electron Windows já instalada localmente, útil quando o Windows bloqueia a extração temporária do pacote baixado.
