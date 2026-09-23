# Piloto LAN — Gestão Logística

Este piloto usa uma cópia controlada do banco. Não aponte `GESTAO_SERVER_DATA` para o banco operacional original.

## Computador servidor

Abra PowerShell em `E:\GestaoLogistica_DEV`.

### Banco de piloto

A cópia inicial já foi criada em `E:\GestaoLogistica_Server_Pilot\data`. Para recriá-la deliberadamente, remova antes o diretório de destino e execute:

```powershell
$env:GESTAO_PILOT_SOURCE_DB='C:\Users\Logistica\AppData\Roaming\gestao-logistica\GestaoLogistica\gestao-logistica.sqlite3'
$env:GESTAO_SERVER_DATA='E:\GestaoLogistica_Server_Pilot\data'
npm run pilot:prepare
```

O script usa `VACUUM INTO`, cria backup preventivo no piloto, executa as migrações oficiais e recusa sobrescrever um piloto existente.

### Criar usuários do piloto

```powershell
$env:GESTAO_SERVER_DATA='E:\GestaoLogistica_Server_Pilot\data'
npm run user:create
```

Execute uma vez para cada pessoa. A senha é digitada no terminal e não deve ser registrada em arquivo.

### Descobrir o IPv4

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.AddressState -eq 'Preferred' } | Format-Table InterfaceAlias,IPAddress
```

Use o IPv4 da interface Ethernet ou Wi-Fi conectada à rede privada da empresa.

### Firewall privado

Em PowerShell como Administrador:

```powershell
New-NetFirewallRule -DisplayName 'Gestao Logistica LAN Pilot 8787' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Profile Private -RemoteAddress LocalSubnet
```

### Iniciar a API

```powershell
cd E:\GestaoLogistica_DEV
$env:GESTAO_SERVER_DATA='E:\GestaoLogistica_Server_Pilot\data'
$env:GESTAO_API_HOST='0.0.0.0'
$env:GESTAO_API_PORT='8787'
npm run server:lan
```

Mantenha essa janela aberta. Em outra janela, confirme:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## Computador cliente

Instale `Gestão Logística Setup 0.1.0.exe`, gerado em `E:\GestaoLogistica_DEV\release`.

Crie `C:\GestaoLogistica_Pilot\gestao-client.json`, substituindo `IP_DO_SERVIDOR`:

```json
{
  "transport": "http",
  "apiUrl": "http://IP_DO_SERVIDOR:8787",
  "mode": "lan-pilot"
}
```

Inicie o cliente pelo PowerShell:

```powershell
$env:GESTAO_CLIENT_CONFIG='C:\GestaoLogistica_Pilot\gestao-client.json'
& "$env:LOCALAPPDATA\Programs\gestao-logistica\Gestão Logística.exe"
```

Faça login com o usuário criado no banco de piloto. O arquivo não contém senha ou token.

## Roteiro físico

1. Nos PCs A e B, abra o mesmo pedido e confirme os mesmos dados.
2. No PC A, salve `Observação teste PC A`; recarregue no PC B e confirme.
3. No PC B, salve `Observação teste PC B`; recarregue no PC A e confirme.
4. Abra a mesma revisão nos dois PCs, salve em A e tente salvar em B sem reabrir. Confirme `REVISION_CONFLICT` e preservação da alteração de A.
5. No histórico, confirme os respectivos usuários e que a tentativa em conflito não criou evento.

O smoke LAN simula a rede localmente; ele não substitui a validação em dois computadores físicos.
