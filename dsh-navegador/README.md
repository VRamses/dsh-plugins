# dsh-navegador

Add-on de navegador para o DeepSeek Harness: um painel na barra lateral do Opera
(ou do Chrome/Edge) que conversa com a instância do DSH que já está rodando na
máquina, usa **a aba atual como contexto** e deixa o agente **ler** a página
sempre e **agir** nela só com a sua aprovação, ação por ação.

São duas metades:

| metade | onde vive | o que faz |
|---|---|---|
| `plugin/` | dentro do DSH (perfil `web`) | expõe a ponte local `/dsh-navegador` com token próprio e registra as ferramentas `navegador_ler` e `navegador_agir` |
| `extensao/` | dentro do navegador | painel da conversa, coleta de contexto da aba, aprovação e execução das ações |

A ponte não abre porta nova: ela mora no mesmo servidor web do DSH, em rotas
irmãs do `/api`, e só responde em loopback.

## Por que uma ponte, e não o `/api` do DSH

O `/api` do `dsh web` é fechado por um cookie de sessão do navegador que é
`HttpOnly` + `SameSite=Strict` e amarrado a uma autoridade. Nenhuma extensão
alcança esse cookie, e uma página qualquer não consegue ler uma resposta
cross-origin. Então a ponte faz o caminho contrário e mais estreito:

1. um plugin **dentro** do DSH registra as rotas dele, com **token próprio**,
   guardado no cofre de credenciais do harness (`<home>\.credentials.yaml`,
   registro `dsh-navegador/ponte`);
2. a extensão pega o token uma vez pelo `/parear` (só de loopback, nunca com
   cabeçalho CORS, e recusando `Origin` de página web);
3. daí em diante tudo exige `Authorization: Bearer <token>`;
4. o plugin fala com o harness **em processo**, por `ctx.get('typertGateway')`,
   sem cookie, sem WebSocket e sem HTTP interno.

## Instalação

### 1. O plugin (no DSH)

O caminho normal é o instalador de arquivo único do vault:

```
%USERPROFILE%\Documents\dsh-memory\manutencao\instalar-navegador.ps1
```

Ele escreve a fonte em `<Documents>\DSH\dsh-navegador`, registra a dependência
`file:` no `package.json` do perfil, refaz o vínculo em `node_modules` e insere o
bloco no `cordis.patch.yml` **antes da sentinela dos MCPs**. O `Aplicar` do
`sync-memoria.ps1` faz isso sozinho em toda máquina que tem a linha na lista
`$ADDONS`.

Para desenvolvimento, sem o instalador:

```powershell
pwsh -File ferramentas\instalar-no-perfil.ps1            # instala ou atualiza
pwsh -File ferramentas\instalar-no-perfil.ps1 -Conferir   # só informa o estado
```

**A metade host de um add-on é importada uma vez, no boot.** Depois de instalar
ou de mexer no código do plugin, feche e reabra o DSH Desktop. Reaplicar o patch
(que acontece sozinho quando o arquivo muda) remonta a configuração e até remonta
o plugin, mas **não reimporta o módulo**: já foi medido, duas vezes, em
16/10/2026 (a versão antiga continuou respondendo depois de remover e reinserir o
bloco).

Confira que subiu:

```powershell
curl.exe -s http://127.0.0.1:43129/dsh-navegador/ola
```

### 2. A extensão (no navegador)

Modo desenvolvedor, sem loja e sem assinatura:

1. abra `opera://extensions` (ou `chrome://extensions`);
2. ligue **Modo desenvolvedor**;
3. **Carregar sem compactação** e aponte para
   `<USERPROFILE>\Documents\DSH\dsh-navegador\extensao`;
4. abra o painel: o ícone na barra de ferramentas, `Alt+Shift+D`, ou o menu de
   contexto da página (**Ler esta página** / **Perguntar sobre a seleção**).

