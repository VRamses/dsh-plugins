# Handoff: add-on `dsh-navegador`

Documento de passagem. Ele diz **o que foi construído, o que foi medido, o que
fica pendente e por quê**, para quem (ou qual agente) continuar isso daqui a
algum tempo não precisar refazer a investigação.

Data: 16/10/2026, com atualizações em 21/10/2026. Máquina: SUPERCOLLIDER. DSH
Desktop 0.12.1 (o add-on foi escrito no 0.11.1, harness `dsh` 0.2.0-rc.2), Opera
GX 136.

---

## 1. O que existe hoje

```
C:\Users\victo\Documents\DSH\dsh-navegador\
  package.json        o pacote É a raiz do repositório; main aponta para plugin/index.js
  plugin\             metade host (Cordis, ESM)
  extensao\           metade navegador (MV3)
  ferramentas\        instalação, testes e diagnóstico
  README.md           o documento para o usuário
  HANDOFF-navegador.md  este arquivo
```

Instalado no perfil `web` por `ferramentas\instalar-no-perfil.ps1` (junção em
`node_modules`, dependência `file:` e bloco no `cordis.patch.yml` antes da
sentinela). O bloco está no patch com `config: { pareamento: true }`.

### 1.1 De onde vem o desenho: o que os add-ons do Claude e do Gemini fazem

O pedido foi "um add-on para o Opera que funcionasse de forma semelhante aos do Gemini e
do Claude", então fui ler como os dois se comportam antes de desenhar.

**Claude in Chrome** (fonte: [guia de permissões oficial](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide),
de 12/08/2026). Funciona num **painel lateral** da extensão, preso à aba em que você
está, e tem três modos de permissão escolhidos no próprio campo de conversa:

- **Manually approve**: pausa e pede aprovação **antes de cada ação**; no painel
  clássico, antes disso, monta um **plano** por prompt, que lista **em quais sites** ele
  vai entrar e é aprovado antes de começar. Depois do plano aprovado ele age sozinho
  dentro do combinado, mas volta a pedir em ação sensível (baixar arquivo, digitar dado
  sensível, conceder autorização).
- **Automatically approve**: age sem parar para perguntar, com uma checagem de segurança
  por ação que bloqueia o que ela julga inseguro e volta a pedir quando precisa.
- **Skip all approvals**: não pergunta e nada confere. O guia diz explicitamente para
  usar só quando você confia em tudo que está envolvido na tarefa.
- **Permissão por site**: "sempre permitir neste site" guarda aval por origem, e há uma
  tela de sites aprovados e histórico.
- **Proibidos em qualquer modo**: comprar, criar conta, lidar com cartão ou documento,
  apagar de vez, mexer em arquivo de sistema e **seguir instrução vinda de e-mail ou de
  conteúdo de página** (prompt injection).

**Gemini in Chrome**: painel lateral que enxerga **a página em que você está** e responde
sobre ela, sem trocar de aba. Pelo que a imprensa mostrou no lançamento por região, é um
"perguntar sobre esta página" com o mesmo recorte de escopo: a aba atual.

**O que eu adotei**

| comportamento | Claude in Chrome | aqui |
|---|---|---|
| onde mora | painel lateral | painel (no Opera, janela, ver 3.9) |
| escopo | a aba atual, com aval por site | **a aba atual**, e o contexto vai no texto do prompt |
| ler | livre | livre (`navegador_ler` não pede aprovação) |
| agir | pergunta antes de cada ação no modo manual | **só manual, ação por ação**, com cartão no painel |
| histórico | a conversa da sessão do serviço | sessões reais do DSH, na pasta `Add-on Opera` |

**O que eu deliberadamente não copiei, e por quê**

- **Plano aprovado antes de começar.** O DSH não trabalha em plano fechado, e o Ramses
  pediu "agir quando eu pedir, com aprovação por ação". Um plano aprovado no começo daria
  aval a ações que ninguém revisou, que é o oposto do pedido.
- **Modo automático.** O Claude tem um classificador de segurança por ação; este add-on
  não tem nenhum. Um "aprovar tudo" sem essa rede seria pior que o Claude sem a rede dele.
- **Permissão por site.** Aqui o escopo é a aba, não a origem: o painel manda o texto da
  aba que ele anunciou, e não há allowlist de sites. Numa aba nova o contexto é novo.
- **Lista de ações proibidas.** Quem decide é o humano no cartão. Isso é mais permissivo
  de propósito (o agente do DSH roda com `danger-full-access`), e é exatamente por isso
  que a aprovação por ação é obrigatória neste add-on.
- **Nuvem.** Claude e Gemini conversam com serviço remoto. Aqui o painel conversa com a
  **instância local** do DSH, na conta do Ramses, e é isso que faz o histórico, as
  ferramentas e os MCPs dele valerem dentro do navegador.

---

## 2. Fatos medidos que custaram tempo (não re-descobrir)

### 2.1 Autenticação do `/api` do DSH

O `/api` do `dsh web` é fechado por um cookie de sessão do navegador
(`dsh-auth-<b64url sha256(authority)>`, `HttpOnly`, `SameSite=Strict`,
autoridade amarrada). **Nenhuma extensão alcança esse cookie**, e devolver o
cookie para uma página não funciona porque a página não lê resposta
cross-origin. Por isso a ponte tem token próprio.

Os três cadeados do `/api` (úteis para quem for testar com `fetch` puro): cerca
de `Host` (tem de ser loopback), recusa de `sec-fetch-site: cross-site` e
`Origin` diferente do `Host`.

### 2.2 O gateway interno é o caminho, e não o `/api`

`ctx.get('typertGateway')` expõe `invokeRpc(endpoint, {args}, signal, peer)`,
`stream({namespace, method, args, signal})`, `prepareInvocation`,
`resolveDescriptor` e `operatorPeer`. Chamar pelo gateway **em processo** dispensa
cookie, WebSocket e HTTP interno. A ponte usa isso.

Se um dia precisar mexer no `/api` por fora, o `ferramentas\dsh-rpc-lib.mjs` do
workspace (o cliente antigo) sabe forjar o cookie a partir do
`.credentials.yaml`.

### 2.3 A chave do envelope de argumentos NÃO é sempre `request`

Isto é a armadilha mais cara da ponte. Medido com
`ferramentas\mapear-endpoints.mjs`, que lê os 141 descritores de dentro do
`app.asar`:

| forma | exemplos |
|---|---|
| `{ request: ... }` | `session/prompt`, `session/create`, `session/cancel`, `session/projections`, `session/follow`, `job/kill`, `skills/list`, `messageFeedback/*` |
| `{ _request: ... }` | **só** `session/list` |
| sem envelope | `agentPresets/list` (nenhum parâmetro), `session/modelCatalog`, `llm/listProviders`, `pluginInventory/list`, `account/getState`, `commands/list {agentId}`, `fileReferences/list {agentId, query}`, `goals/* {agentId, ...}`, `userQuestions/answer {agentId, callId, answer}` |

Errar dá `args fields do not match the descriptor`. A tabela viva está em
`extensao/painel/api.js` (`COM_REQUEST` e `COM_UNDERSCORE_REQUEST`). **Endpoint
novo se confere naquele script, não no chute.**

Detalhe: `session/list` aceita `{}` (o parâmetro é opcional), mas **rejeita**
`{request:{}}` com "unexpected request".

### 2.4 Os quadros do `session/follow`

- primeiro quadro: `{type:'snapshot', header, cursor, records, hasMore, projections:{asOfSeq,values}, assistantStream}`;
- depois: `{type:'event', event:{type,seq,time,data}}` e
  `{type:'assistant-stream', frame}`;
- **as projeções NÃO vêm no fluxo depois do retrato.** Quem atualiza título,
  tokens, tarefas e perguntas é uma chamada `session/projections` separada (o
  painel faz isso a cada 4 s);
- `frame` do texto ao vivo: `start`, `chunk` com
  `chunk:{type:'block-start'|'text-delta'|'reasoning-delta'|'tool-call-delta'|'block-end'|'usage'|'finish'}`,
  e `end`. O `index` do BLOCO é `frame.chunk.index` (o `frame.index` é o índice do
  quadro, monotônico);
- **o raciocínio chega vazio no evento durável** (`assistant/message` com
  `{type:'reasoning', text:''}`) quando o provedor não o persiste, então o
  raciocínio capturado ao vivo é a única fonte e o transcrito o transfere para o
  item quando o evento durável chega;
- `assistant/message` traz blocos `reasoning`, `tool-call` e `text`; as
  ferramentas são pareadas por `tool/call` + `tool/result` (mesmo `callId`).

### 2.5 O patch do perfil é recarregado, mas o MÓDULO do plugin não

Medido duas vezes em 16/10/2026, com um marcador que era a versão lida do
`package.json`:

1. mexer no patch (config) → a config nova vale, **versão antiga continua**;
2. **remover** o bloco inteiro → a rota responde 404 (a limpeza funciona);
3. **reinserir** o bloco → a rota volta, **versão antiga continua**.

Conclusão: o módulo é importado uma vez por processo. **Mudança de código do
plugin exige fechar e reabrir o DSH Desktop.** Mudança na extensão só exige o
botão Recarregar. Não perca tempo procurando um jeito de recarregar a quente.

### 2.6 O `fetch` do Node descarta o cabeçalho `Host`

Um teste de cerca de `Host` feito com `fetch` **sempre passa**, e mente. Use
`node:http` (`pedidoCru` em `ferramentas/testar-ponte.mjs`).

### 2.7 O corpo de TODA chamada da ponte é `{ args: ... }`

Três tentativas perdidas em 17/10/2026 por causa disto. O corpo que a ponte aceita é
sempre `{ args: <envelope do endpoint> }`, e o envelope (`{request: ...}` para quase
tudo, `{_request: ...}` para `session/list`, nenhum para `agentPresets/*`) fica
**dentro** do `args`:

```json
{ "args": { "request": { "sessionId": "session-..." } } }
```

Mandar só `{"request": ...}` devolve `o corpo precisa ter exatamente a chave args`, e
mandar `{"args": {}}` num endpoint que quer `request` devolve o mesmo erro. No painel
quem monta isso é `Ponte.rpc` (`body: { args: envelope(endpoint, args) }` em
`extensao/painel/api.js`), então isto vale para quem chama a ponte de fora do painel:
script de teste, `curl`, outro agente.

Duas armadilhas da mesma família, medidas no mesmo dia:

- **arquivo JSON escrito pelo PowerShell 5.1 leva BOM**, e o gateway responde
  `o corpo nao e JSON`. Ler com `[IO.File]::ReadAllText($caminho, [Text.Encoding]::UTF8)`
  ou tirar o BOM (`replace(/^\uFEFF/, '')`) antes de mandar;
- **o registro de presets é lido no boot**: arquivo novo em `.agent-presets` não aparece
  nem em `agentPresets/list` nem em `read` enquanto o processo não reiniciar. Fechar a
  janela não reinicia: o app fica na bandeja, e a prova de um reinício de verdade é o
  PID da ponte mudar.

