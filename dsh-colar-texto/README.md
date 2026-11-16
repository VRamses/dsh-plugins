# dsh-colar-texto

Texto grande colado no composer do DSH vira **um chip**, como o `PASTED` do Claude, em
vez de ocupar a caixa inteira. O texto **nao e perdido nem truncado**: o chip carrega o
texto completo e o envio leva ele inteiro, na posicao em que o chip esta. Depois de
enviado, a mensagem tambem aparece **compacta no transcrito**, com expandir/recolher.

```
antes   [ 300.000 caracteres de JSON na caixa, cursor no fim, caixa rolando ]
depois  [ <> Texto colado · 299.720 caracteres ] e o envio leva o JSON inteiro
```

## O que ele faz exatamente

- Intercepta o `paste` no composer (`contenteditable` dentro de `[data-composer-card]`).
- Se o texto passar do limite, insere **um** `ReferenceChipNode` (o mesmo tipo de no dos
  `@arquivo` e `/habilidade`) com:
  - `label` = etiqueta curta (`Texto colado · N caracteres`, no idioma da interface);
  - `clipboardText` = **o texto colado**, que e o que o chip contribui para o rascunho e,
    portanto, o que vai no envio e no Ctrl+C.
- No transcrito, corta a altura da bolha da mensagem grande do usuario e oferece
  expandir/recolher. O texto continua **inteiro no DOM**: copiar, buscar na pagina e o
  contexto do modelo nao mudam, so a altura visivel.
- Nao desenha nada proprio, nao altera o bundle do DSH e nao guarda estado no host.

## Limites (ajustaveis por navegador, sem recompilar)

No console do navegador (ou em Configuracoes, se preferir) e so gravar no `localStorage`:

| chave | padrao | efeito |
|---|---|---|
| `dsh-colar-texto:caracteres` | `1500` | minimo de caracteres para virar chip (`0` desliga o criterio) |
| `dsh-colar-texto:linhas` | `25` | minimo de linhas para virar chip (`0` desliga o criterio) |
| `dsh-colar-texto:transcricao` | o valor de `caracteres` | limite proprio da compactacao no transcrito; `off` desliga so essa parte |
| `dsh-colar-texto:altura` | `min(34vh, 240px)` | altura visivel da bolha cortada (qualquer medida CSS) |
| `dsh-colar-texto` | ausente | `off` desliga o add-on inteiro |

Os limites sao lidos a cada colagem e a cada varredura do transcrito, entao valem na hora,
sem recarregar a pagina (a altura e lida quando o CSS e publicado, no carregamento).

## Comportamento quando algo falta

A ordem e **tentar inserir e so entao suprimir** a colagem. Se o escopo da sessao nao
resolver, se o composer estiver em fase de envio, ou se o DSH mudar o evento de insercao,
o handler nao faz nada e a colagem acontece como sempre. O add-on degrada para o
comportamento atual, nunca para um paste engolido. Erro inesperado sai no console com o
prefixo `[dsh-colar-texto]`.

## Expandir e recolher no transcrito

- Recolhida: um clique em qualquer lugar da bolha **expande**.
- Aberta: um clique na **faixa do rodape** (ultimos 40px) recolhe de novo. O clique no meio
  da mensagem nao recolhe, para nao fechar o texto no meio de uma selecao.
- A etiqueta ("clique para expandir" / "clique para recolher") e desenhada por CSS, com
  `content: attr(...)`, sem criar nenhum elemento no DOM do React.

## Limitacao conhecida

O rascunho persistido do DSH guarda so o **texto**, nao os chips. Sair da sessao e voltar
faz o texto reaparecer expandido na caixa (nada se perde). Enquanto a sessao esta aberta, o
chip e estavel, inclusive no desfazer (um Ctrl+Z remove o chip inteiro, nao o texto letra a
letra).

A compactacao do transcrito nao decide "esta mensagem veio de um paste": ela olha o tamanho.
Qualquer mensagem do usuario acima do limite sai compacta.


## Como ele funciona por dentro (para manutencao)

Duas descobertas do bundle `@deepseek-ai/dsh-client-ui-conversation` sustentam o add-on:

1. **O chip tem duas caras.** `ReferenceChipNode.label` e o que aparece na tela;
   `clipboardText` e o que a projecao `$projectComposer` usa como texto do rascunho. Um
   chip com `clipboardText` gigante mostra uma etiqueta curta e envia o texto inteiro.