**Onde o painel abre, e por quê.** No Chrome e no Edge ele abre como barra lateral
(`chrome.sidePanel`), inclusive no clique do ícone: o add-on liga
`setPanelBehavior({ openPanelOnActionClick: true })` na instalação, e o Chrome abre
a barra no próprio gesto. **No Opera GX ele abre como janela destacada, e isso não é
escolha do add-on**: medido em 17/10/2026 no Opera GX 136 (Chromium 152),
`typeof chrome.sidePanel` e `typeof chrome.sidebarAction` devolvem `undefined` nos
dois. O Opera avisa que não conhece `side_panel`/`sidePanel`, então não existe API
para pôr o painel na barra lateral dele. A janela tem largura de painel, lembra
posição e tamanho entre aberturas, e o atalho `Alt+Shift+D` abre e foca.

A chave `sidebar_action` saiu do manifesto em 04/11/2026. Ela existia para um
hipotético suporte do Opera, que nunca veio, e o Chrome passou a mostrá-la como
**"Unrecognized manifest key"** no cartão da extensão. Com ela fora, o cartão fica
sem aviso; no Opera nada muda, porque ele já ignorava a chave.

A janela destacada do Opera é o único caso em que o painel aparece no Alt+Tab. No
Chrome, a janela `popup` que a versão 0.1.1 abria era um defeito (o `await` antes de
`sidePanel.open` consumia o gesto do usuário e a chamada caía no `catch`); a 0.2.1
chama `open` de forma síncrona e, ao ser recarregada, fecha a janela antiga.

No primeiro uso o painel faz tudo sozinho: acha a ponte, pareia e pega o token.
Se precisar, os **ajustes** deixam trocar o endereço e parear de novo na mão.

Depois de editar arquivos da extensão, o botão **Recarregar** em
`opera://extensions` basta (o plugin do DSH não precisa de nada).

## Como se usa

- **aba**: manda o texto da aba junto com a pergunta (ligado por padrão);
- **abas**: abre a lista de todas as abas do navegador, de todas as janelas, para
  escolher qual o painel fixa (a escolha é lembrada enquanto o navegador estiver
  aberto, e a lista diz qual é a ativa agora);
- **print**: manda também uma captura da aba visível;
- **selecao**: põe o trecho selecionado na caixa de texto, como citação, para
  você editar antes de enviar;
- **conversa**: escolhe uma conversa existente do DSH ou cria uma nova (a mesma
  lista da barra lateral do aplicativo);
- **autoaprovar**: deixa as ações do agente rodarem sem cartão nesta conversa
  (veja "Aprovar sem cartão" abaixo);
- **limpar**: limpa só o transcrito desta janela; a conversa no DSH continua.

O agente ganha cinco ferramentas enquanto o painel estiver aberto. Todas aceitam
o parâmetro opcional `aba` (id em número ou trecho do título/URL); sem ele, valem
para a aba fixada no painel:

| ferramenta | o que faz | aprovação |
|---|---|---|
| `navegador_abas` | lista id, título, URL, qual está ativa, em qual janela e qual o painel está fixando | não |
| `navegador_ler` | identifica a aba, lê o texto (inclusive dentro de iframes, dizendo quais quadros leu), a seleção, os elementos acionáveis já numerados, ou quais áreas da página realmente rolam; diz se a aba é a ativa e se é a fixada | não |
| `navegador_print` | devolve a aba como imagem PNG (área visível ou página inteira), além de gravar o arquivo | não |
| `navegador_agir` | uma ação por chamada: clicar, digitar (com modo tecla por tecla), teclar, rolar (no container certo, não só na janela), navegar (com `nova_aba: true` abre outra aba e fixa o painel nela), copiar, voltar, avançar, recarregar, esperar; em página com iframe, `quadro` escolhe o quadro | sim, cartão no painel com alvo e ação, antes de qualquer coisa acontecer; ou direto, com a autoaprovação ligada |
| `navegador_copiar` | copia um texto para a área de transferência da máquina (API do clipboard no painel e, se o navegador recusar, a área de transferência do sistema pelo host) | não |