---

## 3. Testes que existem, e o que cada um já provou

Rodados em 16/10/2026 contra o DSH vivo (PID 34404, porta 43129):

| comando | resultado |
|---|---|
| `testar-ponte.mjs diagnostico` | 14 ok, 0 falha: `ola`, pareamento estável, `sinal`, `session/list` (82 sessões), `agentPresets/list` (5), `session/modelCatalog`, `pluginInventory/list`, `llm/listProviders` (3), `account/getState`, `session/projections`, `commands/list`, `fileReferences/list`, `aba` |
| `testar-ponte.mjs seguranca` | 11 ok, 1 falha: 401 sem token e com token errado, 403 para `terminal/list`, `settings/read` e `fluxo/terminal/follow` fora da lista, 403 para `Origin` de página no `/parear`, 403 para `Host` que resolve para fora (HTTP cru), 404 em rota desconhecida, sem CORS. A falha é o corpo fora do envelope, que só passa a dar 400 depois do restart (correção escrita, não carregada) |
| `testar-ponte.mjs ponta-a-ponta` | 7 ok, 0 falha: criou sessão descartável, `session/follow` com deltas (2 `text-delta`), `session/prompt` aceito, turno terminou em 5 s com "OK.", mensagem durável chegou, sessão apagada |
| `testar-ponte.mjs perguntas` | 4 ok, 0 falha: o painel detecta a pergunta pendente, lê o id (`cor`) e as duas opções; e fica registrado que `userQuestions.active` fica vazio na variante `legacy` |
| `testar-transcrito.mjs --meu` | 6 ok, 0 falha, com os quadros reais de uma sessão: 70 itens, nenhuma mensagem de usuário duplicada, 37 itens de assistente, 39 ferramentas com resultado e nenhuma presa, ordem de sequência preservada, raciocínio preservado |
| `conferir-extensao.mjs` | 11 ok, 0 falha: 36 ids de elemento conferidos contra o HTML, 30 campos de `tela` e 20 de `ui`, as 9 APIs do Chrome contra as permissões do manifesto, 6 arquivos citados no manifesto, 7 imports relativos, os tipos de mensagem do painel contra os `case` do worker, e as duas funções injetadas provadas auto-suficientes |
| `testar-transcrito.mjs --sintetico` | 8 ok, 0 falha: eco local não duplica a mensagem durável, boilerplate do DSH fica fora, resposta a pergunta e troca de modelo viram aviso, pergunta pendente entra e sai |
| `navegador_ler` / `navegador_agir` | com um painel falso (`testar-ponte.mjs painel-falso`) responderam certo; com `DSH_TESTE_RESPOSTA=recusar` a ação voltou "o usuário recusou"; sem painel aberto as duas falham com a mensagem que manda abrir o painel |
| **teste no navegador de verdade** | seção 3.1: extensão carregada no Opera GX 136, painel conectado, leitura, ação com aprovação, recusa, digitação, print e contexto da aba na sessão |

**Dois defeitos reais que só a conferência estática pegou** (16/10/2026), e é por
isso que ela existe:

1. **`lerNaPagina` chamava `extrairTexto` e `listarElementos`, que estavam no
   nível do módulo.** O `chrome.scripting.executeScript` serializa só o corpo da
   função, então na página essas duas funções não existem: **toda leitura de aba
   teria falhado** com "extrairTexto is not defined", e só na cara do usuário.
   Corrigido movendo as duas para dentro de `lerNaPagina` (e o `MARCA`, que
   virou um `marca` local). A conferência agora reprova qualquer função injetada
   que cite um nome de fora.
2. **`chrome.sidePanel` era usado sem a permissão `sidePanel` no manifesto**, o
   que faria o painel lateral do Chrome/Edge nunca abrir pelo ícone. A permissão
   entrou. No Opera o aviso de chave desconhecida (`side_panel` e `sidePanel`) é
   esperado e está documentado no README.

### 3.1 O teste no navegador de verdade (17/10/2026)

Até aqui a extensão nunca tinha rodado num navegador. Rodou: **Opera GX 136** com
perfil descartável (`--user-data-dir` em `%TEMP%`), a pasta da extensão carregada
com `--load-extension` (funciona no Opera, sem loja e sem assinatura) e
`--remote-debugging-port=9333` para eu dirigir o painel por CDP. A página de teste
é `ferramentas/pagina-de-teste.html`, feita de propósito com cabeçalho, lateral,
rodapé, tabela, lista, links, formulário, um bloco `display:none` e um bloco
`aria-hidden`, para o extrator ter o que errar.

O painel foi aberto pelo próprio caminho da extensão (`chrome.windows.create` na
janela destacada, que é o fallback do `abrirPainel`), e o id da extensão saiu
`gmkpiilfefhkfjhihdnmolmjjiailhbj`, derivado do caminho.

O que ficou provado, com o número medido:

| prova | resultado |
|---|---|
| conexão e pareamento | painel em "conectado, sem conversa"; a ponte contou **1 assinante** |
| adoção da aba | "Página de teste do dsh-navegador", sozinho, sem clicar em nada |
| `navegador_ler` texto | leu títulos, parágrafo, tabela (`\| alfa \| 11 \|`), lista, os dois links (com a URL do externo), os campos do formulário e os botões; **excluiu** cabeçalho, lateral (aside), rodapé, o bloco `display:none` e o `aria-hidden` |
| `navegador_ler` elementos | 7 elementos numerados `[data-dsh-nav="n"]`, com href, name e type; o botão escondido ficou de fora |
| `navegador_agir` clicar | cartão apareceu com "o agente quer agir na aba", "clicar no elemento #enviar", título e URL da aba; aprovado, `#cliques` foi de 0 para 1 |
| `navegador_agir` no seletor numerado | `[data-dsh-nav="5"]` clicou no mesmo botão e `#cliques` foi de 1 para 2 |
| `navegador_agir` digitar | "Victor Ramses" chegou no campo **e o listener `input` da página rodou** (`#eco` mudou), que é a prova de que o mundo MAIN e o rastreador do React são respeitados |
| recusa | "o usuario recusou esta acao no painel" |
| seletor que não existe | "nao achei nenhum elemento para o seletor \"#nao-existe\"" |
| `print` | `captureVisibleTab` devolveu um dataUrl de 51.030 caracteres |
| contexto da aba na sessão | prompt enviado pelo painel criou sessão, e o primeiro `user/message` dela começa com `<contexto-da-aba>` mais o texto da página; o modelo respondeu certo o título da página e um item da tabela |

**Seis defeitos que só apareceram aqui**, e é por isso que rodar no navegador vale
mais que reler o código:

1. **O painel numa janela destacada adotava a si mesmo como aba alvo.** Ele é a
   aba ativa da própria janela, então `lastFocusedWindow` devolvia o painel. O
   `abaAtual` do service worker agora ignora páginas do próprio add-on e cai para
   a aba ativa de uma janela normal.
2. **No mundo MAIN, quando a função injetada rejeita, o Chromium não rejeita o
   `executeScript`**: devolve `[{ result: undefined }]`. O erro virava "o painel
   devolveu uma resposta inválida" e a mensagem real se perdia no console da
   página. Agora `lerNaPagina` e `agirNaPagina` devolvem `{ ok: false, erro }`
   como **dado**, e a mensagem chega ao agente.
3. **O extrator escolhia `document.body`**, que contém `main`, então sempre
   ganhava e trazia cabeçalho, lateral e rodapé junto. Agora vence o container
   mais específico que tenha pelo menos 25% do texto do corpo.
4. **`innerText` de nó não renderizado devolve `textContent`**, então conteúdo em
   `display:none` vazava para a leitura. Agora `checkVisibility()` barra o nó.
5. **Tag inline quebrava a frase em várias linhas** (`<strong>` no meio do
   parágrafo virava uma linha solta). Agora texto continua a linha anterior e
   container de bloco fecha a linha.
6. **O transcrito mostrava como mensagem do usuário o que o DSH injeta**
   (`runtime-context`, `agent-instructions`, `skill-catalog`) e duplicava o
   prompt, porque o eco local e a mensagem durável com o bloco de contexto não
   eram iguais. Os dois foram corrigidos em `transcrito.js`, com 8 conferências
   sintéticas em `testar-transcrito.mjs --sintetico`.

Limites honestos deste teste:

- quem "clicou" em aprovar e recusar fui eu, por CDP, no cartão real. O cartão, o
  texto e o fluxo são os de verdade; a mão no mouse não;
- o **`sidebar_action` do Opera e o `side_panel` do Chrome não foram
  exercitados pela interface.** O manifesto carrega nos dois (o Opera só avisa que
  não conhece as chaves `side_panel` e `sidePanel`), e quem abriu o painel no
  teste foi a janela destacada;
- o **cartão de pergunta** (`ask_user_question`) segue provado só no transcrito,
  não numa sessão viva pedindo a pergunta;
- a página de teste é sintética: sites reais (YouTube, Gmail) têm DOM muito
  maior, laço infinito de `<div>` e shadow DOM, que o extrator não atravessa.

Lacunas de teste que continuam:

- site real com shadow DOM e iframe: o extrator não entra em nenhum dos dois;
- a pergunta do agente respondida pelo painel (o desenho está na seção 5, e o
  motivo de não ter entrado na v1 também).

### 3.2 Páginas reais (17/10/2026)

A página sintética prova o controle; ela não prova o mundo. Estas três foram lidas
pelo mesmo caminho (extensão carregada, painel aberto, `navegador_ler`):

| página | o que ela tem de difícil | resultado |
|---|---|---|
| Wikipédia (verbete DeepSeek) | prosa densa, infobox em tabela, um link a cada cinco palavras, citações | virou prosa legível: infobox como tabela, títulos como `#`/`##`, citações como `[1]`, e o texto corre inteiro sem quebrar |
| Hacker News | a lista inteira dentro de uma `<td>` de uma tabela externa, com células vazias de espaçamento | cada notícia em uma linha, com pontos e contagem de comentários |
| `ferramentas/pagina-de-teste.html` | HTML controlado, `display:none`, `aria-hidden`, acentos | igual ao esperado, e a linha de acentos que a outra sessão acrescentou passou inteira |

Quatro defeitos que só página real mostra:

1. **Link quebrava a frase.** Cada `<a>` saía como bloco, então "o fundo de
   investimento quantitativo" / "[link] High-Flyer" / "seu principal financiador"
   virava três linhas. Agora o link entra inline e sem marcador, e o alvo clicável
   (com href) continua em `o_que: 'elementos'`, que é onde ele importa.
2. **Pontuação solta.** "Hangzhou ," e "( chinês:" vinham de tratar vírgula e
   parêntese como palavra. A junção não põe espaço antes de pontuação nem depois
   de parêntese, colchete ou aspas de abertura.
3. **`<tr>` com tabela dentro.** O layout do Hacker News embrulha a lista numa
   célula de uma tabela externa, e o `innerText` daquela linha devolvia a página
   inteira numa linha só. Agora linha que contém tabela é container (desce), e
   célula vazia é descartada.
