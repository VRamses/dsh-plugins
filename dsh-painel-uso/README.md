# dsh-painel-uso

Painel de uso e janela de contexto no composer do DSH Web, no lugar do anelzinho
nativo de contexto. Abre ao clicar no gatilho (anel + percentual) que fica na faixa
do composer, ao lado do seletor de modelo.

```
Janela de contexto                    ~234K / 1M (23%)
[=================|||=====]
  Sistema            ~42K
  Ferramentas        ~18K
  Conversa           ~174K
-----------------------------------------
Uso da sessao
  Input (sem cache)   12.480
  Cache lido         221.900
  Saida                3.412
  Total              237.792
  Acerto de cache        95%
-----------------------------------------
Sessao
  Turnos                   7
  Passos                  31
  Tempo de modelo      1m 26s
  Tempo de ferramentas   14s
  Velocidade          38 tok/s
-----------------------------------------
Credito DeepSeek
  Disponivel          US$ 4,08   (vermelho quando abaixo do limite)
  atualizado 16:17
-----------------------------------------
Motores em uso
  Gemini Lite            9/500   500 req/dia · 15 req/min · 1M
  auto         US$ 2,66/100      franquia Go: US$ 100,00/mes
  (a rota em uso fica em negrito; motor sem uso no dia nao aparece)
-----------------------------------------
  Rota     auto / auto
  Composicao heuristica do token meter, nao a conta do provedor.
```

## O que ele mostra, e de onde vem

Nada e inventado nem estimado no navegador: o plugin le quatro projecoes de sessao
que o host ja publica, mais a selecao de rota.

| Bloco | Projecao | Campos usados |
|---|---|---|
| Janela de contexto | `contextPressure` | `projectedTokens` (ou `pressureTokens`), `contextWindow` |
| Composicao | `contextBreakdown` | `systemTokens`, `toolsTokens`, `messageTokens` |
| Uso da sessao | `tokenUsage` | `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens` |
| Sessao | `sessionStats` | `turns`, `steps`, `llmMs`, `toolMs`, `ttftMs`, `ttftSteps`, `decodeMs`, `decodeTokens` |
| Rota | `modelSelection` | `provider`, `model`, `reasoningEffort` |
| Credito DeepSeek | rota `GET /painel-uso/saldo` | `total`, `moeda`, `abaixoDoAlerta` |
| Motores em uso | rota `GET /painel-uso/modelos` | `provedor`, `modelo`, `contexto`, `limite`, `usadoHoje`, `dia`, `minuto`, `tpm`, `usd` (o `auto`), `subagente`, e o resumo `subagentes` |

Convencoes de leitura:

- **Acerto de cache** = `cacheReadTokens / (cacheReadTokens + uncachedInputTokens)`.
  O que foi *escrito* no cache nao conta como acerto.
- **Total** = entrada sem cache + cache lido + cache escrito + saida.
- **Ocupacao** prefere `projectedTokens`, que ja desconta o efeito de uma
  compactacao; cai para `pressureTokens` quando o host nao publica o projetado.

## Limites de plano e creditos

O print que originou este plugin (Claude) tem dois blocos, e eles nao sao a mesma
coisa no DSH:

- **Limites de plano** (janela de 5 horas, semanal, com horario de reset): e um
  conceito de assinatura da Anthropic. O DSH fala com o provedor por chave de API e
  nao tem servico de cota, e nenhuma API de provedor expoe "quanto sobrou". O bloco
  que existe mostra uma **barra por motor**, cheia conforme as chamadas de hoje se
  aproximam do teto publicado (req/dia, req/min, TPM), sempre com o rotulo dizendo
  que a contagem e local e nao a cota da conta.
- **Creditos**: existem, mas a fonte nao e uma projecao de sessao: e a API do
  provedor. Quem entrega e a metade host deste pacote. O bloco so aparece quando a
  rota responde; enquanto isso ele nao reserva espaco, e quando falha ele diz
  `indisponivel` com o motivo, sem numero falso.

### A regra de exibicao (10/11/2026, a pedido do Ramses)

O painel responde a uma pergunta so: **o que eu gasto de motor**. Por isso cada
motor aparece do jeito que ele e cobrado, e nada mais:

- **Motor pago por credito** (DeepSeek, a chave que o Ramses recarrega) entra como
  **saldo**: uma linha `Disponivel US$ 4,08` e a hora da leitura. Nao tem barra,
  porque credito nao tem teto.
