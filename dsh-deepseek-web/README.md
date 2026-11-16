# dsh-deepseek-web

Botao na barra lateral do DSH Desktop que abre o **chat.deepseek.com** (o DeepSeek
gratuito) no navegador padrao, ao lado do Harness.

Ele nao embute o site e nao tenta: e um link, e quem abre o navegador e a propria
casca Electron.

## O que ele faz

- Ocupa o slot `sidebar.footer.action` (slot de lista, escopo root) com um link
  para `https://chat.deepseek.com/`, na faixa logo acima de "Settings".
- Com a barra recolhida (`wide: false`) mostra so o icone.
- Nenhuma metade de host com trabalho: nao ha rota, nao ha credencial, nao ha
  dado saindo do processo.

## Por que um link e nao um painel embutido

A casca do DSH bloqueia pagina de terceiro dentro da janela, de proposito
(`resources\app\out\main\index.js`):

- `webviewTag` nao esta ligado e `will-attach-webview` e cancelado em toda janela;
- `isHarnessUrl` so confia em `http:` para `127.0.0.1`/`localhost`, alem de `file:`
  e `dsh-recovery:`;
- `setWindowOpenHandler` e `will-navigate` mandam qualquer outro http/https para
  `shell.openExternal`, ou seja, para o navegador padrao.

Ou seja: este link e o comportamento suportado da casca, nao uma contorno dela.
Embutir o site exigiria furar justamente a regra que mantem pagina de terceiro
fora do app. Alem disso `chat.deepseek.com` responde 403 a cliente que nao e
navegador (protecao Cloudflare), entao um painel embutido brigaria com o site.

## Como esta instalado

No perfil `web` (`%APPDATA%\dsh-desktop\harness\profiles\web`):

1. `package.json` declara a dependencia `file:`:
   `"dsh-deepseek-web": "file:C:/Users/victo/Documents/DSH/dsh-deepseek-web"`.
2. `pnpm-lock.yaml` tem a entrada correspondente no importer e no snapshot.
3. `node_modules\dsh-deepseek-web\` tem **hardlink** para `client.js`, `index.js`
   e `package.json` deste diretorio.
4. `cordis.patch.yml` tem a linha de insert, **antes** da sentinela
   `MCPs hospedados no host central` (o `instalar-cliente.ps1` reescreve tudo o
   que vem depois dela):

   ```yaml
   - insert:
       - id: deepseek-web
         name: 'dsh-deepseek-web'
   ```

O patch do perfil e `patchReload: live`, entao inserir a linha ja faz o host
montar o plugin; o bundle aparece no manifesto da pagina
(`window.__DSH_BOOT__`) e e servido em
`/plugins/??dsh-deepseek-web/client.js&rev=<rev>`.

## Como conferir

```powershell
# 1. o pacote resolve a partir do perfil
& "$env:APPDATA\dsh-desktop\harness\.desktop-bin\node.cmd" --input-type=module `
  -e "import('dsh-deepseek-web').then(m => console.log('OK', Object.keys(m)))"
# rodando com workdir no diretorio do perfil

# 2. o host serve o bundle (o token sai do harness.log, na linha "dsh web:")
#    o id tem de aparecer no __DSH_BOOT__ do HTML
```

Depois, na interface: recarregar com `Ctrl+Shift+R` e olhar a barra lateral
lateral, logo acima de "Settings".

## Como remover

1. Tirar a linha `- id: deepseek-web` do `cordis.patch.yml` do perfil.
2. Tirar a dependencia do `package.json` (e as entradas do `pnpm-lock.yaml`).
3. Apagar `node_modules\dsh-deepseek-web`.
4. Recarregar a pagina.

## Fonte

`C:\Users\victo\Documents\DSH\dsh-deepseek-web` (este diretorio). Depois de
editar, `.\sincronizar.ps1` refaz o vinculo dos arquivos no perfil.
