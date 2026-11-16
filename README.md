# Plugins de instância do DSH

Fonte de download dos seis plugins feitos para o DSH Desktop do Ramses. Cada pasta na raiz é o pacote inteiro, sem `node_modules`, para ser copiada para `Documents\DSH` com o mesmo nome e montada no perfil.

Este repositório é **espelho de leitura**: a cópia de trabalho fica em `Documents\DSH` da máquina principal, e a receita de montagem (id do patch, config, o que conferir) está no vault de memória, em `notes/topics/plugins-instancia.md`. O manifesto `plugins.json` repete os dados que uma instância precisa para conferir e montar sozinha.

## O que tem aqui

| pasta | versão | o que faz | metade de tela | monta por |
|---|---|---|---|---|
| `dsh-navegador` | 0.5.0 | tools `navegador_*` e a extensão do Opera | não | dep `file:` + row `dsh-navegador` |
| `dsh-painel-uso` | 0.1.0 | saldo, consumo e contexto no composer | sim | dep `file:` + row `painel-uso` |
| `dsh-colar-texto` | 0.1.0 | texto grande colado vira chip | sim | dep `file:` + row `dsh-colar-texto` |
| `dsh-deepseek-web` | 0.1.0 | botão que abre o chat.deepseek.com | sim | dep `file:` + row `deepseek-web` |
| `dsh-subagent-lean` | 0.1.0 | allow list dos subagentes | não | pasta em `node_modules` + row `subagent-lean-tools` |
| `dsh-filtro-tools` | 0.1.0 | tira `ppt` e `office` do schema | não | junção em `node_modules` + row `filtro-tools` |

"Metade de tela" quer dizer que o pacote traz `dsh.client` e é servido em `/plugins/<nome>/client.js`; sem ela, o plugin só tem a metade de host e precisa da row no `cordis.patch.yml` para montar.

## Baixar

```
git clone --depth 1 https://github.com/VRamses/dsh-plugins.git "%TEMP%\dsh-plugins"
```

Depois copie as pastas que faltam para `Documents\DSH`. Se a instância tiver o vault de memória, o script `manutencao\plugins-instancia.ps1 -Conferir` diz o que falta e `-Baixar` copia só o que falta, sem sobrescrever pasta existente.

O download também funciona sem git, pelo zip do branch:

```
https://github.com/VRamses/dsh-plugins/archive/refs/heads/main.zip
```

## Instalar

A montagem tem quatro formas e a forma é parte da receita: dep `file:` no `package.json` do perfil (instala por hardlink), row `- insert:` no `cordis.patch.yml`, pasta ou junção em `node_modules`, e bundle (só para pacote de npm). O detalhe por plugin, com o bloco exato do patch, está na nota do vault.

Três destes plugins também têm instalador de arquivo único no vault, em `manutencao\`: `instalar-navegador.ps1`, `instalar-painel-uso.ps1`, `instalar-colar-texto.ps1` e `instalar-subagent-lean.ps1`. Eles geram o bloco do patch e o vínculo com o perfil, e são o caminho mais seguro numa instância nova.

Duas armadilhas medidas:

- bloco de plugin local precisa ficar **antes** da sentinela "MCPs hospedados no host central" no `cordis.patch.yml`, porque o `instalar-cliente.ps1` reescreve tudo o que vem depois dela;
- a metade de host (`index.js`) só passa a valer depois de reiniciar o Harness, não basta recarregar a página.

## O que não está aqui, e por quê

`dsh-credit-widget` foi removido do perfil em 12/11/2026 (fonte preservada na máquina, para rollback) e `dsh-chat-magro` é experimento de preset e allowlist, nunca montado. Os shims `dsh-mcp-client-shim` e `dsh-tools-shim` são infraestrutura da máquina, não plugin de instância.