2. **Existe um evento de escopo de sessao para inserir chip**, o mesmo que o menu de `/` e
   `@` usa:
   `actx.bail(actx, 'slash/input-insert-reference', { reference, span })`.
   O `span` (`{start, end, draftRev}` em coordenadas de "detect") vem do
   `inputActions.captureInsertion()`, que o `uiSession` entrega a qualquer componente de
   escopo de sessao. O listener do outro lado valida `span.draftRev` contra a revisao viva
   do rascunho, por isso o span e lido e usado sem nada assincrono no meio.
3. **Todo chip precisa de uma fonte com codec.** Quando o rascunho tem chips, o envio nao
   manda o `clipboardText`: `sinkSerialized` pergunta a forma de modelo de cada chip a fonte
   dona (`inputTriggers.serializeReference(source, ref)`) e troca o trecho do chip por ela.
   Sem uma fonte registrada com aquele `name`, o envio inteiro e recusado com
   `slash: no serializer for reference source "..."` e o rascunho volta para a caixa. Por
   isso o plugin registra a fonte `paste` (com `trigger: '/'`, `candidates` vazio e
   `showGroupTitle: false`, para nao mexer no menu de `/`) e guarda os textos num mapa
   `ref -> texto`, que e o unico dado que o serializador recebe.

O componente do plugin ocupa `conversation.input.overlay` (escopo de sessao) e nao renderiza
nada: ele existe so para ter `sessionId`, `inputActions` e `t` em maos.

A supressao da colagem usa `preventDefault` (cancela a insercao padrao do navegador) mais
`stopPropagation` (o listener de `paste` do Lexical fica no elemento raiz, na fase de bolha;
o nosso esta em `document`, na captura, e roda antes).

## A compactacao do transcrito, e por que ela e por DOM

O texto enviado **tem** de chegar inteiro ao modelo, entao o que sobra e o problema visual:
a bolha do usuario ocupa a tela e obriga a rolar. Isso e resolvido cortando a altura da
bolha, com o texto permanecendo inteiro no DOM.

Nao ha ponto de composicao para essa bolha: ela e renderizada pelo `dsh-client-ui-chat`
(`UserStyleBubble`) dentro de um no marcado com `data-chat-flow-kind`, e o renderer e um
occupant de **slot chaveado por tipo de no** (`conversation.chat.node`, chave `user`). O
registro de um `kind` repetido lanca erro e nao existe wrapper/fallback para plugin, entao
substituir o renderer significaria reimplementar a bolha inteira (anexos, cartoes de
arquivo, acoes, rodape) e congelar o visual numa copia. O caminho escolhido e o mesmo do
`dsh-painel-uso` para o anel de contexto: **marcar o elemento que ja existe e deixar o CSS
cortar**.

Cinco armadilhas, todas resolvidas (as duas primeiras custaram uma versao que nao marcava
nada):

1. **O outlet de slot tem `display: contents`.** Todo outlet do DSH e um
   `<div data-slot="..." style="display:contents">` (`dsh-client-ui-renderer`, constante
   `ANCHOR_STYLE`), e ele fica **entre** o no do transcrito e a bolha. Uma descida que pulasse
   `contents` (porque `max-height` nao funciona nesse display) parava no outlet e nao marcava
   nada. Por isso a busca **desce por qualquer elemento** e so depois escolhe quem da para
   cortar: o bloco mais interno cujo texto passa do limite. A faixa de anexos fica de fora
   (marcador proprio `data-message-attachments`), para a imagem ou o cartao nao serem cortados.
2. **O script dos modulos roda no `<head>`**, antes de existir `<body>` e muito antes de
   existir transcrito. O observer vai no `documentElement` (que existe desde o primeiro
   instante) e a varredura ainda e repetida num `requestAnimationFrame` e num `setTimeout` de
   600ms, para nao depender de uma mutacao acontecer.
3. **A classe da bolha e hash de CSS module** (`Sixlwa_bubble`), que muda a cada build: a bolha
   e achada por estrutura, nunca por nome de classe.
4. **Re-render do React nao apaga a marca.** O `className` da bolha tem o mesmo valor em todo
   render, e o diff do React so escreve no atributo quando o valor muda. Se o no for remontado
   (a lista pagina ao rolar), o `MutationObserver` marca de novo. A varredura e agendada com
   debounce de 250ms porque o transcrito muta a cada token do assistente.
5. **Nenhum elemento e criado no DOM do React.** A etiqueta sai de `content: attr(...)` num
   pseudo-elemento, e o clique que expande/recolhe e tratado por delegacao em `document`.

## Arquivos

| arquivo | papel |
|---|---|
| `index.js` | metade host: existe para o `dsh-client-modules` enxergar o pacote e publicar o `./client`; deixa um rastro de boot em `%TEMP%\dsh-colar-texto.log` |
| `client.js` | o add-on inteiro (bundle escrito a mao no formato `window.__ModuleLoader__.load`): listener de colagem + fonte/codec do chip |
| `package.json` | `dsh.client.platform = web` + `exports["./client"]` |