4. **A aba alvo não acompanhava navegação.** Naveguei da Wikipédia para outra
   página e o painel continuou anunciando a anterior, mandando a URL velha no
   contexto. Agora `atualizarAbaAtiva` reanuncia quando o id é o mesmo e a URL
   mudou.

O extrator segue sem entrar em shadow DOM nem em iframe. Isso agora está medido em
página real, não é suposição: as duas coisas ficam fora do escopo da v1.

### 3.3 Título da conversa (17/10/2026)

Medido na tela de conversas do painel: as conversas criadas pelo add-on nasciam com
título `<contexto-da-aba> URL: https://...`, porque o painel mandava o bloco de
contexto **antes** da pergunta e o DSH batiza a conversa pelo começo da primeira
mensagem. Agora a pergunta vai primeiro e o contexto depois, na mesma mensagem.

Verificado de ponta a ponta, mandando "Quantos cliques o botao registrou ate
agora?" pela extensão: o título virou "Contagem de cliques do botão", o primeiro
bloco do `user/message` é a pergunta (com o contexto logo depois) e a resposta foi
"0 cliques (li agora o campo cliques no botão na página aberta)", que é a prova de
que o contexto continuou chegando inteiro. A sessão do teste foi apagada em
seguida (`session/delete` devolveu `{deleted:true}`).

Efeito colateral bom: com a pergunta na frente, o título também fica bom quando a
requisição de título do DSH não roda, que era o caso das conversas criadas com o
painel fechando logo depois.

### 3.4 Transcrito e lista de conversas (17/10/2026)

Dois defeitos de tela que o Ramses apontou com print, e as duas correções:

1. **O bloco de contexto ia cru para o transcrito.** A mensagem do usuário era
   renderizada com o `<contexto-da-aba>` inteiro, ou seja, a página toda (milhares
   de caracteres) empurrando a pergunta para fora da tela. Agora a mensagem mostra
   só a pergunta, e o contexto vira um detalhe recolhido com o rótulo
   `contexto da aba · Hacker News · 4390 caracteres de texto`. Quem quiser ler o
   que foi enviado abre o detalhe.
2. **A lista de conversas não tinha estilo.** O `<dialog id="sessoes">` caía no
   padrão do navegador e cada conversa era um `<button class="primario">`, que é a
   classe dos botões de ação, ou seja, azul cheio. O resultado era uma caixa preta
   com um item azul berrante e a barra de rolagem clara. Agora o diálogo usa o
   fundo do painel, cada conversa é uma linha de lista (título em cima, meta
   embaixo), a conversa aberta se marca por **borda de acento** em vez de
   preenchimento, e a rolagem é discreta.

De brinde, o mesmo print mostrou títulos antigos como `URL: https://news.ycom`, que
são conversas criadas antes do conserto da ordem (seção 3.3). A exibição passou a
limpar isso em `tituloLegivel`: bloco de contexto e prefixo `URL:` saem, e o que
sobra vazio aparece como "Conversa sem título" no cabeçalho e "(sem título)" na
lista. O título no DSH continua sendo o original, porque quem o grava é ele.

### 3.5 Grupo "Add-on Opera" na barra lateral do DSH (17/10/2026)

> **Corrigido em 3.15 (22/10/2026).** A causa descrita aqui está errada: o DSH não
> agrupa por `cwd`, e sim pelo Workspace que contabiliza a sessão. O que continua
> valendo é o sintoma (as conversas caíam em "Ungrouped") e a correção de que
> `session/create` com `cwd` inexistente cria a pasta em vez de recusar.

O Ramses mostrou a barra lateral do DSH: as conversas criadas pelo navegador caíam
em **"Ungrouped"**. Medido: o agrupamento é o `cwd` da sessão. As 89 conversas em
`C:\Users\victo\Documents\DSH` formam o grupo "DSH"; as do add-on nasciam com
`cwd = ...\dsh-desktop\launch-root`, que é o padrão do DSH quando não se manda
`cwd`, e por isso ficavam soltas.

O conserto tem duas metades:

1. **Host** (`plugin/index.js`): calcula `<workspace>\Add-on Opera` (ao lado do
   pacote do add-on, não dentro dele, senão as conversas entram no repositório) e
   publica o caminho no `/ola`, em `addon.cwd`. Não cria a pasta: quem cria é o
   próprio DSH (ver logo abaixo).
2. **Painel**: `criarSessao` manda `cwd` nessa pasta. A ordem é: preferência do
   usuário (campo dos ajustes), depois `addon.cwd` do `/ola`, e por último um palpite
   barato para o caso de a ponte viva ainda ser a versão anterior (a pasta de
   trabalho mais usada no histórico mais `Add-on Opera`).

**Correção de uma afirmação minha.** Eu tinha escrito aqui que o `session/create`
recusa um `cwd` inexistente, e que o painel cairia para "sem `cwd`". Medido agora,
com `cwd = C:\nao-existe-dsh-teste`: ele **não recusa**, ele **cria a pasta** e
grava o caminho (conferido: `cwd` gravado igual ao pedido e o diretório passou a
existir no disco). Então o `mkdir` que eu tinha posto no host era redundante e saiu,
e o `catch` do painel fica só como defensividade para uma versão futura que valide.
A pasta do teste foi apagada do disco.

Verificado no navegador: "nova conversa" pelo painel criou
`session-948722d6` com `cwd = C:\Users\victo\Documents\DSH\Add-on Opera`, e a pasta
aparece no placeholder dos ajustes. As duas sessões vazias do teste foram apagadas.

De quebra, o status do cabeçalho dizia "Conectado, sem conversa" com uma conversa
aberta; agora `abrirSessao` escreve "Conversa aberta".

### 3.6 `o_que: 'selecao'` devolvia vazio (17/10/2026)

Achado testando o caminho que ainda não tinha sido exercitado. A página devolvia a
seleção certa, mas o modelo recebia só `Leitura da aba: selecao.` e `selecao do
usuario`, sem o texto. Duas causas, as duas no plugin:

1. o `execute` de `navegador_ler` não copiava `resultado.selecao` para o valor de
   saída (montava `o_que`, `resumo`, `aba`, `texto`, `itens`, `truncado`);
2. o schema `SAIDA_LEITURA` é `additionalProperties: false` e **não declarava**
   `selecao`, então mesmo que o `execute` copiasse, o campo seria descartado antes
   do `render`.

Corrigido nos dois lugares: `selecao: { type: 'string' }` no schema e o spread
condicional no `execute`. O `render` já tinha a linha certa e nunca disparava.

Conferido que a seleção existe no mundo isolado (não é limitação do
`executeScript`): injetando a mesma função nos dois mundos, isolado e MAIN devolvem
o mesmo texto. **A verificação de ponta a ponta deste conserto depende do restart**,
porque a metade host é importada uma vez por processo.

### 3.7 Abortar o fluxo derrubava o Node (17/10/2026)

Rodando `testar-transcrito.mjs --meu` para conferir a regressão do transcrito, o
processo morria com `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
src\win\async.c`, sem imprimir o relatório. Causa: o `signal` ia direto para o
`fetch`, e abortar um fetch que está com um `read()` pendente estoura essa
assertion no Node 24 no Windows. No navegador abortar é normal, então o defeito era
invisível no painel e só aparecia nos scripts.

O conserto é no `api.js`, e vale para os dois lados: o `signal` **não** vai mais para
o `fetch`; o laço de leitura espera por `comAborto(leitor.read(), signal)`, então o
aborto desiste na hora e quem fecha a conexão é o `cancel()` do leitor, no `finally`,
pelo caminho normal. `lerNdjson` passou a receber o `signal` como terceiro
argumento.

Aproveitando o mesmo teste: ele escolhia a sessão mais recente do `session/list`, que
às vezes é de **subagente**, e o `session/follow` recusa essas com "subagent Sessions
require their durable parent address". Agora filtra `origin !== 'subagent'` e
`parentSessionId` nulo antes de escolher.

Depois disso, sem mudar nada no produto: `--meu` 6 ok, `--sintetico` 8 ok,
`diagnostico` 14 ok, `ponta-a-ponta` 7 ok.

### 3.8 O cartão de pergunta, com pergunta de verdade (17/10/2026)

Era a última tela que só existia no código. Rodei o caminho real: conversa nova pelo
painel, prompt pedindo para o agente chamar `ask_user_question`, e o cartão apareceu
com a pergunta que o modelo escreveu:

```
O AGENTE ESTÁ ESPERANDO UMA RESPOSTA
COR
De que cor você gosta?
- Azul
- Verde
Responda na janela do DSH Desktop. A pergunta é entregue ao aplicativo do DSH, e o
painel do navegador ainda não é um lugar de resposta para ela.
```

Print: `_tmp\painel-pergunta.png`. O turno fica parado esperando resposta (é o
comportamento do `ask_user_question` em modo `legacy`), então cancelei com
`session/cancel` (`{ sessionId }`, e não `{ address }`: o envelope é `request` com o
`sessionId` cru) e apaguei a sessão. O título que o DSH deu foi "Perguntar cor
preferida via ferramenta", o que confirma de novo a correção da ordem pergunta
antes do contexto.

**E o print mostrou um defeito novo:** a mensagem do usuário aparecia **duas vezes**.
O eco local não era casado com a mensagem durável porque, entre os dois, entram o
aviso "turno N começou" e o item do prompt de sistema, e a deduplicação olhava só o
último item da lista (`ultimoDe`). Corrigido com `ecoLocalPendente`, que varre para
trás até 12 itens e para no primeiro item de usuário encontrado (para nunca
reaproveitar um eco antigo).

O teste sintético ganhou o caso intercalado, e conferi que ele **reprova** a versão
antiga: com `ultimoDe` de volta, as duas conferências novas falham
(`2 item(s)`); com a correção, `--sintetico` vai de 8 para **10 ok**. No painel de
verdade, um prompt novo produziu **um** item de usuário, com o contexto recolhido.

### 3.9 No Opera o painel é janela, e isso é limite do navegador (17/10/2026)

O Ramses pediu algo "como os add-ons do Gemini e do Claude", que moram na barra lateral.
Fui medir por que aqui o painel abre como janela destacada, em vez de supor que era
escolha minha:

| medido no Opera GX 136 (Chromium 152) | resultado |
|---|---|
| `navigator.userAgent` | `Chrome/152.0.0.0 … OPR/136.0.0.0` |
| `typeof chrome.sidePanel` | `undefined` |
| `typeof chrome.sidebarAction` | `undefined` |

Ou seja: o Opera roda num Chromium que **tem** `sidePanel`, mas o Opera **não expõe** a
API (e o `sidebarAction` é API do Firefox, que ele também não tem). A chave
`sidebar_action` do manifesto é ignorada com aviso, e o comentário antigo no `sw.js`
dizia que "no Opera quem abre é o `sidebar_action`", o que era falso. Corrigido nos dois
lugares (código e README): no Opera a janela destacada é o único caminho, e a extensão
continua tentando `sidePanel.open` primeiro para valer no Chrome e no Edge.