Recusar no painel faz a ferramenta voltar com "o usuário recusou esta ação", e o
agente para e pergunta o que fazer. Com o painel fechado as ferramentas falham com
uma mensagem que diz exatamente isso.

**Aprovação que não vem a tempo não trava mais o agente.** A espera é de 12
segundos: passou disso, a ferramenta volta na hora com `pendente: true` e um
identificador, dizendo que a ação espera aprovação no painel. O pedido pendente
expira em 2 minutos (o painel é avisado e o cartão sai da tela), e nada dele
sobrevive ao dia.

### Aprovar sem cartão, durante a conversa

Navegar com o agente pedindo confirmação a cada página é impraticável, então o
modo existe, e ele é explícito nos dois sentidos:

- **para ligar**, marque "não perguntar de novo nesta conversa" no cartão e
  aprove, ou clique em **Autoaprovar** na barra de atalhos;
- **enquanto está ligado**, uma faixa âmbar fica fixa acima dos cartões ("o agente
  age sem pedir a cada ação") com o botão **Desligar**, e cada ação executada
  entra no transcrito como "ação executada automaticamente (autoaprovação
  ligada): ...", então o registro do que aconteceu continua ali;
- **o escopo é a conversa**: trocar de conversa no painel desliga sozinho, e a
  escolha mora em `chrome.storage.session`, que morre quando o navegador fecha.
  Não vira um "sempre permitir" esquecido;
- **o agente sabe**: o resultado volta com `autoaprovada: true` e o texto que o
  modelo lê diz que o painel está com a autoaprovação ligada, em vez de afirmar
  que você aprovou aquela ação.

O selo viaja no envelope da resposta, não dentro do valor: painel novo com host
antigo não injeta campo que o schema fechado da ferramenta recusaria, e painel
antigo com host novo simplesmente não manda o selo.

### Iframe, rolagem, digitação e área de transferência (04/11/2026)

Cinco defeitos que só aparecem no navegador de verdade, todos medidos antes de
mexer, e todos com um caso real como prova:

1. **Leitura dentro de iframe.** O simulador de chatbot do Droz roda o chat num
   `<iframe name="preChat">`, e `navegador_ler` voltava vazio porque injetava só no
   quadro principal. Agora a leitura roda em todos os quadros
   (`executeScript({allFrames: true})`), cada quadro se identifica e a resposta
   junta o texto com cabeçalho por quadro. Na lista de elementos, a marca vira
   `data-dsh-nav="qab12:3"`, com o id do quadro, para o seletor ser único no
   navegador inteiro. Quando o agente precisa apontar um quadro, `quadro` leva
   esse id; sem ele a ação escolhe pelo seletor e prefere o principal, e falha
   com a lista quando dois iframes casam ao mesmo tempo (clicar no anúncio em vez
   do botão é pior que erro na cara). Quem junta os quadros é `extensao/quadros.js`,
   que é puro e por isso é testado no Node por `ferramentas/testar-quadros.mjs`.
2. **Rolagem em container próprio.** `rolar` chamava `window.scrollBy`, e em
   Slack, Gmail e Miro a janela não rola nada: quem rola é um `div` interno. Agora
   o alvo é escolhido nesta ordem: o container do elemento quando vem `seletor`,
   o container rolável sob o centro da tela, a página, e por fim o maior container
   rolável visível. A resposta diz o alvo e a posição resultante, e
   `navegador_ler` com `o_que: "rolagem"` mostra quem rola antes de tentar.
3. **Digitação em campo controlado.** O valor era escrito direto no DOM e o estado
   do React não via. Agora o campo recebe clique, foco, limpeza pelo pipeline de
   edição (`execCommand`), depois `beforeinput`, `input`, `change` e `blur`
   nativos, e a resposta confere o valor final (`o campo confere` ou o valor que
   sobrou). `modo: "teclas"` digita caractere por caractere, com `keydown`,
   inserção e `keyup`, que é o que faz autocomplete e máscara reagirem.