## Instalacao nesta maquina (desenvolvimento)

ATENCAO: o DSH serve o bundle a partir da **copia do perfil**, nao da pasta fonte. O
`pnpm install` do plugin manager importa a pasta `file:` para dentro de
`node_modules\dsh-colar-texto` e deixa a pasta de origem intacta (na primeira instalacao
deste add-on ele chegou a esvaziar a origem; os arquivos foram recuperados da copia). Entao,
depois de editar, copie para a copia viva:

```powershell
$fonte = 'C:\Users\Ramsés\Documents\DSH\dsh-colar-texto'
$perfil = "$env:APPDATA\dsh-desktop\harness\profiles\web\node_modules\dsh-colar-texto"
Copy-Item "$fonte\client.js" -Destination $perfil -Force
```

Fonte canonica: `C:\Users\Ramsés\Documents\DSH\dsh-colar-texto`, referenciada no
`package.json` do perfil como
`"dsh-colar-texto": "file:C:/Users/Ramsés/Documents/DSH/dsh-colar-texto"`, mais o bloco
`insert` no `cordis.patch.yml` (antes da sentinela dos MCPs).

Depois de mudar o `client.js`: recarregar a pagina (Ctrl+Shift+R, porque a URL do bundle
tem `?rev=` derivado do conteudo). Depois de mudar o `index.js` (metade host): fechar e
reabrir o DSH.

Se o plugin manager rodar `pnpm install` no boot ele **falha hoje** com
`ERR_PNPM_EPERM ... dsh-credit-widget` (a entrada do `dsh-credit-widget` em `node_modules` e
uma juncao, e o pnpm nao consegue substitui-la). A falha e anterior a este add-on, nao remove
entradas existentes e nao impede o carregamento; vale arrumar em separado.

## Teste de bancada

`teste-bancada.cjs` roda o `client.js` num ambiente falso (um `window`, um `document` e um
`ctx` de mentira, com DOM caseiro) e exercita as duas partes de ponta a ponta, sem navegador:
54 casos, sai 0 quando passa tudo.

```powershell
& "$env:APPDATA\dsh-desktop\harness\.desktop-bin\node.cmd" .\teste-bancada.cjs
```

O caminho do bundle sai da pasta do proprio arquivo, entao o teste roda igual na fonte e na
copia do perfil (passe outro caminho como primeiro argumento para testar outra copia).

O que ele cobre, e por que cada caso existe:

- a colagem vira chip (e o `preventDefault` so acontece quando a insercao devolveu `true`);
- colagem com arquivo, fora do composer, com o add-on desligado ou com o limite do
  `localStorage` nao viram chip;
- `U+FFFC` e a faixa privada saem do texto antes de virar chip;
- o codec devolve o texto certo para cada `ref`, e um `ref` desconhecido nao vira texto vazio
  (era o defeito que recusava o envio inteiro com `no serializer for reference source`);
- a bolha do transcrito e achada **atras do outlet `display: contents`**, e a marca fica nela e
  nao na linha, na pilha ou no run inline (foi o defeito da primeira versao);
- mensagem com anexo corta a bolha e nao a faixa de anexos; mensagem do assistente nao e tocada;
- clique expande, clique no meio da bolha aberta nao recolhe, clique no rodape recolhe;
- a varredura agendada (mutacao, primeiro quadro e 600ms) pega o no que so aparece depois da
  montagem;
- `dsh-colar-texto:transcricao = off` desliga so a compactacao do transcrito, e a chave aceita
  um limite proprio.

## Diagnostico

| sintoma | onde olhar |
|---|---|
| texto grande continua expandindo na caixa | `%APPDATA%\dsh-desktop\logs\harness.log` procurando `dsh-colar-texto` (erro de resolucao do pacote aparece la) |
| o log do host nao ganha linha depois de reiniciar | o plugin nao foi montado: conferir a linha no `cordis.patch.yml` e a juncao em `node_modules` |
| o chip nao aparece e o console mostra `[dsh-colar-texto]` | a insercao falhou: o span provavelmente nao bateu com a revisao do rascunho |
| a bolha do transcrito nao corta | conferir se o DSH ainda marca os nos com `data-chat-flow-kind` (`user`, `steering`, `turn-trigger`) e os provisorios com `data-submission-echo` / `data-pending-steering`; e o unico acoplamento estrutural desta parte |
| quer conferir o que foi marcado | no console: `document.querySelectorAll('.dct-recolhida').length` e `localStorage['dsh-colar-texto:transcricao']` |