Para a janela não ser pior do que precisa, ela agora **lembra posição e tamanho**: o
`sw.js` guarda os bounds em `chrome.storage.local` (chave `janelaPainel`) quando a janela
do painel se move, e os usa na próxima abertura, com validação de tamanho mínimo para
nunca abrir inutilizável. O listener identifica a janela pela URL da aba, e não pelo id
em memória, porque o service worker hiberna e volta com `janelaDestacada` nulo.

Verificado no navegador: movi a janela para 520x700 em (120,80) e o storage ficou com
`{width:520, height:700, left:120, top:80}`; a janela seguinte abriu com esses valores.
O gatilho do clique no ícone eu não dirijo por CDP, então a conferência foi feita nas
duas pontas (salvar e criar com o que está salvo), não no meio.

### 3.10 `ferramentas/aceitar.mjs`: a conferência num comando (17/10/2026)

As verificações existiam espalhadas em quatro scripts, cada um com o seu placar, e
conferir a entrega era lembrar a ordem e ler quatro saídas. Agora existe
`node ferramentas/aceitar.mjs`, que roda em sequência, herdando a saída de cada um:

1. conformidade estática (`conferir-extensao.mjs`);
2. transcrito sintético (`testar-transcrito.mjs --sintetico`);
3. diagnóstico da ponte (`testar-ponte.mjs diagnostico`);
4. segurança (`testar-ponte.mjs seguranca`);
5. ponta a ponta (`testar-ponte.mjs ponta-a-ponta`);
6. transcrito com quadros reais (`testar-transcrito.mjs --meu`).

E fecha com veredito: quantas etapas passaram, quais falharam, o que foi pulado e
**pendências** (hoje, a diferença entre a versão da ponte viva e a do disco). Sai com
código 1 se alguma etapa falhar ou se houver pendência. `--rapido` pula as duas etapas
que gastam token de verdade (ponta a ponta e transcrito real).

Duas decisões de desenho: a saída dos scripts é herdada (`stdio: 'inherit'`) em vez de
capturada, para o operador ver o detalhe de cada conferência sem parsing; e a checagem
de versão entrou como **pendência** e não como etapa, porque "(o DSH ainda não
reiniciou)" não é falha do add-on, mas não pode passar como se estivesse tudo certo.

Estado na redação: `5 de 6 etapa(s) passaram`, falha só em `seguranca` (esperada pelo
código novo) e a pendência da versão. `--rapido`: `3 de 4`.

Depois do restart de 17/10/2026 (11:40) ele respondeu **`6 de 6 etapa(s) passaram`**,
sem pendência, `TUDO OK`, código 0. A versão foi para 0.1.1, o `/ola` passou a informar
`addon.cwd` e `seguranca` foi de 11 ok / 1 falha para **12 ok**.

### 3.11 A aba do resultado derrubava as duas ferramentas (17/10/2026)

Só apareceu depois do restart, quando fui exercitar `o_que: 'selecao'` de ponta a ponta
no Edge. A chamada voltou assim:

```
Error: tool "navegador_ler" returned invalid output: "value.aba.janelaId" is not a
declared property (additionalProperties: false); "value.aba.atualizadoEm" is not a
declared property (additionalProperties: false)
```

A causa: `definirAba` (em `ponte.js`) guarda a aba com **cinco** campos
(`url`, `titulo`, `id`, `janelaId`, `atualizadoEm`), e `ABA_SCHEMA` declara **três**
(`url`, `titulo`, `id`) com `additionalProperties: false`. O `abaDoResultado` devolvia o
objeto da ponte inteiro, e o DSH recusa a saída inteira da ferramenta por causa disso.
Vale para `navegador_agir` também, que usa o mesmo caminho.

Conserto: `projetarAba` reduz a aba ao formato declarado (`url`, `titulo?`, `id?`) e as
duas ferramentas passam por ela. O schema continua fechado, que é o contrato.

Como o código de host só muda no boot, a projeção ganhou conferência própria que **não
depende do DSH no ar**: `ferramentas/conferir-projecao-aba.mjs` extrai `projetarAba` e
`ABA_SCHEMA` do próprio arquivo (que importa `@deepseek-ai/dsh-tools` e não dá para
importar fora do host), alimenta com o objeto que `definirAba` monta e confere que a
saída tem só as chaves declaradas. Dá 13 ok, e um deles afirma que a **entrada** tinha
duas chaves fora do schema, para o teste não virar decoração. Ele entrou como etapa do
`aceitar.mjs`, que passou a ter 5 etapas no `--rapido` e 7 no completo.

**Conserto verificado no caminho real das ferramentas** (17/10/2026, depois do segundo
restart, com a ponte 0.1.1 carregando a projeção). Usei o `testar-ponte.mjs painel-falso`,
que anuncia uma aba e responde os pedidos, então `abaDoResultado` recebe o objeto de cinco
campos da ponte de verdade:

```
navegador_ler  o_que: 'selecao'  -> "Leitura da aba: selecao." / "Aba: Formulario de teste
                                     (https://exemplo.test/formulario)" /
                                     "Selecao do usuario: trecho selecionado de teste"
navegador_ler  o_que: 'texto'    -> "Conteudo: Pagina falsa com um botao..." + a linha da aba
navegador_agir clicar #enviar    -> "Resultado: acao \"clicar\" executada..." / a linha da aba /
                                     "O usuario aprovou esta acao no painel."
```

As três passaram sem o erro de saída inválida, e a linha `Aba:` aparecendo é a prova de que
o objeto projetado chegou ao `render`. Isso fecha o `o_que: 'selecao'`, que era a última
coisa do add-on nunca vista funcionando de ponta a ponta: a metade cliente já estava nos
três lugares certos (`injecao.js` devolve `selecao`, o painel lê em três pontos, o service
worker repassa `oQue`) e faltava só a metade host, que era o defeito desta seção.

**O que eu não sei explicar, e não vou inventar.** O descompasso está no código desde o
primeiro commit (`d0260b9`): o `git log -S` mostra que tanto o schema fechado quanto o
`janelaId` na ponte nasceram ali, e nem `abaDoResultado` nem `definirAba` mudaram desde
então. Mesmo assim as leituras de ontem funcionaram, com texto voltando de Wikipédia e
Hacker News. Não consegui reler aquelas saídas para comparar: o registro da sessão é
`session.v4.jsonl.zstd`, comprimido, e buscar texto nele não dá. O que sei medir é o
estado de hoje: com a ponte 0.1.1 no ar, **qualquer** `navegador_ler` falha, inclusive
`o_que: 'texto'`.

Sobre o navegador do teste: o Opera GX de teste morreu duas vezes enquanto o Opera do
Ramses estava aberto (instância única), então rodei esta verificação no **Edge**
(Chromium 155), com o mesmo pacote de extensão. O `--load-extension` funciona igual, e
é por isso que o print da seleção saiu de lá.

**A instabilidade do navegador de teste, medida em 17/10/2026 (para não repetir o
tempo perdido).** Na mesma sessão, instâncias novas de Edge com `--user-data-dir` em
`%TEMP%` morreram **quatro vezes** logo depois de subir (porta CDP deixa de responder,
zero processos, `DevTools listening` presente no stderr e nenhum erro além do aviso de
`fallback_task_provider`), e as do Opera GX morreram duas vezes. Não achei a causa:
havia RAM de sobra (16 GB livres), nenhum perfil de teste sobrando e nada no log. O
padrão que funcionou foi **tentar de novo com perfil e porta novos** (a primeira
tentativa quase sempre falha). Fica registrado como instabilidade do ambiente de teste,
não do add-on, e é a razão de o teste de ponta a ponta no navegador ser feito na
máquina do Ramses e não aqui.

Duas armadilhas da mesma família: `Start-Job` **não sobrevive** entre chamadas de shell
(cada `pwsh` é um processo novo, então um servidor estático iniciado assim morre junto);
para servir a página de teste por HTTP é preciso um job de verdade, em background. E o
`/json/new` do CDP só aceita `PUT`.

### 3.12 A pergunta do agente respondida pelo painel (17/10/2026)

O que este teste provou, e é o primeiro "sim" do add-on nesta frente: com o preset em
`mode: timed`, uma pergunta do agente entra em `userQuestions.active` com `callId` e
`state: 'open'`, o caminho de resposta do painel (`userQuestions/answer`) **fecha a
pergunta**, e o turno continua com a resposta dentro (`"Azul."`). O relato completo, com
o payload da projeção e a decisão de `timeout: -1`, está em 4.3.

O defeito que ele revelou no painel foi de uma linha e mudo: o filtro pedia
`state === 'continued'` e a pergunta vinha `open`, então o cartão apareceria sem botão.
Corrigido, e agora existe `ferramentas/conferir-pergunta-projecao.mjs`, que alimenta
`aplicarProjecoes` com o payload real e cobra seis coisas, entre elas "o filtro do painel
(state open + callId) encontra a pergunta". Ele entrou como etapa do `aceitar.mjs`, que
passou a ter **6 etapas no `--rapido` e 8 no completo**.

Para exercitar de novo sem navegador: `node _tmp\asar\pergunta-timed.mjs` cria a sessão e
pede a pergunta; `node _tmp\asar\responder.mjs <sessionId> Azul` responde e mostra o
`turnOutline` com a resposta do modelo.

### 3.13 DSH Desktop 0.12.1: o gateway passou a exigir um Peer (21/10/2026)

O sintoma que o Ramses mandou no print: o painel abria, a lista vinha vazia
("Conversa sem título") e a linha de situação dizia
`fluxo caiu (Cannot read properties of undefined (reading 'signal')); reconectando`.

**Causa medida, não deduzida.** O DSH Desktop foi atualizado para **0.12.1** em
20/10/2026 22:01 (`resources\app.asar`, 369.424.689 bytes) e o gateway mudou o
contrato de chamada. No `node_modules\@deepseek-ai\dsh-api-gateway\lib\index.js`
extraído do `app.asar`:

- `stream(request)` → `openStream(request, control)` → `prepareInvocation(request, control)`,
  e a primeira linha de `prepareInvocation` é `assertPeerLive(request.peer, endpoint)`;
- `assertPeerLive(peer, endpoint)` começa por `peer.signal.aborted`, então `peer`
  indefinido dá exatamente `Cannot read properties of undefined (reading 'signal')`;
- `invokeRpc(endpoint, payload, signal, peer)` também monta o pedido com
  `remoteRequest(...)`, que chama `assertPeerLive` do mesmo jeito.

A ponte chamava `invokeRpc(endpoint, { args }, signal)` (três argumentos) e
`stream({ namespace, method, args, signal })` (sem `peer`), que era o contrato de
0.2.0-rc.2, quando o add-on foi escrito. Reproduzido na hora, pelo caminho de fora:

```text
POST http://127.0.0.1:43129/dsh-navegador/rpc/session/list  {"args":{}}
{"ok":false,"error":{"code":"gateway/internal","message":"Cannot read properties of undefined (reading 'signal')","details":{}}}
```