- **Todo o resto entra pelo limite**, na forma `usado/teto` com barra: os gratuitos
  contra o teto publicado (req/dia, req/min, TPM) e o `auto` contra a franquia do Go
  em US$ (`US$ 2,66/100`). O `auto` e um roteador, nao um modelo: a janela dele e o
  gasto do ciclo sobre o limite da assinatura.
- **So entra motor que foi usado hoje, ou o que esta selecionado agora.** Motor
  zerado no dia nao ocupa linha e volta sozinho na primeira chamada.
- O numero da direita e sempre `usado/limite`; o que sobra vai no texto de apoio.
  Foi o que corrigiu o `auto` sair como `2.65560835/100` e o `US$ 2,63` solto, que
  parecia saldo e nao dizia contra o que estava sendo medido.

### Como o bloco de creditos funciona

1. O navegador chama `GET /painel-uso/saldo` (mesma origem, cookie de sessao junto).
2. A metade host confere a autorizacao pelo servico `connection`
   (`requestRejection`): fence de Host/Origin mais o cookie assinado. Sem cookie a
   resposta e 401; sem o servico de conexao e 403, nunca dado aberto.
3. So entao ela le a credencial pelo servico `credentials` do DSH (que resolve, nesta
   ordem, ambiente, arquivo e `.env`), chama
   `GET https://api.deepseek.com/user/balance` e devolve apenas numeros.
4. A resposta fica em cache por `cacheSeconds` (padrao 300), com voo unico: varios
   paineis abertos nao geram varias chamadas.

A chave nunca chega ao navegador, e o endpoint oficial e instantaneo, ao contrario da
pagina de Usage da plataforma, que mostra so o recarregado e pode atrasar 5 minutos.

### Como o bloco de modelos funciona

1. O navegador chama `GET /painel-uso/modelos` (mesma origem, mesmo gate) quando o
   painel abre, e de novo a cada 30 s enquanto ele fica aberto.
2. A metade host pergunta as rotas configuradas ao servico `llm`
   (`listProviders()`) e, para cada rota que esteja na tabela `LIMITES`, le o
   catalogo (`listModels(rota)`) para pegar o contexto real.
3. A resposta so traz os modelos da tabela curada, das rotas que existem naquele
   ambiente: provedor sem chave nao aparece, e modelo fora da tabela nao entra.
4. Cada modelo leva `dia` e/ou `minuto` com `limite` e `usado`. O `usado` sai de um
   gancho em `llm/stream`, que ve toda chamada de modelo do processo (inclusive a de
   subagente), e e gravado em `painel-uso-contagem.json` no harness home, com poda
   de 7 dias. A barra enche na razao `usado / limite` da janela mais restrita.
5. O campo `subagente` diz se a rota esta liberada para subagente, lido do servico
   `subagentModelSelection` (o mesmo que o `tool-subagent` consulta). O resumo
   `subagentes` leva `habilitado` e `total`; quando o servico nao existe, os dois
   saem `null` e o consumidor mostra a lista inteira. Modelo liberado que nao esta
   na tabela curada entra na lista sem teto documentado.
6. Cache de 5 s para a lista; a contagem em si e lida sempre do estado vivo.
7. O filtro de "so o que eu uso" e do navegador, nao da rota: o host entrega a
   tabela inteira, porque a rota e publica para qualquer consumidor, e o
   `client.js` deixa passar so o motor com `usadoHoje > 0`, `usd.usado > 0` ou que
   seja a rota selecionada agora. `usadoHoje` e a contagem do dia que o host manda
   para todo motor, inclusive os que so tem teto por minuto (a NVIDIA e 40/min):
   sem esse campo, um modelo desses ficaria sempre com `dia: null` e nunca
   apareceria. A rota `auto` nao tem dia nem minuto: ela chega com
   `usd: { usado, limite }`, lido do `uso.json` do roteador, e a linha mostra
   `US$ usado/limite`. **Ela aparece com o nome `DeepSeek Go`**, porque o US$ e a
   franquia da assinatura, nao um teto do roteador: o `auto` tambem chama os motores
   gratuitos, e cada um deles tem o proprio teto na sua linha. Foi o pedido de
   10/11/2026 ("os limites devem ser separados"): somar tudo num balde de US$ 100
   sugeria que NVIDIA e Google gastavam dolar.
   **Medido no provedor em 10/11/2026**: o plano Go cobra a mesma franquia nos dois
   modelos dele (`glm-5.3-flash` com `billing_source: go` e `allowance: 0.00000245`;
   `deepseek-v4.1-flash` com `allowance: 0.00000315`). Por isso a linha do Go mostra o
   total e, embaixo, a fatia de cada modelo (`Go share: Flash Go 42% · GLM Go 58%`),
   lida do `porModelo` que o roteador passou a gravar no `uso.json`. A divisao comeca a
   contar no primeiro reinicio do roteador com essa versao: o gasto anterior nao tem
   como ser atribuido.
