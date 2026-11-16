/**
 * Colar texto: um texto grande colado no composer vira um chip, como o "PASTED"
 * do Claude, em vez de ocupar a caixa inteira. Depois de enviado, esse mesmo
 * texto tambem sai compacto do transcrito, com expandir/recolher.
 *
 * ## Como funciona (o que foi conferido no bundle do DSH)
 *
 * O composer do DSH e um editor Lexical proprio (`dsh-client-ui-conversation`),
 * e o DSH ja tem um tipo de no para "coisa que ocupa uma posicao no texto mas
 * nao e texto digitado": o `ReferenceChipNode`, usado nas mencoes de arquivo
 * (`@caminho`) e nos comandos (`/habilidade`).
 *
 * O detalhe que faz este add-on ser pequeno: o chip carrega DOIS campos
 * diferentes.
 *   `label`         e o que aparece na tela (curto);
 *   `clipboardText` e o que o chip contribui para o TEXTO do rascunho, e e esse
 *                   texto que vai no envio (`projection.clipboardText`).
 *
 * Entao basta inserir um chip cujo `clipboardText` seja o texto colado inteiro:
 * a caixa mostra uma etiqueta curta e o envio leva o texto completo, na posicao
 * do cursor. Nada e truncado e nada precisa ser substituido depois.
 *
 * ## Quem insere o chip
 *
 * O plugin NAO mexe no editor nem no bundle do DSH. Ele usa o mesmo caminho que
 * o menu de `/` e `@` usa, que e um evento de escopo de sessao:
 *
 *   actx.bail(actx, 'slash/input-insert-reference', { reference, span })
 *
 * `span` e o par (inicio, fim, `draftRev`) em coordenadas de "detect", e vem do
 * `captureInsertion()` do `inputActions` que o `uiSession` entrega de graca a
 * todo componente de escopo de sessao. O listener do outro lado e
 * `shell.insertReference`, que recusa quando `span.draftRev` nao bate com a
 * revisao viva do rascunho: por isso a leitura do span e a insercao acontecem
 * coladas, sem nada assincrono no meio.
 *
 * ## Por que nao usar `preventDefault` antes de tentar
 *
 * A ordem e: tenta inserir; so suprime o `paste` se a insercao devolveu `true`.
 * Se qualquer coisa faltar (sessao sem escopo, fase de envio travada, `/` sem o
 * listener), o handler nao faz nada e o DSH cola normalmente. O add-on degrada
 * para o comportamento de hoje, nunca para um paste engolido.
 *
 * A supressao usa `preventDefault` (cancela a acao padrao do navegador) mais
 * `stopPropagation` (impede o listener de `paste` do Lexical, que fica no
 * elemento raiz, na fase de bolha; este aqui esta em `document`, na captura, e
 * portanto roda antes).
 *
 * ## O texto ja enviado (transcrito)
 *
 * A mensagem enviada tem de levar o texto inteiro (o modelo precisa dele), mas
 * a bolha no transcrito ocupa a tela e obriga a rolar muito. A segunda parte do
 * plugin corta a altura da bolha do usuario e oferece expandir/recolher. O
 * texto continua INTEIRO no DOM: copiar, buscar na pagina e o contexto do modelo
 * nao mudam, so a altura visivel. O detalhe esta no comentario da regiao
 * `transcricao`.
 *
 * ## Limites
 *
 * Valem por navegador (localStorage), sem precisar recompilar nada:
 *   dsh-colar-texto:caracteres    minimo de caracteres (padrao 1500)
 *   dsh-colar-texto:linhas        minimo de linhas (padrao 25)
 *   dsh-colar-texto:transcricao   limite proprio do transcrito (padrao: o mesmo
 *                                 de `caracteres`); "off" desliga so esta parte
 *   dsh-colar-texto = "off"       desliga o add-on
 *   dsh-colar-texto:altura        altura visivel da bolha cortada (padrao
 *                                 "min(34vh, 240px)"; aceita qualquer medida CSS)
 *
 * Zero ou negativo desliga aquele criterio.
 *
 * ## Limitacao conhecida
 *
 * O rascunho persistido do DSH guarda so o TEXTO, nao os chips: sair da sessao
 * e voltar faz o texto voltar expandido na caixa (o conteudo continua intacto).
 * O envio e a copia (Ctrl+C) levam o texto completo nos dois casos.
 */