**Conserto.** Quem cria Peer em processo é o serviço `connection`
(`dsh-client-connection`: `createPeer(options)` devolve um `Peer` com
`principal`, `interactions` e um `signal` que só aborta quando o dono é
descartado; o `browserPeer` é o mesmo Peer das requisições `/api` da interface).
A ponte passou a:

- declarar `connection` no `inject` (`plugin\index.js`), para o serviço existir
  antes do `apply`;
- criar um Peer **uma vez**, com `principal: { kind: 'owner' }`, em
  `peerDaPonte()` (`plugin\ponte.js`), com queda para `browserPeer` e erro claro
  quando o serviço não está montado;
- passar esse Peer no 4º argumento de `invokeRpc` e no campo `peer` do pedido de
  `stream`.

O `owner` importa: `prepareInvocation` só pula a decisão de `remoteAccess`
quando `request.peer.principal.kind === 'owner'`, que é o caso das requisições da
própria interface.

**Conferência que entrou no portão.** `ferramentas\conferir-peer.mjs` reproduz a
leitura do gateway real (`peer.signal`) e cobra quatro coisas: o erro antigo era
esse TypeError, o RPC passa com o Peer, o fluxo devolve o iterador e o Peer é
criado **uma vez só**. Virou etapa do `aceitar.mjs` (etapa 2 de 7 no `--rapido`).

**Custo e efeito colateral:** a metade host é importada **uma vez, no boot**.
Até fechar e reabrir o DSH, a ponte viva continua respondendo 0.1.1 e o
`aceitar.mjs` acusa a pendência "a ponte viva responde 0.1.1 e o disco tem
0.2.0". Depois do restart, o esperado é `7 de 7` no `--rapido` e a lista de
conversas aparecendo no painel.

O painel também ganhou a dica no rodapé quando a mensagem casa com
`reading 'signal'` ("O host esta na versao antiga: feche e reabra o DSH"), porque
sem ela o erro técnico não diz o que fazer.

### 3.14 Depois do restart: conferido de ponta a ponta (21/10/2026, 23:51)

Restart feito pelo Ramses às 23:51. Medições, nesta ordem:

- `/ola` passou a responder **0.2.0** (pid 6000), e o `ponte.json` foi reescrito
  às 23:51:16, ou seja a metade host nova entrou de fato;
- `aceitar.mjs --rapido`: **7 de 7, TUDO OK** (era 6 de 7 antes, falhando o
  diagnóstico com o TypeError do Peer);
- diagnóstico da ponte: 14 ok, 0 falha, com `session/list` devolvendo **155
  sessões** e `session/projections` trazendo título de verdade;
- `session/create` (com `cwd`), `session/projections` e `session/delete` pelo
  `api.js` do painel: sessão criada, projeção lida, `{"deleted":true}`. É o
  caminho exato do `criarSessao()`;
- `testar-transcrito.mjs --meu`: **6 ok, 0 falha**, 40 itens de assistente e 59
  ferramentas com resultado lidos do fluxo real. Isso prova o que o print
  mostrava quebrado: `session/follow` volta a entregar quadro pelo Peer novo.

Sonda crua com `{"args":{}}` em `session/list` agora devolve
`gateway/arguments-invalid ... missing "_request"`, e isso é **esperado**: o
envelope (`{ _request }`, `{ request }` ou args soltos) é montado pelo `api.js`
do painel, e o teste acima usa esse caminho. Quem chamar a ponte na mão precisa
mandar o envelope certo.

**Deriva nova do 0.12, ainda não corrigida:** o diagnóstico mostra três
`aviso` que antes não apareciam, em endpoints que o painel **não** usa:
`skills/list` e `messageFeedback/list` recusam o envelope `{ request }`
("wire field request failed boundary validation") e `goals/get` com
`{ agentId }` estoura `Cannot read properties of undefined (reading 'slice')`.
Provável mudança de descritor no 0.12 (envelope e formato do `agentId`). Não
afeta conversa, aba nem ferramentas; entra na lista 4.5.

### 3.15 O grupo é um Workspace, não um `cwd` (22/10/2026)

Pedido do Ramses: "conversas cuja origem é o add-on para Opera devem estar
agrupadas na pasta DSH Opera". A seção 3.5 estava **errada** na causa: ela dizia
que o DSH agrupa a conversa pelo `cwd`. Ele agrupa pelo **Workspace que
contabiliza a sessão**; o `cwd` só decide onde a sessão mora no disco.

O que foi lido no código do DSH 0.12.1 (`resources\app.asar`) e medido por API:

- `owningGroupKey(workspaces, sessionId)` devolve o id do Workspace cujo
  `sessionIds` **inclui** a sessão; sem nenhum, a linha cai em "Ungrouped".
- O título do grupo na barra lateral é o `title` do Workspace (`buildGroup(...,
  workspace.path, ..., workspace.title, ...)` e `label: workspace.title`). O
  `workspace/rename` muda o rótulo de verdade; renomear a pasta, não.
- `WorkspaceEntity.attachSession` só aceita sessão cujo `cwd` gravado no
  cabeçalho, depois de `realpath`, seja **igual** ao path do Workspace.
- `SessionCommandController.create`: com `workspaceId` o `cwd` vira o path do
  Workspace e a sessão é contabilizada (`attachSession`); com **só** `cwd` nada
  é contabilizado.
- Não existe RPC para contabilizar sessão já nascida: `workspace/*` tem create,
  delete, rename, insertBefore, insertSessionBefore (que exige a sessão já
  contabilizada), archive/unarchive e pin/unpin. Nada de attach.

Medido nesta máquina, com pasta de teste descartável: `workspace/create` +
`session/create {cwd}` deixou a sessão **fora** do `sessionIds` do Workspace
(fica em Ungrouped); `session/create {workspaceId}` deixou **dentro**. As duas
sessões de teste e o Workspace de teste foram apagados, e a pasta também.

**O defeito real, com duas partes.** (1) `pastaDasConversas()` calculava
`dirname³(plugin/index.js)`, que no layout instalado pelo perfil dá
`...\dsh-desktop\harness\profiles\web\node_modules\Add-on Opera`: o `/ola`
publicava esse caminho. (2) Mesmo com a pasta certa, `cwd` não agrupa. A
preferência salva no painel (`C:\Users\victo\Documents\DSH\Add-on Opera`, de
17/10) é que explicava as três conversas do Opera estarem naquele diretório, e
todas as três em "Ungrouped".

**Correção, na metade host:**

1. a pasta das conversas passou a ser `DSH Opera` (o nome final vira o `title`
   inicial do Workspace), resolvida por `config.pasta`, senão
   `Documents\DSH\DSH Opera` no layout instalado, senão ao lado do pacote;
2. `garantirWorkspace()` roda no boot (e de novo sob demanda, se o gateway ainda
   não aceitava RPC na ativação): `mkdir` da pasta + `workspace/create`, que é
   idempotente por `realpath`;
3. `emWorkspaceDoAddon()` troca o `request.cwd` de todo `session/create` que vem
   do painel pelo `workspaceId` do Workspace (o Host recusa os dois juntos). Os
   outros campos (`sessionId`, `agentPreset`) passam intactos;
4. `/ola` publica `addon.workspaceId` além de `addon.cwd`, e o retrato em
   `integrations\dsh-navegador\ponte.json` ganhou `pastaConversas` e
   `workspaceConversas`.

Workspace criado por API nesta rodada: `8855b953-100e-4717-bcf2-c1ece53a2e69`,
título e path "DSH Opera", posto na ordem logo depois de "DSH". Conferido de
ponta a ponta com uma sessão descartável criada no Workspace novo: entrou em
`sessionIds` e saiu quando a sessão foi apagada.

**O que não dá para consertar:** conversa velha não muda de grupo. O `cwd` está
no cabeçalho comprimido da sessão e não há RPC para trocá-lo nem para
contabilizar a sessão num Workspace. As três conversas do Opera de 17/10 a 21/10
(duas arquivadas e a que estava aberta) continuam em "Ungrouped"; as novas, a
partir do próximo boot, nascem no grupo "DSH Opera".

**Deploy:** o módulo do plugin é importado uma vez no boot (2.5), então isso só
vale depois de fechar e reabrir o DSH. E a cópia instalada no perfil é um
**aglomerado de hardlinks** (`node_modules\dsh-navegador\plugin\index.js` tinha o
mesmo FileId da fonte): editar a fonte **quebra** o vínculo, e o perfil continua
com o código velho. Por isso o arquivo novo foi copiado também para
`...\profiles\web\node_modules\dsh-navegador\plugin\`. Quem editar de novo tem de
repetir a cópia, ou rodar `ferramentas\instalar-no-perfil.ps1` / o `Aplicar` do
`sync-memoria.ps1`.

### 3.16 Aprovar sem cartão durante a conversa (22/10/2026)

O Ramses pediu, com o painel na tela: *"queria uma opção pra já deixar aprovado
durante toda a sessão"*. O caso concreto era navegar pelo Mercado Livre com o
agente trocando de página a cada passo e um cartão por passo.

**Desenho.** O modo tem dois pontos de entrada e três travas de visibilidade,
porque "aprovado por padrão" sem aviso é o jeito mais fácil de o agente clicar em
algo que ninguém viu:

1. no cartão, a caixa **"não perguntar de novo nesta conversa (autoaprovar as
   próximas ações)"**: aprova a ação daquele cartão e liga o modo;
2. na barra de atalhos, o botão **Autoaprovar**, que liga e desliga sem esperar
   pedido (fica em tom de aviso quando ativo);
3. com o modo ligado, uma **faixa âmbar fixa** acima dos cartões diz o que está
   acontecendo e traz o **Desligar**;
4. cada ação executada assim entra no transcrito como *"ação executada
   automaticamente (autoaprovação ligada): ..."*, então o registro não some.

**Escopo.** Vale para a conversa aberta no painel. `abrirSessao` chama
`carregarAutoAprovar`, que compara a conversa guardada com a atual: trocar de
conversa desliga. O estado mora em `chrome.storage.session` (com queda para
`local` num Chromium antigo sem a API), então morre quando o navegador fecha.
`autoValePara` é a regra pura, testável fora do navegador.

**O desvio fica antes do cartão.** Em `tratarMensagemDePedido`, o pedido `agir`
com o modo ligado vai para `executarPedido(pedido, { automatica: true })` e não
passa por `desenharPedido`. Se a ordem um dia inverter, o usuário volta a ser
perguntado; o `testar-autoaprovacao.mjs` confere justamente essa ordem.

**O agente não pode narrar uma aprovação que não houve.** O resultado da
ferramenta ganhou `autoaprovada: true`, e `textoDaAcao` troca a linha "o usuário
aprovou esta ação" por "o painel está com a autoaprovação ligada nesta conversa".

**O selo viaja no ENVELOPE, não dentro de `valor`.** Foi decisão de
compatibilidade: `resolve(resposta.valor)` é o que a ponte devolve à ferramenta, e
o schema de saída é fechado. Se o painel injetasse o campo dentro do valor, um
host antigo (0.2.0) recusaria a saída inteira com "is not a declared property",
exatamente o defeito da 3.11, e a ação se perderia até reiniciar. Com o selo no
envelope, `comSelo` (novo, em `plugin/ponte.js`) só o aplica quando o host é novo,
e o painel novo funciona com host antigo sem quebrar nada.

**Conferido.** `ferramentas/testar-autoaprovacao.mjs` tem 35 conferências (regra
de escopo, armazenamento com e sem `chrome`, fiação do painel, selo do host) e
entrou no `aceitar.mjs` logo depois da conformidade estática. No navegador, com o
painel recarregado e o modo ligado, na página de um produto do Mercado Livre:
`navegador_agir` com `esperar 1` e com `rolar 400` voltaram na hora, sem cartão
("esperei 1s", "rolei 400px para baixo"). O Ramses conferiu do lado dele e
respondeu "deu certo".

**Duas armadilhas registradas.** Recarregar a extensão **fecha o painel**: a
primeira leitura depois do reload falha com "o painel do add-on do navegador nao
esta aberto nesta janela", e não é defeito. E o `autoaprovada` só aparece no
resultado depois de fechar e reabrir o DSH, porque o schema novo vive na metade
host, importada no boot (2.5).

---

## 4. Pendências, em ordem de importância

### 4.1 Restart, ferramentas e página de verdade: tudo conferido

**Primeiro restart** (17/10/2026, 11:40): a ponte passou a responder **0.1.1**, o `/ola`
passou a informar `addon.cwd`, `seguranca` foi de 11 ok / 1 falha para **12 ok** (o corpo
fora do envelope agora dá 400) e o `aceitar.mjs` deu **6 de 6, TUDO OK**.

**Segundo restart** (17/10/2026, 12:0x, PID 23892): carregou a projeção da aba (3.11). O
`aceitar.mjs` deu **7 de 7, TUDO OK**, e as três ferramentas foram exercitadas no caminho
real com o `painel-falso`: `ler` com `selecao`, `ler` com `texto` e `agir` com aprovação,
as três devolvendo a linha da aba sem erro de schema.

**Extensão carregada no Opera e página de verdade** (17/10/2026, 18:55). O Ramses carregou
`extensao` em `opera://extensions` (modo desenvolvedor, carregar sem compactação) e abriu o
painel numa notícia do Wowhead. O `/ola` passou a mostrar `assinantes 1` e a aba anunciada
com título e URL corretos, e as duas leituras pelo agente voltaram:

- `o_que: 'selecao'` → `Leitura da aba: selecao.` mais a linha da aba, sem erro de saída
  (com nada selecionado na página, o bloco da seleção é omitido de propósito);
- `o_que: 'texto'` → `# All Locations of New Dark Iron Mole Machines in Patch 11.0.5`
  seguido do corpo da notícia e do aviso de corte em 400 caracteres.

O print do painel mostrando `navegador_ler ok` e a resposta renderizada com títulos, listas
e tabela é a evidência de que a combinação "página real + host final + navegador do Ramses"
funciona. Com isso a entrega está conferida de ponta a ponta, e o que resta abaixo são
ideias, não pendências de correção.

### 4.2 Carregar a extensão no Opera (feito, e o passo fica registrado)

A extensão não vem pelo instalador do vault: ela é carregada **à mão**, uma vez por
navegador, porque não há loja nem assinatura. Ficou medido que o perfil do Opera GX não
tinha rastro nenhum dela até 17/10/2026 (`Preferences` sem o id e sem o caminho), então
"não está no Opera" era verdade, e não falha do pacote: o manifesto está válido (v3,
0.1.1) e os 14 arquivos que ele cita existem.

1. `opera://extensions` → Modo desenvolvedor → Carregar sem compactação em
   `<Documents>\DSH\dsh-navegador\extensao`;
2. abrir o painel e conferir: acha a ponte, pareia, mostra "conectado";
3. criar uma conversa, mandar "o que tem nesta página?";
4. conferir o **contexto da aba** chegando (a mensagem do usuário no DSH deve
   mostrar o bloco `<contexto-da-aba>`);
5. pedir uma ação ("clicar no botão X") e conferir o **cartão de aprovação** e a
   execução;
6. conferir as três superfícies: `sidebar_action` no Opera, `side_panel` no
   Chrome/Edge e a janela destacada (`Alt+Shift+D`);
7. conferir as páginas onde a injeção não roda (`opera://`, Web Store) e que a
   mensagem de erro é legível.

### 4.3 Responder pergunta do agente pelo painel (RESOLVIDO em 17/10/2026)

**O que estava errado aqui antes, e por que estava errado.** A versão anterior deste
handoff dizia que `userQuestions/answer` só fechava pergunta em `state: 'continued'`, e
que por isso só valia a pena virar o `tool-ask-user` para `timed` com prazo. Era
**palpite lido no código** (`continued(agent)` filtra `state === 'continued'`), nunca
medido. A medição de hoje desmentiu: pergunta `open` responde igual.

**A medição, com a ponte 0.1.1 e o DSH reiniciado (PID 19980):**

1. preset `standard` com `tool-ask-user` em `mode: timed` e `timeout: -1`;
2. sessão criada, pedido ao agente para usar `ask_user_question` com a pergunta
   "Qual cor?" e as opções "Azul" e "Verde";
3. a projeção passou a trazer, em `userQuestions.active`:

   ```json
   { "callId": "call_00_ET_YwlLMMMtgUhuxv5SD2Cl8831",
     "questions": [{ "id": "cor", "question": "Qual cor?", "header": "Qual cor?",
                     "options": [{ "label": "Azul" }, { "label": "Verde" }] }],
     "state": "open" }
   ```

4. `userQuestions/answer` com `{ agentId, callId, answer: { answers: [{ id: 'cor',
   selected: ['Azul'] }] } }` devolveu `ok`;
5. a pergunta saiu de `userQuestions.active`, e o turno **continuou**:
   `turnOutline: [{ "turn": 1, "prompt": "Use a ferramenta ask_user_question…",
   "response": "Azul." }]`.

**O que mudou no painel.** O filtro era `state === 'continued'`; agora é
`state === 'open'` com `callId` (a medição acima), e o cartão informativo só aparece
quando **não** há pergunta respondível, para não dizer "responda na janela do DSH"
com um botão disponível ao lado. O texto do cartão informativo também mudou: ele
explica que a pergunta chegou sem identificador, no modo `legacy`. Isso virou teste
`ferramentas/conferir-pergunta-projecao.mjs` (etapa do `aceitar.mjs`), porque o defeito
é mudo: a pergunta aparece, mas sem botão.

**Onde virar o modo, e o que foi medido sobre isso.** O preset `standard` é **embutido
no pacote** e não tem arquivo em disco, então o caminho é o preset de usuário:

- presets moram em `%APPDATA%\dsh-desktop\harness\.agent-presets\<id>\`, com `preset.yml`
  (nome, descrição, ordem) e `agent.cordis.yml` (lista de plugins);
- um arquivo com o **mesmo id de um preset embutido é aceito**: depois de reiniciar,
  `agentPresets/read` do `standard` devolveu `mode: timed` e `name: Padrão`;
- **o registro é lido no boot**: arquivo gravado com o app aberto não aparece nem em
  `agentPresets/list` nem em `read` (`Unknown agent preset`), e reiniciar a janela não
  basta, porque o app fica na bandeja. Foi preciso "Sair" pelo menu da bandeja, e a
  prova é o PID da ponte mudar;
- a entrada escrita aqui, em `.agent-presets\standard\agent.cordis.yml`, é:

  ```yaml
  - id: tool-ask-user
    name: '@deepseek-ai/dsh-tool-ask-user'
    config:
      mode: timed
      timeout: -1
  ```

- `timeout: -1` é escolha, não default: com prazo (o padrão é 120 s) a pergunta morre se
  o Ramses demorar, e hoje ele espera o quanto quiser. Com `-1` o comportamento é o de
  antes, com a diferença de que a pergunta passa a ser respondível pelo painel;
- **custo consciente**: o override do `standard` é uma cópia, então uma atualização do
  DSH que mude o preset embutido não chega sozinha. Para desfazer, apagar a pasta
  `.agent-presets\standard` devolve o embutido (o script de apoio é
  `_tmp\asar\preset-timed.mjs remover`, fora do pacote do add-on).

**O plano antigo (gancho no waterfall) ficou descartado**, e vale registrar por quê: ele
exigia entrar no caminho de interação humana do DSH com `prepend: true` e `{global:true}`,
e o cartão da janela do DSH só se remove quando a promessa DELE resolve, então responder
pelo painel deixaria um cartão pendurado lá. A solução por preset resolve o mesmo
problema sem tocar no caminho de interação.

**O que fica de limite:** só o `mode: timed` publica a pergunta. Numa máquina sem esse
preset o painel continua mostrando o cartão informativo, e é o que o teste
`conferir-pergunta-projecao.mjs` protege: ele falha se o filtro voltar a exigir
`continued`.

### 4.4 Publicar e registrar (feito em 21/10/2026)

- instalador de arquivo único em
  `dsh-memory\manutencao\instalar-navegador.ps1` (gerado com
  `tools\gerar-instalador-addon.ps1 -Fonte <repo> -Id dsh-navegador -Pacote
  dsh-navegador -Sufixo Documents\DSH\dsh-navegador`), **regerado** com a fonte
  0.2.0 em 21/10/2026, com o sha de `ponte.js` e de `painel.js` conferido dentro
  do payload;
- linha `navegador` na lista `$ADDONS` do `sync-memoria.ps1`;
- repositório privado `VRamses/dsh-navegador`: **existe e está em dia**. O commit
  `7136def` (21/10/2026) levou o Peer, e o `plugin/ponte.js` publicado foi
  conferido por sha256 contra o disco (`e4be38cd…`, iguais);
- conferência com `tools\checar-plugins.cjs`: TUDO CERTO (`0.2.0`, 33 arquivos,
  0 divergente).

**Dois fatos do clone local que confundem quem chega depois:**

1. a pasta **é** um repositório desde 16/10/2026, com histórico (o último commit
   antes desta rodada era `05ca6ed`, de 17/10 17:25). Não rode `git init` de novo:
   em 21/10/2026 o `rev-parse --is-inside-work-tree` respondeu "not a git
   repository" e um `git init` foi disparado por engano. O `init` não apagou
   nada (o `.git` manteve a data de criação de 16/10), mas depois dele o
   `git status` passou a listar só os 9 arquivos da rodada, o que parece
   repositório recém-criado e não é;
2. o `.git\config` local estava **sem a seção `[remote]`**, embora
   `refs/remotes/origin/main` existisse e apontasse para `05ca6ed`. O remoto foi
   recriado com `git remote add origin https://github.com/VRamses/dsh-navegador.git`
   e o push feito com `-u`. Se o `git push` reclamar de remoto inexistente, é isso.

### 4.5 Envelope no DSH 0.12 (RESOLVIDO em 21/10/2026)