4. **Troca de aba com várias janelas.** O botão **Abas** abre a lista completa do
   `chrome.tabs.query({})`, agrupada por janela, com a fixada e a ativa no topo, e
   permite fixar qualquer aba. A aba fixada passa a ser lembrada em
   `chrome.storage.session` e retomada ao reabrir o painel, e o worker olha a
   última janela normal em foco (`chrome.windows.getLastFocused`), não a primeira
   que aparecer.
5. **Cópia para a área de transferência.** Clique sintético não conta como
   ativação de usuário, então `navigator.clipboard` recusa. A ordem é: API do
   clipboard no painel (a extensão tem `clipboardRead`/`clipboardWrite`),
   `execCommand('copy')` e, por último, o host escrevendo pela `Set-Clipboard` do
   PowerShell, com o texto por STDIN (nunca por argv). A ferramenta
   `navegador_copiar` copia texto já lido; `navegador_agir` com `acao: "copiar"`
   copia a seleção do usuário ou o texto de um seletor.

### Onde as conversas do navegador ficam

O grupo da barra lateral é um **Workspace** do DSH, não um `cwd`. A metade host
garante esse Workspace no boot (`workspace/create` sobre a pasta **`DSH Opera`**)
e publica o id no `/ola`, em `addon.workspaceId`; a ponte troca o `cwd` de todo
`session/create` que vem do painel por esse `workspaceId`, que é o que
**contabiliza** a conversa. Medido em 22/10/2026: `session/create` só com `cwd`
grava o diretório da sessão e a conversa fica em "Ungrouped", fora de Workspace
nenhum.

A pasta vem de `config.pasta` no patch; sem ela, vale `Documents\DSH\DSH Opera`
para o pacote instalado no perfil e a pasta vizinha do pacote para o clone. O nome
final do caminho vira o `title` do Workspace, e é o `title` que aparece na barra
lateral (renomear a pasta não renomeia o grupo).

Conversa criada antes desta correção continua onde estava: o `cwd` fica gravado no
cabeçalho da sessão, o DSH não tem chamada para trocá-lo, e só contabiliza a
sessão no Workspace no momento em que ela nasce.

## Modelo de segurança, e o que ele NÃO cobre

O que está cercado, e foi medido com `ferramentas/testar-ponte.mjs seguranca`:

- a ponte só responde a **loopback** e exige `Host` local (um `Host` que resolve
  para fora recebe 403);
- `/parear` não devolve **nenhum** cabeçalho CORS e recusa `Origin` de página
  web, então uma página maliciosa não lê o token;
- todo o resto exige o token, comparado em tempo constante;
- a lista de endpoints é **positiva**: `terminal/*`, `settings/*`,
  `credentials/*`, `pluginManager/*`, `dynamicCordisRunner/*` e `fileUploads/*`
  recebem 403. São 41 endpoints unários e 9 de fluxo permitidos (`GET /ola`).

O que **não** está coberto, e você merece saber:

- **Qualquer processo local pode parear.** O token não é um segredo forte: quem
  alcança `127.0.0.1` pode chamar `/parear` e receber o mesmo token. Isso inclui
  outra extensão de navegador instalada com permissão de host. A defesa real é o
  escopo curto da lista de endpoints e o fato de nada sair da máquina. Depois do
  primeiro pareamento, dá para desligar o pareamento e ficar só com o token: no
  bloco do patch, `config: { pareamento: false }`.
- **A lista de endpoints cerca a PONTE, não o agente.** O agente do DSH roda com
  `danger-full-access` e alcança terminal e arquivos por conta própria. O corte
  existe para limitar o que uma extensão (ou uma página que conseguisse falar
  com a ponte) dispara contra o harness.
- **O agente lê a aba que o painel aponta.** Não há leitura de outras abas, e o
  painel avisa quando a aba alvo não é mais a aba ativa.
- **A autoaprovação tira você do meio do caminho.** Com ela ligada o agente
  clica, digita e navega sem cartão, então o "confira antes de aprovar" deixa de
  existir naquela conversa. As proteções são: a faixa âmbar sempre visível com o
  Desligar, o registro de cada ação no transcrito, o escopo por conversa e o fim
  automático quando o navegador fecha. O que ela **não** faz é desfazer o que já
  foi executado.