window.__ModuleLoader__.load({
  id: 'dsh-colar-texto',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    //#region limites
    /** Minimo de caracteres para recolher (padrao; ver localStorage). */
    const LIMITE_CARACTERES = 1500
    /** Minimo de linhas para recolher (padrao; ver localStorage). */
    const LIMITE_LINHAS = 25
    /** Valor de `dsh-colar-texto` que desliga o add-on. */
    const DESLIGADO = 'off'
    /** Marca do chip no DOM: `data-composer-chip="paste"`. */
    const FONTE = 'paste'
    /**
     * Mesma limpeza que o DSH aplica a qualquer texto externo que entra no
     * editor (`REFERENCE_PLACEHOLDER_RE` do ui-conversation): um U+FFFC literal
     * no texto forjaria uma posicao de chip na projecao de "detect", onde esse
     * caractere e a assinatura de um chip de verdade. Os dois intervalos sao a
     * codificacao interna do DSH e nao aparecem em texto de usuario.
     */
    const PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu

    /**
     * Remove os marcadores internos do texto colado.
     * @param texto - texto cru da area de transferencia.
     * @returns o texto que pode entrar no rascunho.
     */
    function limpar(texto) {
      return texto.replace(PLACEHOLDER_RE, '')
    }

    /**
     * Le um limite do localStorage, aceitando 0 para desligar o criterio.
     * @param chave - chave completa.
     * @param padrao - valor usado quando a chave esta ausente ou e invalida.
     * @returns o numero utilizavel.
     */
    function limiteDoNavegador(chave, padrao) {
      try {
        const cru = window.localStorage.getItem(chave)
        if (cru === null) return padrao
        const numero = Number.parseInt(cru, 10)
        return Number.isFinite(numero) ? Math.max(0, numero) : padrao
      } catch {
        return padrao
      }
    }

    /**
     * Configuracao viva do add-on.
     * @returns `{ caracteres, linhas, desligado }`.
     */
    function limites() {
      let desligado = false
      try {
        desligado = window.localStorage.getItem('dsh-colar-texto') === DESLIGADO
      } catch {
        desligado = false
      }
      return {
        desligado,
        caracteres: limiteDoNavegador('dsh-colar-texto:caracteres', LIMITE_CARACTERES),
        linhas: limiteDoNavegador('dsh-colar-texto:linhas', LIMITE_LINHAS)
      }
    }

    /**
     * Conta quebras de linha sem alocar um array do tamanho do texto (o caso
     * que motiva o add-on tem centenas de milhares de caracteres).
     * @param texto - texto colado.
     * @returns o numero de linhas (>= 1).
     */
    function contarLinhas(texto) {
      let linhas = 1
      for (let i = 0; i < texto.length; i += 1) if (texto.charCodeAt(i) === 10) linhas += 1
      return linhas
    }

    /**
     * Decide se o texto colado deve virar chip.
     * @param texto - texto colado.
     * @returns true quando passa de algum dos limites ligados.
     */
    function deveRecolher(texto) {
      const atual = limites()
      if (atual.desligado) return false
      if (atual.caracteres > 0 && texto.length >= atual.caracteres) return true
      return atual.linhas > 0 && contarLinhas(texto) >= atual.linhas
    }
    //#endregion

    //#region fonte do chip
    /**
     * Textos colados, por `ref` do chip.
     *
     * O envio NAO usa o `clipboardText` do chip como forma final. Quando o
     * rascunho tem chips, `sinkSerialized` pergunta a forma de modelo de cada um
     * a fonte dona (`inputTriggers.serializeReference(source, ref)`) e troca o
     * trecho do chip por esse texto. Sem uma fonte com `codec`, o envio inteiro
     * e recusado com `slash: no serializer for reference source "..."` (foi o
     * erro observado na primeira versao deste add-on).
     *
     * O serializador recebe so o `ref`, entao o texto mora aqui. Sao as mesmas
     * strings que os chips ja seguram: nao ha copia do conteudo.
     */
    const textos = new Map()
    /** Teto de entradas guardadas (higiene de memoria em sessao longa). */
    const TETO_TEXTOS = 40
    /**
     * Contador de `ref`. E do modulo, e nao do componente, de proposito: duas
     * sessoes vivas ao mesmo tempo precisam de refs distintos, porque o mapa e
     * um so.
     */
    let seqRef = 0

    /**
     * Guarda o texto de um chip, descartando o mais antigo quando estoura o teto.
     * @param ref - identificador do chip.
     * @param texto - texto colado.
     */
    function guardar(ref, texto) {
      textos.set(ref, texto)
      while (textos.size > TETO_TEXTOS) {
        const maisAntigo = textos.keys().next().value
        textos.delete(maisAntigo)
      }
    }

    /**
     * A fonte de chip `paste`, registrada em `ctx.inputTriggers`.
     *
     * O `trigger` e obrigatorio no registro de fonte, e o detector do DSH so
     * produz `/` ou `@`; `/` e o lado onde os chips moram. Nao ha nada para
     * escolher: `candidates` devolve vazio e `showGroupTitle: false` mantem o
     * menu de `/` exatamente como era.
     * @returns a fonte, pronta para `inputTriggers.registerSource`.
     */
    function fonteDoChip() {
      return {
        trigger: '/',
        name: FONTE,
        order: 90,
        showGroupTitle: false,
        async candidates() {
          return []
        },
        codec: {
          /** Forma de area de transferencia do chip (identidade: o texto colado). */
          clipboardText: (ref) => textos.get(ref) ?? ref,
          /**
           * Forma de modelo do chip, que e o que vai no prompt.
           * @param ref - identificador do chip.
           * @returns o texto colado inteiro.
           */
          serialize: (ref) => {
            const texto = textos.get(ref)
            if (texto === undefined) {
              // Nao acontece no fluxo normal: o chip e a entrada do mapa nascem
              // juntos, na mesma pagina. Se acontecer, o ref visivel denuncia o
              // defeito em vez de mandar um prompt vazio em silencio.
              console.warn('[dsh-colar-texto] sem texto guardado para o chip', ref)
              return Promise.resolve(ref)
            }
            return Promise.resolve(texto)
          }
        }
      }
    }
    //#endregion

    //#region dicionarios
    /** Namespace de copy deste plugin. Os locales embarcados no DSH sao zh e en. */
    const NS = 'colar-texto'

    const en = {
      'chip.label': 'Pasted text · {total} characters',
      'transcricao.expandir': 'Click to expand',
      'transcricao.recolher': 'Click to collapse'
    }

    const zh = {
      'chip.label': '粘贴的文本 · {total} 字符',
      'transcricao.expandir': '点击展开',
      'transcricao.recolher': '点击收起'
    }
    //#endregion

    //#region rotulo
    /**
     * Etiqueta do chip. Curta de proposito: ela fica no meio da linha de texto,
     * e o texto inteiro viaja no `clipboardText` do no.
     * @param t - tradução do namespace.
     * @param texto - texto colado.
     * @returns o rotulo pronto.
     */
    function rotulo(t, texto) {
      let total = String(texto.length)
      try {
        const idioma = (typeof document !== 'undefined' && document.documentElement.lang) || 'en'
        total = new Intl.NumberFormat(idioma).format(texto.length)
      } catch {
        /* fica o numero cru */
      }
      if (typeof t !== 'function') return 'Pasted text · ' + total
      return t('chip.label', { total })
    }
    //#endregion

    //#region transcricao
    /**
     * Compactacao do texto JA ENVIADO, na bolha do transcrito.
     *
     * O envio leva o texto inteiro (e tem de levar: o modelo precisa dele), mas
     * a bolha do usuario ocupa a tela toda e obriga a rolar muito para cima.
     * Esta parte corta a altura da bolha e oferece expandir/recolher.
     *
     * NAO existe ponto de composicao para isso: a bolha e renderizada pelo
     * `dsh-client-ui-chat` (`UserStyleBubble`), dentro de um no do transcrito
     * marcado com `data-chat-flow-kind`, e o renderer e um occupant de slot
     * CHAVEADO por tipo de no, sem fallback nem wrapper para plugins (o registro
     * de um `kind` repetido lanca erro). Entao o caminho aqui e o mesmo do
     * `dsh-painel-uso` para o anel de contexto: o plugin nao redesenha a bolha,
     * ele marca o elemento que ja existe e deixa o CSS cortar. O texto continua
     * INTEIRO no DOM (copiar, buscar na pagina e o contexto do modelo nao
     * mudam); so a altura visivel muda.
     *
     * Tres armadilhas resolvidas aqui:
     *  - a classe da bolha e um hash de CSS module (`Sixlwa_bubble`), que muda a
     *    cada build: por isso a bolha e achada por ESTRUTURA (o bloco mais
     *    interno que segura o texto), e nao por nome de classe;
     *  - se o React reescrevesse o `className` da bolha, a nossa classe sumiria.
     *    Ele nao reescreve: o valor e o mesmo em todo render, e o diff do React
     *    so toca no atributo quando o valor muda. Se o no for remontado (a
     *    lista pagina ao rolar), o MutationObserver marca de novo;
     *  - o texto pode estar em UM span so (mensagem sem mencoes), e `max-height`
     *    nao funciona em caixa inline: a descida para no primeiro filho que nao
     *    seja caixa de bloco.
     */
    /** Classe que marca a bolha administrada por este plugin. */
    const CLASSE_BOLHA = 'dct-bolha'
    /** Classe da bolha cortada. */
    const CLASSE_RECOLHIDA = 'dct-recolhida'
    /** Classe da bolha aberta por escolha do usuario. */
    const CLASSE_EXPANDIDA = 'dct-expandida'
    /** Altura visivel da bolha cortada (sobrescritivel por CSS). */
    const ALTURA_PADRAO = 'min(34vh, 240px)'
    /** Faixa do rodape, em px, onde o clique volta a recolher. */
    const FAIXA_RECOLHER = 40
    /** Nos do transcrito que carregam texto do usuario (durable e provisorios). */
    const NOS_DE_TEXTO =
      '[data-chat-flow-kind="user"],[data-chat-flow-kind="steering"],[data-chat-flow-kind="turn-trigger"],[data-submission-echo],[data-pending-steering]'
    /** Intervalo minimo entre varreduras (ms): o transcrito muta o tempo todo. */
    const ESPERA_VARREDURA = 250
    /** Chave da altura visivel no localStorage. */
    const CHAVE_ALTURA = 'dsh-colar-texto:altura'

    /**
     * CSS da compactacao. Sai uma vez por pagina, como no painel de uso.
     * @returns a folha inteira.
     */
    function css() {
      let altura = ALTURA_PADRAO
      try {
        const cru = window.localStorage.getItem(CHAVE_ALTURA)
        if (cru !== null && cru.trim() !== '') altura = cru.trim()
      } catch {
        /* fica o padrao */
      }
      return [
        '.dct-bolha{position:relative}',
        '.dct-recolhida{max-height:' + altura + ';overflow:hidden}',
        '.dct-recolhida:after{content:attr(data-dct-dica);position:absolute;inset:auto 0 0 0;padding:30px 8px 6px;text-align:center;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);background:linear-gradient(to bottom,transparent,var(--dsw-specific-bubble,var(--dsw-alias-bg-base)) 62%);pointer-events:none}',
        '.dct-expandida:hover:after{content:attr(data-dct-dica-recolher);position:absolute;inset:auto 0 0 0;padding:20px 8px 4px;text-align:center;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);background:linear-gradient(to bottom,transparent,var(--dsw-specific-bubble,var(--dsw-alias-bg-base)) 62%);pointer-events:none}'
      ].join('')
    }

    /** Marca do CSS no DOM (uma tag por pagina). */
    const CSS_TAG = 'dsh-colar-texto/transcricao.css'
    /** Nos ja decididos: mensagem do usuario nao muda depois de renderizada. */
    const nosDecididos = new WeakSet()
    /** Bolhas ja marcadas (evita reescrever atributos a cada varredura). */
    const bolhasMarcadas = new WeakSet()

    /**
     * Limite de caracteres da compactacao no transcrito. Sem chave propria, usa
     * o mesmo limite da colagem: se recolheu na caixa, recolhe no transcrito.
     * @returns o minimo de caracteres (0 desliga esta parte).
     */
    function limiteTranscricao() {
      try {
        const cru = window.localStorage.getItem('dsh-colar-texto:transcricao')
        if (cru === 'off') return 0
        if (cru !== null) {
          const numero = Number.parseInt(cru, 10)
          if (Number.isFinite(numero)) return Math.max(0, numero)
        }
      } catch {
        /* cai no limite geral */
      }
      return limites().caracteres
    }

    /**
     * Acha a bolha que segura o texto dentro de um no do transcrito: o BLOCO mais
     * interno cujo texto passa do limite.
     *
     * A busca desce por qualquer elemento, inclusive os de `display: contents`, e
     * so depois escolhe quem da para cortar: `max-height` nao funciona em caixa
     * inline nem em `contents`. Isso nao e detalhe de estilo: TODO outlet de slot
     * do DSH e um `<div data-slot="..." style="display:contents">`
     * (`dsh-client-ui-renderer`, constante `ANCHOR_STYLE`), e ele fica justamente
     * entre o no do transcrito e a bolha. Uma descida que pulasse `contents`
     * parava no outlet e nao marcava nada. Foi o defeito da primeira versao.
     *
     * A faixa de anexos fica de fora (ela tem marcador proprio) para a imagem ou
     * o cartao de arquivo nao serem cortados junto.
     * @param nodo - no do transcrito.
     * @param limite - minimo de caracteres.
     * @returns a bolha, ou null quando nao ha texto grande ali.
     */
    function acharBolha(nodo, limite) {
      const blocos = []
      const fila = [nodo]
      while (fila.length > 0) {
        const atual = fila.shift()
        for (const filho of atual.children) {
          if (filho.closest('[data-message-attachments]') !== null) continue
          if ((filho.textContent ?? '').length < limite) continue
          const estilo = window.getComputedStyle(filho)
          if (estilo.display !== 'inline' && estilo.display !== 'contents') blocos.push(filho)
          fila.push(filho)
        }
      }
      // A fila entrega pai antes de filho, entao o mais interno esta no fim.
      for (let i = blocos.length - 1; i >= 0; i -= 1) {
        let temDentro = false
        for (const outro of blocos) {
          if (outro !== blocos[i] && blocos[i].contains(outro)) {
            temDentro = true
            break
          }
        }
        if (!temDentro) return blocos[i]
      }
      return null
    }

    /**
     * Marca a bolha como cortavel e deixa as dicas no proprio elemento (o CSS
     * as publica com `content: attr(...)`, sem criar no nenhum no DOM do React).
     * @param bolha - elemento da bolha.
     * @param t - traducao do namespace.
     */
    function marcarBolha(bolha, t) {
      if (bolhasMarcadas.has(bolha)) return
      bolhasMarcadas.add(bolha)
      bolha.classList.add(CLASSE_BOLHA, CLASSE_RECOLHIDA)
      try {
        bolha.setAttribute('data-dct-dica', t('transcricao.expandir'))
        bolha.setAttribute('data-dct-dica-recolher', t('transcricao.recolher'))
      } catch {
        bolha.setAttribute('data-dct-dica', 'expandir')
        bolha.setAttribute('data-dct-dica-recolher', 'recolher')
      }
    }

    /**
     * Uma passada pelo transcrito: marca toda bolha de usuario grande que ainda
     * nao foi decidida.
     * @param t - traducao do namespace.
     */
    function varrerTranscricao(t) {
      const limite = limiteTranscricao()
      if (limite <= 0 || typeof document === 'undefined') return
      for (const nodo of document.querySelectorAll(NOS_DE_TEXTO)) {
        if (nosDecididos.has(nodo)) continue
        nosDecididos.add(nodo)
        const bolha = acharBolha(nodo, limite)
        if (bolha !== null) marcarBolha(bolha, t)
      }
    }

    /**
     * Instala a compactacao do transcrito: CSS, varredura inicial, varredura
     * agendada nas mutacoes da lista e o clique que expande/recolhe.
     * @param ctx - contexto raiz do cliente (dono do `locale`).
     */
    function instalarTranscricao(ctx) {
      const t = ctx.locale.bind(NS)

      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-colar-texto'
        tag.dataset.pluginCss = CSS_TAG
        tag.textContent = css()
        document.head.appendChild(tag)
      }

      let agendado
      /**
       * Pede uma varredura, no maximo uma por intervalo: o transcrito muda a
       * cada token do assistente.
       */
      const agendar = () => {
        if (agendado !== undefined) return
        agendado = window.setTimeout(() => {
          agendado = undefined
          try {
            varrerTranscricao(t)
          } catch (erro) {
            console.error('[dsh-colar-texto] varredura do transcrito falhou:', erro)
          }
        }, ESPERA_VARREDURA)
      }

      try {
        varrerTranscricao(t)
      } catch (erro) {
        console.error('[dsh-colar-texto] varredura inicial falhou:', erro)
      }

      // O script dos modulos do DSH e injetado no <head>, antes do <body>, e o
      // transcrito so e desenhado bem depois da montagem: por isso o observer vai
      // no `documentElement` (que existe desde o primeiro instante) e a varredura
      // ainda e repetida quando a primeira tela sai, para nao depender de uma
      // mutacao acontecer.
      const raiz = document.documentElement
      if (typeof MutationObserver === 'function' && raiz !== null && raiz !== undefined) {
        new MutationObserver(agendar).observe(raiz, { childList: true, subtree: true })
      }
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(agendar)
      window.setTimeout(agendar, 600)

      ctx.effect(() => () => {
        if (agendado !== undefined) window.clearTimeout(agendado)
        agendado = undefined
      }, 'dsh-colar-texto: fim da varredura')

      document.addEventListener('click', (evento) => {
        try {
          const alvo = evento.target instanceof Element ? evento.target.closest('.' + CLASSE_BOLHA) : null
          if (alvo === null) return
          if (alvo.classList.contains(CLASSE_RECOLHIDA)) {
            alvo.classList.remove(CLASSE_RECOLHIDA)
            alvo.classList.add(CLASSE_EXPANDIDA)
            return
          }
          // Aberta: recolhe so pelo rodape, para o clique de selecao de texto no
          // meio da mensagem nao fechar o que o usuario acabou de abrir.
          const caixa = alvo.getBoundingClientRect()
          if (caixa.bottom - evento.clientY > FAIXA_RECOLHER) return
          alvo.classList.remove(CLASSE_EXPANDIDA)
          alvo.classList.add(CLASSE_RECOLHIDA)
        } catch (erro) {
          console.error('[dsh-colar-texto] falha ao alternar a bolha:', erro)
        }
      })
    }
    //#endregion

    //#region componente
    /** Contexto raiz do cliente, guardado para resolver o escopo da sessao. */
    let RAIZ

    /**
     * Occupant invisivel de `conversation.input.overlay` (escopo de sessao): ele
     * nao desenha nada e existe so para ter um lugar de onde instalar o listener
     * de `paste` com o `sessionId` e o `inputActions` da sessao viva.
     * @param props - kit padrao do slot de sessao.
     * @returns null.
     */
    function ColarTexto(props) {
      const sessionId = props.sessionId
      const acoes = props.inputActions
      const t = props.t

      React.useEffect(() => {
        if (sessionId === undefined || acoes === undefined || typeof acoes.captureInsertion !== 'function') return undefined

        /**
         * Handler de `paste` na fase de captura, no documento inteiro: o
         * composer e um `contenteditable` dentro de `[data-composer-card]`, e a
         * captura em `document` e o unico ponto que roda antes do listener do
         * Lexical.
         * @param evento - evento de colagem.
         */
        const aoColar = (evento) => {
          try {
            const alvo = evento.target
            if (!(alvo instanceof Element) || alvo.closest('[data-composer-card]') === null) return

            const dados = evento.clipboardData
            if (dados === null || dados === undefined) return

            // Colagem de arquivo/imagem: quem trata e o caminho de anexo do DSH.
            for (const item of dados.items) if (item.kind === 'file') return

            const cru = dados.getData('text/plain')
            if (typeof cru !== 'string' || cru === '') return
            const texto = limpar(cru)
            if (texto === '' || !deveRecolher(texto)) return

            const sessions = typeof RAIZ?.get === 'function' ? RAIZ.get('sessions') : undefined
            const actx = sessions?.scope?.(sessionId)
            if (actx === undefined || actx === null) return

            seqRef += 1
            const ref = 'paste:' + seqRef
            guardar(ref, texto)

            const inserido =
              actx.bail(actx, 'slash/input-insert-reference', {
                reference: {
                  source: FONTE,
                  ref,
                  label: rotulo(t, texto),
                  appearance: 'session',
                  clipboardText: texto
                },
                span: acoes.captureInsertion()
              }) === true

            if (!inserido) return
            evento.preventDefault()
            evento.stopPropagation()
          } catch (erro) {
            // Nunca derruba a colagem por causa do add-on: sem supressao, o DSH
            // cola do jeito de sempre.
            console.error('[dsh-colar-texto] falha ao recolher o texto colado:', erro)
          }
        }

        document.addEventListener('paste', aoColar, true)
        return () => {
          document.removeEventListener('paste', aoColar, true)
        }
      }, [sessionId, acoes, t])

      return null
    }
    //#endregion

    //#region plugin
    /**
     * `slots` registra o occupant; `locale` publica os dicionarios; `sessions` da
     * o escopo da sessao; `inputTriggers` e onde a fonte do chip (e o codec que
     * o envio usa) e registrada.
     */
    const inject = ['slots', 'locale', 'sessions', 'inputTriggers']

    /**
     * Corpo do plugin de cliente.
     * @param ctx - contexto raiz do cliente.
     */
    function apply(ctx) {
      RAIZ = ctx

      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en
          }),
        'dsh-colar-texto: dicionarios'
      )

      // O codec do chip. Sem esta fonte o envio de qualquer rascunho com chip e
      // recusado: `sinkSerialized` procura a forma de modelo pela fonte dona.
      ctx.effect(() => ctx.get('inputTriggers').registerSource(fonteDoChip()), 'dsh-colar-texto: fonte do chip')

      // O texto ja enviado tambem sai compacto do transcrito.
      instalarTranscricao(ctx)

      // O slot e declarado pela propria ui-conversation; `inject` espera a
      // declaracao existir para nao depender da ordem de carga dos plugins.
      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'colar-texto',
            order: 50,
            locale: NS,
            registrant: 'dsh-colar-texto'
          },
          ColarTexto
        )
      )
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