Não era o que parecia, e o erro estava em dois lugares diferentes:

| endpoint | o que voltava | causa real | conserto |
|---|---|---|---|
| `skills/list` | `wire field "request" failed boundary validation` | envelope certo, **miolo** errado: no 0.12 passou a exigir `request: { sessionId }` | sonda do diagnóstico passa `{ sessionId }` |
| `messageFeedback/list` | mesmo erro | idem | idem |
| `goals/get` | `Cannot read properties of undefined (reading 'slice')` | **bug do próprio diagnóstico**: o endpoint respondeu certo com valor vazio (`undefined`) e o `JSON.stringify(valor).slice(...)` quebrou | `resumoDoValor()` no `testar-ponte.mjs` |

A tabela de envelope do `api.js` **continuava certa** para os três (`request` e
`agentId` solto). O que estava errado era a suposição de que `request: {}` bastava
e o formatador do diagnóstico.

O `conferir-envelope.mjs`, criado nesta rodada, achou **mais três** deriva que
ninguém tinha visto: `goals/create`, `goals/edit` e `llm/discoverModels` passaram a
querer `{ request: ... }` no 0.12 e estavam na lista de args soltos. Os três foram
movidos para `COM_REQUEST`; o checker fecha em 50 de 50.

**O que entrou para não depender de memória:**

- `ferramentas/descritores.mjs`: leitor dos descritores do `app.asar` como módulo,
  aceitando o formato antigo (`invocations: [...]`) e o novo (mapa `'ns/metodo': {...}`);
  resolve `wire` ausente caindo no `name` (`session/list` declara `_request` sem
  `wire`), delimita cada descritor pelo próprio par de chaves (cortar pela chave
  seguinte pegava o `mode: 'stream'` do vizinho) e lê a versão do DSH;
- `ferramentas/mapear-endpoints.mjs` virou CLI sobre esse módulo, e **falha** quando
  não reconhece nenhum descritor. Antes ele imprimia "0 endpoints" e seguia com
  código 0, que foi o que escondeu a mudança de formato;
- `ferramentas/conferir-envelope.mjs`: compara a tabela do `api.js` com os
  descritores da versão instalada, endpoint por endpoint, e sai com 1 quando
  diverge. Virou a **etapa 2 de 8** do `aceitar.mjs`.

**Três armadilhas de leitura do `app.asar`, todas medidas aqui:**

1. rodar `mapear-endpoints.mjs` com o node do DSH (Electron) falhava com
   `ENOENT, not found in ...app.asar`: o `fs` do Electron trata o caminho como
   "arquivo dentro do asar". `process.noAsar = true` no topo do módulo resolve;
2. o deslocamento dos dados é `8 + pickle do cabeçalho` (lido em 8..11), e não
   `20 + tamanho do JSON`. Errar isso desalinha 8 bytes;
3. a entrada de `package.json` na raiz vinha com bytes do arquivo anterior na
   frente e `size` cortando o fim do JSON, então `JSON.parse` cru falha; a versão
   sai por regex, que não depende de alinhamento.

---

## 5. Decisões que parecem estranhas e não são

- **A extensão fala direto com a ponte, e o service worker não.** O worker só
  cuida do que exige API de extensão (abrir o painel, injetar na aba, menu de
  contexto). Assim existe **um** dono do token e do estado da conversa.
- **NDJSON por `fetch` com `ReadableStream`, e não SSE nem WebSocket.** O
  `EventSource` não aceita cabeçalho, então não daria para mandar o `Bearer`; e
  a ponte não precisa de canal bidirecional para o fluxo (o caminho de volta é o
  `/resposta`).
- **`/fluxo/*` é POST e `/pedidos` é GET.** O primeiro é um comando (abrir um
  fluxo); o segundo é uma assinatura de leitura.
- **A ação roda no mundo `MAIN` (`world: 'MAIN'`), a leitura no isolado.**
  Propriedade adicionada em nó do DOM é por mundo: o rastreador de valor do React
  vive no mundo principal, então digitar do mundo isolado daria a volta sem o
  React perceber.
- **`data-dsh-nav` numerado na leitura de elementos.** Dá ao modelo um alvo
  estável entre ler e agir. A numeração é limpa a cada leitura, senão um
  `[data-dsh-nav="1"]` velho apontaria para outro elemento.
- **O painel não embute a interface do DSH.** Um `iframe` cross-site não recebe o
  cookie `SameSite=Strict`, e entregar o cookie do `/api` para o navegador
  abriria um caminho muito mais largo que a lista de endpoints da ponte.
- **Acento: só o console é ASCII, arquivo é UTF-8 acentuado.** A regra original
  ("sem acento, de propósito") existia para texto **impresso** por script sob o
  PowerShell 5.1, cuja página de código embaralha acento na saída de console. Ela
  foi aplicada larga demais: a UI do painel (`painel.html`, `painel.js`) e a
  `pagina-de-teste.html` nasceram em ASCII sem que nada disso passe pelo console.
  Arquivo é UTF-8 e vai acentuado, inclusive a página de teste, que só vale
  como teste se o acento atravessar o extrator.

## Acentuação e o payload dos instaladores (17/10/2026)

- **Arquivo é UTF-8 acentuado; só saída de console é ASCII.** A convenção antiga
  mandava escrever o projeto inteiro sem acento, e isso estava errado fora do
  console: a UI do painel mostrava "Endereco da ponte", e a fixture do extrator
  nasceu sem acento, escondendo justamente a quebra que ela devia detectar.
- **Armadilha que custa uma rodada inteira:** o `Aplicar` do `sync-memoria.ps1`
  executa os instaladores de `manutencao\`, e o instalador de arquivo único
  **grava a fonte do add-on de volta em `Documents\DSH\dsh-navegador`** a partir do
  payload embutido em base64. Editar a fonte sem recalcular o payload significa ver
  tudo revertido no próximo `Aplicar` (inclusive o do logon). Medido em 17/10/2026:
  às 07:02 o Aplicar reverteu painel, sw, manifest, README e HANDOFF para a versão
  sem acento.
- **Receita correta:** editar a fonte, conferir, recalcular as tabelas embutidas do
  instalador (sha256 + base64 de cada arquivo) e só então rodar `Aplicar`. O
  instalador confere sha256 antes de escrever, então payload igual à fonte não
  regrava nada.

## Melhorias de 04/11/2026: barra lateral, abas, print e pedido que não trava

Cinco defeitos pedidos pelo Ramses depois de um dia de trabalho travado. Todos os
consertos foram conferidos pelo `aceitar.mjs --rapido`; o teste com navegador de
verdade ficou para ele, porque o Chrome da máquina estava em uso.

### 1. O painel abria em janela separada (aparecia no Alt+Tab)

Causa medida: `abrirPainel()` fazia `await chrome.windows.getCurrent()` **antes** de
`chrome.sidePanel.open({windowId})`. O `await` consome o gesto do usuário, `open`
lança, o `catch` engole e a função cai em `abrirJanelaDestacada()`, que cria uma
janela `popup`.

Correção, em três frentes:

- o `windowId` vem pronto: `action.onClicked.addListener((aba) => ...)` e
  `commands.onCommand.addListener((comando, aba) => ...)` já recebem a aba (o
  segundo descartava o parâmetro). `janelaDaAba()` lê o id de forma síncrona, com
  `ultimaJanelaId` como reserva, então `sidePanel.open` é a primeira coisa que roda;
- `setPanelBehavior({openPanelOnActionClick: true})` na instalação e no startup: o
  Chrome abre a barra no próprio clique do ícone, sem passar por código nosso
  (`action.onClicked` deixa de disparar, e o listener fica só para o navegador que
  não aceitar o comportamento);
- migração: `fecharJanelasDoPainel()` roda no `onInstalled` e fecha as janelas
  `popup` que estejam mostrando `painel/painel.html`. Isso acontece exatamente
  quando a extensão é recarregada em `chrome://extensions`.

O `conferir-extensao.mjs` passou a cobrar as três coisas: nada de `await` antes de
`sidePanel.open`, o listener recebendo a aba e o comportamento nativo ligado.

### 2. O agente só enxergava a aba fixada

- `navegador_abas` lista id, título, URL, qual está ativa, em qual janela e qual o
  painel está fixando;
- `navegador_ler` e `navegador_agir` ganharam `aba` (id em número ou trecho do
  título/URL), com a aba fixada como padrão;
- a leitura agora responde `ativa` e `fixada` junto da aba. O `ABA_SCHEMA` declara
  `ativa`, `fixada` e `janela`, e o `projetarAba` projeta os três;
- a escolha do alvo é do PAINEL, não do host: só ele vê a lista viva. `casarAba`
  prefere a aba fixada, depois a ativa, e **falha com a lista quando o trecho é
  ambíguo**, em vez de escolher a primeira. Aba errada com o agente digitando
  dentro é pior que erro na cara.

### 3. `navegar` com `nova_aba: true`

`location.assign` só troca a página da aba em que roda, então abrir aba nova não
pode passar pela injeção: o service worker faz `chrome.tabs.create` (caso
`navegar-nova`), o painel fixa a aba recebida e conta isso à ponte, e o resultado
devolve o id da aba nova.

### 4. `navegador_print`

- área visível: `chrome.tabs.captureVisibleTab` depois de ativar a aba (a API só
  pega a aba ativa da janela);
- página inteira: mede a página (`medirParaPrint`, função injetada), rola de
  viewport em viewport respeitando a cota de 2 capturas por segundo, e devolve as
  fatias com a posição CSS de cada uma. A costura é feita no PAINEL, com canvas: o
  service worker não tem documento;
- a imagem volta na resposta da ferramenta como bloco `{type:'image', attachment}`,
  que é o formato do próprio `read_image` (o valor declara `attachmentId`,
  `mediaType`, `bytes`, `width` e `height`). O PNG também é gravado em
  `~/.dsh-navegador/prints`, que é o que sobrevive à conversa e o que o `read_image`
  relê. Se o serviço `attachments` não estiver montado, a ferramenta continua
  devolvendo o arquivo e avisa que a imagem não pôde ser embutida.

Limite conhecido da costura: cabeçalho fixo aparece em todas as fatias, e no máximo
10 telas por print.

### 5. Aprovação que não vem mais travava o agente

Antes: 180 s de espera e, no fim, "o navegador nao respondeu ao pedido". Agora:

- 12 s é o teto da espera por aprovação. Passou disso, `navegador_agir` volta na
  hora com `pendente: true` e o `id` do pedido, e o texto diz ao modelo que nada foi
  executado e que **não** repita a ação;
- leitura, print e lista continuam falhando se o painel não responder em 20 s,
  porque nesses casos silêncio é defeito, não aprovação pendente;
- o pendente expira em 2 minutos: a ponte avisa o painel (`{tipo:'expirado'}`), o
  cartão sai da tela e resposta que chega depois não executa nada;
- o painel não desenha pedido com mais de 5 minutos nem pedido com `expiraEm`
  vencido, e a reentrega ao reconectar ignora o que já venceu (era isso que trazia
  a ação de ontem de volta);