- **Perguntas do agente não se respondem pelo painel** (veja abaixo).

## Pergunta do agente: onde ela é respondida

Depende de uma configuração do DSH, e as duas variantes funcionam assim:

**Com `tool-ask-user` em `mode: timed` (como está nesta máquina desde 17/10/2026).** A
pergunta entra na projeção `userQuestions.active` com `state: 'open'` e `callId`, o painel
desenha o cartão com as opções e um campo de texto livre, e **Responder fecha a pergunta
e o turno segue**, com o agente recebendo a resposta. Isso foi medido, não deduzido:
resposta "Azul" enviada com a pergunta aberta, pergunta fora da projeção, e o modelo
respondendo "Azul." no mesmo turno.

**Com o padrão do pacote (`mode: legacy`, sem config).** A pergunta **não** entra em
`userQuestions.active`, então não existe `callId` para responder; o painel mostra o
cartão informativo e diz onde responder. É o que acontece numa instalação nova.

Para virar o modo, o preset usado pelas conversas precisa da entrada:

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: -1
```

Os presets de usuário moram em `%APPDATA%\dsh-desktop\harness\.agent-presets\<id>\`
(`preset.yml` mais `agent.cordis.yml`), e um arquivo com o id de um preset embutido é
aceito. O registro é lido **no boot**: depois de gravar, é preciso sair pelo menu da
bandeja e abrir de novo (fechar a janela não reinicia). `timeout: -1` é escolha: com prazo,
a pergunta morre se ninguém responder. Detalhe e o custo do override estão em
`HANDOFF-navegador.md` §4.3.

## Ferramentas de desenvolvimento

Todas em `ferramentas/`, e todas usam o MESMO cliente que a extensão usa
(`extensao/painel/api.js`), então o que passa nelas é o código que roda no painel.

| script | para que serve |
|---|---|
| `aceitar.mjs` | **a conferência de tudo num comando**: roda as etapas abaixo em ordem (estática, projeção da aba, projeção da pergunta, transcrito, diagnóstico, segurança, ponta a ponta) e termina com veredito; `--rapido` pula a etapa que cria sessão de verdade |
| `conferir-projecao-aba.mjs` | extrai `projetarAba` e `ABA_SCHEMA` do próprio plugin e prova que a saída da ferramenta não leva chave fora do schema (o DSH recusa a saída inteira quando leva). Não precisa do DSH no ar |
| `conferir-pergunta-projecao.mjs` | alimenta `aplicarProjecoes` com a projeção real de uma pergunta `open` e cobra que o painel a reconheça como respondível. Protege o filtro que já esteve errado (exigia `continued`), defeito que é mudo: a pergunta aparece, mas sem botão. Não precisa do DSH no ar |
| `instalar-no-perfil.ps1` | instala/atualiza o plugin no perfil `web` (`-Conferir` só informa) |
| `conferir-extensao.mjs` | conferência estática da extensão: id de elemento que não existe no HTML, campo de `tela`/`ui` com nome torto, API do Chrome sem permissão, import quebrado, função injetada que cita algo de fora, `await` antes de `sidePanel.open` (o defeito que jogava o painel na janela destacada) e as amarras das ferramentas novas |
| `conferir-abas.mjs` | extrai `casarAba` do painel e prova a escolha da aba alvo por id e por trecho de título/URL, incluindo acento, ambiguidade e a preferência pela aba fixada. Não precisa do DSH no ar |
| `testar-quadros.mjs` | importa `extensao/quadros.js` no Node e prova a composição do texto/elementos/rolagem de vários quadros, a escolha do quadro para agir (principal, ambiguidade, quadro pedido) e a origem do texto na cópia. Não precisa do DSH nem do navegador |
| `testar-pendencias.mjs` | roda a ponte de verdade e prova a espera curta por aprovação (`pendente` + id), a expiração em segundos e a não-reentrega de pedido vencido. Não precisa do DSH no ar |
| `mapear-endpoints.mjs` | lê os descritores do Remote dentro do `app.asar` e diz o nome real das chaves de argumento |
| `conferir-envelope.mjs` | compara a tabela de envelope do `api.js` com os descritores da versão do DSH instalada e falha quando diverge |
| `descritores.mjs` | o leitor do `app.asar` usado pelos dois acima (formatos 0.11 e 0.12) |
| `testar-ponte.mjs diagnostico` | ola, pareamento, token e os endpoints que o add-on chama |
| `testar-ponte.mjs seguranca` | as cercas: token, loopback, `Host`, `Origin`, lista de endpoints, corpo inválido |
| `testar-ponte.mjs ponta-a-ponta` | cria uma sessão descartável, segue o fluxo, manda um prompt e apaga |
| `testar-ponte.mjs painel-falso` | faz o papel do painel e responde os pedidos do agente |
| `testar-ponte.mjs perguntas` | prova que o painel enxerga a pergunta pendente e que a projeção fica vazia |
| `testar-transcrito.mjs <sessionId>` | passa os quadros reais de uma sessão pelo transcrito e confere os invariantes |
| `gerar-icones.py` | regera os PNGs da extensão (Pillow) |

O `mapear-endpoints.mjs` merece um aviso: o nome da chave de argumento **não** é
sempre `request` (`session/list` quer `_request`, e `userQuestions/answer` não
tem envelope nenhum). Errar isso dá "args fields do not match the descriptor" e
custa uma rodada por endpoint.

E o **miolo** do envelope também muda: no DSH 0.12 `skills/list` e
`messageFeedback/list` continuam com `request`, mas exigem `request: { sessionId }`.
Quem pega isso antes do gateway é o `conferir-envelope.mjs`, que virou etapa do
`aceitar.mjs`: ele lê os descritores da versão instalada e compara com a tabela do
`api.js`. Se o DSH for atualizado e a tabela ficar velha, a etapa falha dizendo
qual endpoint e qual chave, em vez de o painel quebrar em uso.

### A conferência de tudo

```
node ferramentas/aceitar.mjs
```

Roda em ordem: conformidade estática, escolha da aba alvo, espera e expiração dos
pedidos, autoaprovação, envelope contra os descritores do DSH, Peer do gateway,
projeção da aba, projeção da pergunta, transcrito sintético, diagnóstico da ponte,
segurança, ponta a ponta (cria uma sessão, manda um prompt e apaga) e transcrito com
quadros reais. Sai com **0** só quando todas as etapas passam **e** não há pendência.
Se a ponte viva estiver numa versão diferente da do disco, ele avisa em vez de fingir
que está tudo certo: metade host nova só entra depois de fechar e reabrir o DSH.

## Convenção de escrita do código

Só o **texto que sai no console** fica sem acento: mensagem de erro impressa por
script `.mjs`/`.ps1` e saída de instalador. O motivo é estreito e real, os
instaladores do vault rodam sob o Windows PowerShell 5.1, e a página de código do
console (cp850/cp1252) embaralha acento na saída. Isso vale para texto
**impresso**, não para arquivo.

**Arquivo em disco é UTF-8 e vai acentuado normalmente**: `.html`, `.css`, `.js`,
`.json`, README, handoff e tudo o que o navegador exibe. A regra nasceu estreita e
foi aplicada larga demais (UI do painel e página de teste nasceram em ASCII), o que
é defeito de escopo, não exigência técnica: arquivo nunca passa pelo console. Pior,
página de teste sem acento esconde do teste justamente a quebra de acento que o
extrator precisa detectar.

Ao gravar arquivo neste projeto: UTF-8 sem BOM, acento no conteúdo.

**Armadilha que custou um arquivo de 842 KB (17/10/2026).** Editar arquivo com
`Get-Content -Raw` + `[IO.File]::WriteAllText` neste PowerShell **re-codifica o
conteúdo**: o `Get-Content` lê UTF-8 como ANSI e a gravação escreve os bytes
resultantes como UTF-8. Cada passada dobra o dano: o `â` de `instância` vira dois
caracteres estranhos, e na passada seguinte cada um deles vira dois, até a linha
chegar a 126 mil caracteres. Aconteceu com `manutencao\README.md` do vault em cinco
rodadas seguidas, e com o README e o handoff deste repositório numa delas.

A regra prática: **editar arquivo com a ferramenta de edição, não com string de
PowerShell**. Quando precisar conferir, ler com `[IO.File]::ReadAllText($caminho,
[Text.Encoding]::UTF8)` e gravar com `New-Object Text.UTF8Encoding($false)`. O sinal
de alerta é barato: texto com o par `Ã` seguido de sinal de controle é arquivo dobrado.

## Estrutura

```
plugin/          metade host (Cordis), ESM
  index.js         monta a ponte, despacha as rotas
  protocol.js      rotas, versao do protocolo e a LISTA de endpoints permitidos
  auth.js          token no cofre, cercas de loopback/Host/Origin
  ponte.js         conversa com o typertGateway, NDJSON e a fila de pedidos
  ferramentas.js   navegador_abas, navegador_ler, navegador_print, navegador_agir,
                   navegador_copiar, navegador_cookies
  transferencia.js area de transferencia pelo host (Set-Clipboard), ultimo recurso