8. A manchete de cada motor usa a base que ele tem: franquia em US$ (o Go), depois o
   teto do dia; motor so com teto por minuto (a NVIDIA e 40/min) mostra o total de
   hoje e o teto do minuto fica na legenda. Antes a NVIDIA aparecia como `0/40` logo
   acima de `today 29`, o que parece motor parado.
9. Hora e dinheiro **nao** seguem o idioma da pagina, de proposito: a pagina e `en`,
   e o painel imprime `US$ 4,07` (dinheiro em `pt-BR`) e `18:30` (hora em 24h, com
   `hour12: false`), porque e assim que o Ramses le o painel ao lado do relogio do
   sistema (pedidos de 10/11/2026).

### O gatilho do rodape da lateral esquerda

O mesmo plugin ocupa dois slots: `conversation.input.right` (a faixa do composer) e
`sidebar.footer.action` (o rodape da lateral esquerda, onde ficava o badge do
`dsh-credit-widget`). O componente da lateral e outro (`UsoLateral`) porque aquele
slot **nao tem escopo de sessao**: ele mostra so os numeros globais (saldo e franquia
do Go) e, ao abrir, o credito mais a lista de motores com o teto de cada um.

Armadilhas medidas em 10/11/2026:

- o painel da lateral precisa ser `position:fixed` (abre acima do rodape). Com
  `absolute` dentro do slot ele saia cortado pela altura do container;
- o rodape encolhia o botao para 33 px e o texto sumia: a variante `.pu_lateral` fixa
  `min-width:74px`, `white-space:nowrap` e troca o trilho do anel para uma cor clara
  (o trilho escuro do composer fica invisivel sobre o fundo da lateral).

A tabela `LIMITES` fica em `index.js` e precisa ser atualizada quando o kit
`dsh-subagentes-gratis` mudar de modelo. Ela e a fonte unica. O badge do
`dsh-credit-widget` lia a mesma rota para desenhar barras na sidebar; ele foi
desligado em 10/11/2026 (um add-on so) e a rota continua servindo qualquer
consumidor que volte a existir.


## Instalacao

Repositorio: <https://github.com/VRamses/dsh-painel-uso> (**privado**; o pacote nao
carrega credencial nenhuma, o saldo sai da credencial local do DSH a cada consulta).

Atalho: em qualquer ambiente do Ramses, puxar o vault de memoria ja instala o plugin
(instalador de arquivo unico `manutencao\instalar-painel-uso.ps1`, chamado pelo
`Aplicar` do `sync-memoria.ps1`). O resto desta secao e o caminho manual.

O plugin vive fora do perfil e e ligado a ele por uma dependencia `file:`, que o pnpm
materializa como **hardlink**. Editar o arquivo "no lugar" mantem o vinculo, mas
editor (ou ferramenta) que *substitui* o arquivo quebra o link e a copia do perfil
fica velha. Para nao depender de como o arquivo foi salvo, rode o sincronizador
depois de editar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\sincronizar.ps1
```

Ele copia para um temporario, substitui o destino (com retry, porque o watcher de HMR
do cliente le os bundles e as vezes segura o arquivo por um instante) e imprime o
sha256 dos dois lados, marcando `ok` ou `DIVERGENTE`. Depois, Ctrl+Shift+R na pagina.

### Quando o DSH precisa ser reiniciado

O bundle de cliente e servido do disco, entao editar `client.js`, sincronizar e
recarregar a pagina ja basta. A metade host nao: `index.js` e importado uma unica vez,
no boot, e o `patchReload: live` do perfil nao reavalia o pacote. Portanto mudanca em
`index.js` **e a propria primeira instalacao** (que e o que cria a rota
`/painel-uso/saldo`) so passam a valer depois de **fechar e reabrir o DSH**. Ate la o
bloco de creditos mostra `indisponivel` com o motivo (HTTP 404), que e exatamente a
verdade: a rota ainda nao existe.


```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
$bin = "C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $bin plugin --profile web add "file:C:/Users/victo/Documents/DSH/dsh-painel-uso"
```

Depois disso e preciso **uma** linha no patch do perfil
(`%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`) para o Loader montar
o pacote. A linha precisa ficar **antes** da sentinela
`# MCPs hospedados no host central`, porque o `instalar-cliente.ps1` reescreve tudo
o que vem depois dela:

```yaml
- insert:
    - id: painel-uso
      name: 'dsh-painel-uso'
```

O perfil declara `patchReload: live`, entao essa linha entra sem reiniciar o DSH.
Um refresh na pagina (Ctrl+R) e suficiente para o navegador buscar o manifesto novo.

## Como conferir que entrou

```powershell
# 1. O pacote resolve e a metade host carrega?
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
$profile = "$env:DSH_HOME\profiles\web"
Set-Location $profile
node -e "import('dsh-painel-uso').then(m => console.log('apply:', typeof m.apply))"

# 2. A linha aparece na arvore composta?
node "C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile web --dump-config | Select-String -Pattern "painel-uso" -Context 0,2

# 3. O host serve mesmo o bundle para o navegador?
#    A pagina exige a sessao do app, e o token de launch sai do log do desktop.
#    O bundle vai numa URL combinada (/plugins/??...); basta procurar a minha.
$log = "$env:APPDATA\dsh-desktop\logs\harness.log"
$token = [regex]::Match((Select-String -Path $log -Pattern 'dsh web: http' | Select-Object -Last 1).Line,
  'token=([A-Za-z0-9_\-]+)').Groups[1].Value
$sessao = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$pagina = Invoke-WebRequest "http://127.0.0.1:43129/?token=$token" -WebSession $sessao -UseBasicParsing
$combo = [regex]::Match($pagina.Content, 'plugins/\?\?[^"]*dsh-painel-uso/client\.js[^"]*').Value -replace '&amp;', '&'
$bundle = Invoke-WebRequest ("http://127.0.0.1:43129/" + $combo) -WebSession $sessao -UseBasicParsing
"status: $($bundle.StatusCode)  bytes: $($bundle.Content.Length)  contem pu_panel: $($bundle.Content -match 'pu_panel')"
```

Se o gatilho nao aparecer, nesta ordem: (a) o painel so renderiza depois que o
provedor reporta uso e capacidade, ou seja, numa sessao que ja rodou ao menos uma
resposta; (b) confira a linha no patch; (c) recarregue com Ctrl+Shift+R.

## Remover

```powershell
# tire a linha do insert em cordis.patch.yml e depois:
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
$bin = "C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $bin plugin --profile web remove dsh-painel-uso
```

O anel nativo volta sozinho: ele nunca foi alterado, apenas escondido por uma regra
CSS que este plugin injeta.

## Detalhes que importam

- **Bundle escrito a mao, sem build.** O arquivo `client.js` e um script classico que
  registra uma factory CJS em `window.__ModuleLoader__.load({ id, factory })`, exatamente
  como `dsh-desktop-client-ui`. O host serve esse arquivo na rota
  `/plugins/dsh-painel-uso/client.js`. Nao ha passo de compilacao para esquecer.
- **O anel nativo e escondido por CSS**, com
  `[data-composer-card] button:has(svg circle[stroke-dasharray])`: o unico botao do card
  do composer que desenha um anel com `stroke-dasharray` e o `ContextMeter` do
  `ui-conversation`. Se o DSH mudar essa marca, a regra para de casar e os dois
  indicadores aparecem lado a lado, ou seja, degrada visivelmente em vez de quebrar.
  Meu gatilho nao usa `stroke-dasharray` justamente para nao esconder a si mesmo.
- **Slot**: `conversation.input.right` e um slot de *lista* (escopo de sessao), entao o
  registro leva `id` alem de `name`. O `useProjection` que o componente recebe e um
  keyed hook *builtin* que o `ui-session` publica para todo slot de escopo de sessao.
- **Locales**: o DSH embarca `zh` e `en`; o registro traz os dois dicionarios, como
  manda a convencao do projeto.