- o cartão saiu do "Executando..." eterno: a execução tem teto de 30 s e, se falhar
  ou estourar, os botões voltam e a linha de status aparece no transcrito.

### 6. O aviso "Unrecognized manifest key 'sidebar_action'"

O cartão da extensão em `chrome://extensions` mostrava um aviso. A chave existia
para um suposto `sidebar_action` do Opera, que nunca foi implementado (medido em
17/10/2026: `typeof chrome.sidebarAction` é `undefined` no Opera GX 136) e que é,
na prática, chave do Firefox. O Chrome a acusa como desconhecida e nada naquela
chave funcionava em navegador nenhum. Removida na 0.2.1; `side_panel` e a permissão
`sidePanel` continuam no manifesto, e o `conferir-extensao.mjs` passou a cobrar
que `sidebar_action` não volte.

### O que ficou de fora, e por quê

- **Teste no navegador de verdade.** O Chrome estava em uso e a regra era não
  controlá-lo. O roteiro está na entrega para o Ramses: recarregar a extensão,
  reiniciar o DSH e exercitar os cinco itens.
- **Regravar `manutencao\instalar-navegador.ps1`.** O `Aplicar` do
  `sync-memoria.ps1` roda o instalador, e o instalador **reescreve a fonte a partir
  do payload embutido**: enquanto o payload estiver na versão velha, o próximo
  `Aplicar` (inclusive o do logon) reverte `sw.js`, `painel.js`, `ferramentas.js`,
  `ponte.js`, `injecao.js`, `manifest.json`, `package.json`, `README.md` e as
  ferramentas. O briefing mandava avisar antes de mexer em `manutencao\`, então o
  instalador não foi tocado. Ação pendente do Ramses.
- **`chrome.debugger` para print de página inteira de uma vez.** Mostra a faixa
  "está sendo depurado" e pede permissão nova; a costura por rolagem evita as duas
  coisas.

### Como foi conferido (04/11/2026)

`node ferramentas\aceitar.mjs --rapido`: 10 de 10 etapas passaram. Entraram duas
etapas novas, ambas sem precisar do DSH no ar: `conferir-abas.mjs` (escolha da aba
alvo, 27 conferências) e `testar-pendencias.mjs` (ponte real com prazos em
milissegundos, 21 conferências). Também foi corrigido o import do
`conferir-peer.mjs`, que apontava para `file:///C:/Users/victo/...` e por isso
quebrava no notebook, onde o perfil é outro.

## Incidente de 04/11/2026: a pasta do add-on foi esvaziada

Medido às 12:23, quando o Ramses mandou o print da extensão já na 0.2.0:

- `Documents\DSH\dsh-navegador` estava **vazia** (0 itens, `Test-Path` falso em
  `package.json`, `extensao\manifest.json`, `plugin\ponte.js`). Carimbo do
  diretório: 12:09.
- a cópia do perfil, `%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\dsh-navegador`,
  também estava vazia. Carimbo: 12:16.
- a lixeira não tinha nada recente, e uma varredura por `*navegador*` em
  `Documents`, `%TEMP%` e no harness não achou backup nenhum.
- o diretório carrega uma ACL que não fui eu que pus: `Todos` com
  `DeleteSubdirectoriesAndFiles` **negado**, mais um `Allow` de escrita para o SID
  `S-1-4-212815977-495775437`. Não sei de onde veio, e vale olhar se o incidente
  repetir.

Recuperação: o `manutencao\instalar-navegador.ps1` havia sido regerado às 11:42,
depois das minhas edições, e embutia **todos os 39 arquivos** com sha256. Restaurei
a fonte a partir desse payload, arquivo por arquivo, conferindo o sha256 de cada
um: 39 restaurados, 0 divergência. Os hashes voltaram idênticos aos de antes do
esvaziamento (`sw.js` `cc6a7855...`, `painel.js` `463fcb54...`, `ponte.js`
`71a51d8b...`, `ferramentas.js` `15cfc048...`), então nada se perdeu.

O que continua sem resposta: **o que esvaziou a pasta**, e **o que esvaziou a cópia
do perfil**. O host em memória seguiu respondendo 0.3.0, porque o plugin já estava
carregado; o próximo boot, sem a cópia do perfil, não teria a metade host. Antes de
reiniciar o DSH, a junção ou a cópia precisa ser refeita:
`ferramentas\instalar-no-perfil.ps1`.

## Segunda rodada de melhorias (04/11/2026): iframe, rolagem, abas, digitação e cópia

Esta rodada partiu do estado em que a 0.4.0 (host) e a 0.2.1 (extensão) estavam
**vivas**: o `/ola` respondia `0.4.0` na porta 43129, o `ponte.json` foi escrito
às 17:14, e o Chrome tinha a extensão carregada sem compactação de
`Documents\DSH\dsh-navegador\extensao`, com `open_side_panel_on_icon_click: true`
já gravado. Ou seja: a barra lateral da melhoria 1 da rodada anterior estava
ligada de verdade, e o que faltava era o resto.

Medições de partida, com o add-on vivo e sem tocar no Chrome do Ramses:

- `navegador_abas` listou 15 abas em **uma** janela (id 188155031), com a aba do
  DrozChat fixada. O caso multi-janela não estava disponível para teste naquele
  momento, então a correção foi feita por contrato da API e coberta por teste
  estático;
- `navegador_ler` na aba `admin.meudroz.com/#/simulator?...` devolveu **só a
  identificação da aba**, sem texto e sem elementos: o simulador desenha o chat
  dentro de `<iframe name="preChat">`, e a injeção rodava com
  `allFrames: false`. É o caso real do item 2;
- `navegador_ler` no Slack devolveu só o texto do painel de busca, que não é a
  lista de mensagens: confirmou que o scroller da conversa é interno (item 3).

### O que mudou

1. **Leitura de iframe.** `ler` agora injeta com `allFrames: true`, e cada função
   injetada devolve `quadro: {id, url, titulo, principal, moldura}`. O id nasce no
   primeiro uso do documento (`window.__dshNavQuadroId`, mundo isolado) e é o que
   permite a marca `data-dsh-nav="qab12:3"` ser única no navegador inteiro. A
   composição mora em `extensao/quadros.js` (puro, testado no Node por
   `testar-quadros.mjs`): texto com cabeçalho por quadro quando há mais de um,
   elementos com rótulo, seleção e rolagem juntadas. A ação resolve o quadro em
   duas fases (`localizarNaPagina` em todos, `agirNaPagina` em um): agir em todos
   de uma vez clicaria no anúncio junto com o botão.
2. **Rolagem em container próprio.** Nova função `rolarNaPagina`, com dois modos:
   `procurar` (mede em todos os quadros e devolve `rolavel/restante/alvo`) e
   `rolar`. A escolha do container é: container do `seletor`, container sob o
   centro da tela (só quando a página não rola), a página, e o maior container
   rolável visível. Nova leitura `o_que: 'rolagem'` mostra quem rola antes de
   tentar. A rolagem saiu do `agirNaPagina` para não ter duas implementações.
3. **Digitação em campo controlado.** `digitar` agora: clica, foca, limpa pelo
   pipeline de edição, tenta `execCommand('insertText')`, cai para o setter nativo
   com `beforeinput` + `input` (InputEvent) quando não confere, fecha com `change`
   e `blur` sintéticos, e **confere o valor final** (`verificado`). `modo: 'teclas'`
   digita caractere por caractere com `keydown`/inserção/`keyup`. O resumo diz
   "o campo confere" ou mostra o valor que sobrou, para o agente não seguir em
   frente achando que digitou.
4. **Troca de aba.** Botão **Abas** na faixa da aba, diálogo com a lista completa
   de `chrome.tabs.query({})`, agrupada por janela, com a fixada e a ativa no
   topo, filtro por título/URL e a marca de janela quando há mais de uma. A aba
   fixada passou a ser lembrada em `chrome.storage.session` (chave `aba-fixada`) e
   retomada na abertura do painel quando ainda existe. `abaAtual` passou a olhar
   `chrome.windows.getLastFocused({windowTypes:['normal']})` antes das demais
   janelas, e `windows.onFocusChanged` ressincroniza o contexto.
5. **Cópia para a área de transferência.** `navegador_copiar` (texto já lido) e
   `navegador_agir` com `acao: "copiar"` (seleção ou texto de um seletor). A ordem
   é `navigator.clipboard` no painel (o manifesto ganhou `clipboardRead` e
   `clipboardWrite`), `execCommand('copy')` e, por último, o host com
   `Set-Clipboard` do PowerShell e **o texto por STDIN**. O resultado traz
   `metodo` e `conferido` (releitura da área de transferência).
6. **Barra lateral.** Não mudou de mecanismo: a 0.2.1 já chamava `sidePanel.open`
   de forma síncrona e ligava `openPanelOnActionClick`. O que entrou foi a lista
   de abas que faltava e a lembrança da aba fixada, que é o que o uso diário pedia.

### Compatibilidade entre metades

- **Extensão velha (0.2.1) com host novo (0.5.0):** `navegador_ler` e
  `navegador_agir` funcionam como antes (o painel ignora `quadro`/`modo`);
  `navegador_copiar` espera a resposta do painel, que não conhece `copiar`, e cai
  no host depois do prazo (até 20 s). Funciona, só demora na primeira vez.
- **Extensão nova (0.3.0) com host velho (0.4.0):** a leitura devolve `quadros` e
  `rolagem`, mas o schema fechado da ferramenta velha descarta os campos; a ação
  `copiar` roda no painel e o host velho não declara `copiado`, então o modelo vê
  só o `resumo`. Nada quebra.
- **O que quebra de verdade** é usar o `quadro` da leitura (id de quadro) para
  agir enquanto o painel ainda é 0.2.1: ele não conhece o parâmetro, age na aba
  inteira e o seletor `qab12:n` não casa em lugar nenhum. Por isso o roteiro de
  teste é recarregar a extensão **antes** de exercitar o iframe.

### Como foi conferido, e o que falta

- `node ferramentas\testar-quadros.mjs`: 46 conferências, 0 falha (puro, sem
  navegador).
- `node ferramentas\aceitar.mjs --rapido`: 11 de 11 etapas passaram. A única
  pendência é a esperada: a ponte viva respondia `0.4.0` e o disco tinha `0.5.0`,
  então a metade host nova só entra no próximo boot do DSH.
- Teste com navegador de verdade (iframe no simulador do Droz, rolagem no Slack,
  digitação em formulário e cópia no diálogo Token do `admin.droz.cloud`) depende
  de recarregar a extensão e reiniciar o DSH; o roteiro está na entrega desta
  sessão, e nada foi executado no Chrome do Ramses sem a aprovação dele.

### Instalador e versões

- `package.json` **0.5.0** (metade host), `extensao/manifest.json` **0.3.0**.
- `manutencao\instalar-navegador.ps1` regerado nesta rodada; bytes e sha256 na
  tabela do `README.md` de `manutencao`.