extensao/        metade navegador (MV3)
  manifest.json    side_panel (Chrome/Edge) + permissao de clipboard
  sw.js            abre o painel na barra lateral, menu de contexto, atalhos,
                   lista de abas, injecao em todos os quadros e captura de tela
  injecao.js       as funcoes injetadas (leitura por quadro, acao, rolagem em
                   container, leitura para copiar e medida para o print)
  quadros.js       composicao dos quadros e escolha do alvo (puro, testado no Node)
  comum.js         configuracao e utilidades (inclui a aba fixada lembrada)
  painel/          a interface: api.js, transcrito.js, markdown.js, painel.js
ferramentas/     scripts de instalacao, teste e diagnostico
```

## Requisitos

- DSH Desktop **0.12.1** (é a versão em que a ponte passou a funcionar de novo,
  depois de o gateway exigir um Peer por chamada; ver "Peer" abaixo). Foi escrito
  e medido no 0.11.1 (harness `dsh` 0.2.0-rc.2); a lista de endpoints e a tabela
  de envelope saem dos descritores da versão instalada, e o
  `mapear-endpoints.mjs` refaz a leitura em qualquer outra.
- Opera (ou Opera GX) 116+, Chrome/Edge 116+.

### Peer do gateway (DSH Desktop 0.12+)

O gateway do DSH 0.12 não aceita mais `invokeRpc`/`stream` sem dono: ele faz
`assertPeerLive(request.peer)`, que lê `peer.signal`. Sem Peer a chamada volta
`Cannot read properties of undefined (reading 'signal')` e o painel mostra
"fluxo caiu (...); reconectando" com a lista de conversas vazia.

Por isso o plugin declara `connection` no `inject` e cria um Peer `owner` uma vez
(`peerDaPonte`, em `plugin/ponte.js`), passando-o a toda chamada. O Peer só
aborta quando o plugin é descartado. `ferramentas/conferir-peer.mjs` cobra esse
contrato e é etapa do `aceitar.mjs`.

## Fonte, instalador e o `Aplicar`

O add-on é publicado por um instalador de arquivo único em
`dsh-memory\manutencao\instalar-navegador.ps1`, com cada arquivo embutido em
base64 e sha256 congelado. Esse instalador **escreve a fonte em
`Documents\DSH\dsh-navegador`**, e é isso que o `Aplicar` do `sync-memoria.ps1`
roda em todo Pull (inclusive no do logon).

Consequência: editar a fonte e não recalcular o payload faz o próximo `Aplicar`
reverter a edição. Depois de mexer em qualquer arquivo deste projeto, recalcular
as tabelas do instalador e conferir que o payload decodifica byte a byte igual à
fonte. O instalador só reescreve o que tem sha256 diferente.