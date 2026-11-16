/**
 * Painel de uso: o occupant do slot `conversation.input.right` que substitui o
 * anel nativo de contexto por um painel completo.
 *
 * Dados: quatro projeções de sessão que o host já publica no navegador.
 *   contextPressure  { pressureTokens?, projectedTokens?, contextWindow? }
 *   contextBreakdown { systemTokens, toolsTokens, messageTokens }
 *   tokenUsage       { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 *   sessionStats     { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
 *   modelSelection   { lastUsed, next } com { provider, model, reasoningEffort? }
 *
 * O bundle e escrito a mao no formato que `dsh-client-modules` espera: um script
 * classico que registra uma factory CJS em `window.__ModuleLoader__`, sem passo de
 * build. Editar este arquivo e recarregar a pagina basta (o host serve o arquivo
 * do pacote na rota /plugins/<id>/client.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-painel-uso',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    //#region estilos
    const CSS = [
      // Gatilho: anel de progresso em conic-gradient + percentual. Nao usa
      // `svg circle[stroke-dasharray]`, que e a assinatura do anel nativo que a
      // regra de ocultacao mais abaixo procura.
      '.pu_root{display:inline-flex;position:relative}',
      '.pu_trigger{corner-shape:round;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;align-items:center;gap:5px;padding:0 8px 0 6px;font-size:12px;font-variant-numeric:tabular-nums;display:inline-flex}',
      '.pu_trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pu_trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.pu_alertaSaldo{width:6px;height:6px;border-radius:999px;flex:none;background:var(--dsw-alias-state-error-primary)}',
      '.pu_ring{width:14px;height:14px;border-radius:999px;flex:none;background:conic-gradient(var(--dsw-alias-label-tertiary) var(--pu-pct,0%),var(--dsw-alias-border-l3) 0);-webkit-mask:radial-gradient(circle,transparent 0 4px,#000 4.5px);mask:radial-gradient(circle,transparent 0 4px,#000 4.5px)}',
      // Painel: mesmas convencoes do painel nativo do ContextMeter. O fundo e
      // opaco de proposito: `--dsw-specific-menu` e translucido e, sobre a lateral,
      // deixava os nomes das sessoes atravessarem o texto do painel (visto em
      // 10/11/2026). `bg-layer-2` e o mesmo tom, sem alpha.
      '.pu_panel{z-index:100;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,var(--dsw-specific-menu));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:302px;max-height:min(72vh,600px);overflow-y:auto;box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:12px;font-size:12px;line-height:18px;position:absolute;bottom:calc(100% + 8px);right:0}',
      '.pu_head{align-items:center;gap:8px;display:flex}',
      '.pu_title{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.pu_figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}',
      '.pu_bar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0;display:flex;overflow:hidden}',
      '.pu_segment{background:var(--pu-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}',
    // Barra compacta da lateral: mesma ideia da do painel, sem a margem alta,
    // porque na lateral sao tres linhas seguidas (5 horas, semana, mes).
    '.pu_frac{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:5px;margin:4px 0 2px;display:flex;overflow:hidden}',
      '.pu_tintSystem{--pu-tint:var(--dsw-static-neutral-bluish-400)}',
      '.pu_tintTools{--pu-tint:#a78bfa}',
      '.pu_tintMessages{--pu-tint:var(--dsw-static-blue-450)}',
      '.pu_rows{margin:0}',
      '.pu_row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}',
      '.pu_row dt{color:var(--dsw-alias-label-secondary);min-width:0}',
      '.pu_row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0}',
      '.pu_swatch{background:var(--pu-tint);vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}',
      '.pu_rule{border-top:.5px solid var(--dsw-alias-border-l1);margin:10px 0}',
      '.pu_section{color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:2px}',
      '.pu_note{color:var(--dsw-alias-label-tertiary)}',
      '.pu_route{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '.pu_atual{color:var(--dsw-alias-label-primary);font-weight:600}',
      // Barra por modelo: cheia conforme as chamadas de hoje se aproximam do
      // teto publicado. Verde/azul ate 60%, ambar ate 85%, vermelho acima.
      '.pu_model{margin:6px 0 8px}',
      '.pu_mtop{align-items:baseline;gap:8px;display:flex;justify-content:space-between}',
      '.pu_mnome{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.pu_mnome.pu_atual{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.pu_mnum{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);flex:none}',
      '.pu_mbar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:5px;margin:5px 0 3px;overflow:hidden}',
      '.pu_mfill{background:var(--dsw-static-blue-450);border-radius:999px;height:100%;min-width:0}',
      '.pu_mfill[data-nivel=alerta]{background:#d97706}',
      '.pu_mfill[data-nivel=critico]{background:var(--dsw-alias-state-error-primary)}',
      '.pu_msub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow-wrap:anywhere}',
      '.pu_valAlerta{color:var(--dsw-alias-state-error-primary)}',
      '.pu_sub{color:var(--dsw-alias-label-tertiary)}',
      // Ocultacao do anel nativo, condicionada a bandeira `data-painel-uso` que o
      // componente liga SO enquanto o gatilho esta de fato na tela: sem isso, uma
      // falha do plugin esconderia o indicador nativo sem colocar nada no lugar.
      // A marca procurada e o unico botao do card do composer que desenha um anel
      // com stroke-dasharray, ou seja, o ContextMeter do ui-conversation. Se o DSH
      // mudar essa marca, a regra para de casar e os dois indicadores convivem
      // (degradacao visivel, nunca quebra). O meu gatilho nao usa stroke-dasharray
      // justamente para nao esconder a si mesmo.
      'html[data-painel-uso] [data-composer-card] button:has(svg circle[stroke-dasharray]){display:none!important}',
      // Variante do rodape da sidebar: o gatilho fica colado na borda esquerda e o
      // rodape costuma ser um container baixo, entao o painel e `fixed` acima dele.
      // `absolute` dentro do slot saia cortado pela altura do rodape.
      '.pu_lateral .pu_panel{position:fixed;left:8px;right:auto;bottom:46px;top:auto}',
      // O rodape da sidebar encolhia o botao para 33 px e o texto sumia. Largura
      // minima, texto sem quebra e anel com trilho claro (no ring do composer o
      // trilho e escuro, o que fica invisivel sobre o fundo da lateral).
      '.pu_lateral .pu_trigger{gap:5px;padding:0 8px 0 5px;min-width:74px;white-space:nowrap;justify-content:flex-start}',
      '.pu_lateral .pu_ring{background:conic-gradient(var(--dsw-static-blue-450) var(--pu-pct,0%),var(--dsw-alias-border-l2) 0)}',
      // Aviso de cota: ocupa o lugar do Toast generico do DSH na cadeia
      // `shell.quota-notice`. Fundo opaco e `fixed` porque o host do overlay nao
      // posiciona o filho, e o texto do aviso e o unico que o Ramses le quando o
      // turno falha por cota.
      '.pu_aviso{position:fixed;right:16px;bottom:16px;z-index:1200;box-sizing:border-box;width:min(360px,calc(100vw - 32px));background:var(--dsw-alias-bg-layer-2,var(--dsw-specific-menu));color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px;font-size:12px;line-height:18px;box-shadow:var(--dsw-elevation-prominent)}',
      '.pu_avisoTitulo{color:var(--dsw-alias-label-primary);font-weight:600;margin-bottom:6px}',
      '.pu_avisoLinha{margin-bottom:4px;overflow-wrap:anywhere}',
      '.pu_avisoNota{color:var(--dsw-alias-label-tertiary);margin-bottom:8px;overflow-wrap:anywhere}',
      '.pu_avisoAcoes{display:flex;justify-content:flex-end}',
      '.pu_avisoBotao{corner-shape:round;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:none;border-radius:999px;padding:3px 12px}',
      '.pu_avisoBotao:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pu_avisoBotao:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}'
    ].join('')

    const CSS_TAG = 'dsh-painel-uso/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-painel-uso'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

    //#region dicionarios
    /** Namespace de copy deste plugin. Os locales embarcados no DSH sao zh e en. */
    const NS = 'painel-uso'

    const en = {
      'aria.open': 'Session usage panel, {percent} of the context window used',
      'title.context': 'Context window',
      'title.usage': 'Session usage',
      'title.session': 'Session',
      'row.system': 'System',
      'row.tools': 'Tools',
      'row.messages': 'Conversation',
      'row.input': 'Input (uncached)',
      'row.cacheRead': 'Cache read',
      'row.cacheWrite': 'Cache write',
      'row.output': 'Output',
      'row.total': 'Total',
      'row.cacheHit': 'Cache hit rate',
      'row.turns': 'Turns',
      'row.steps': 'Steps',
      'row.modelTime': 'Model time',
      'row.toolTime': 'Tool time',
      'row.decodeSpeed': 'Decode speed',
      'row.firstToken': 'First token',
      'row.route': 'Route',
      'unit.tokensPerSecond': '{value} tok/s',
      'note.heuristic': 'Composition is a token meter heuristic, not provider billing.',
      'title.credit': 'DeepSeek credit',
      'row.creditTotal': 'Available',
      'credit.at': 'updated {time}',
      'credit.failed': 'unavailable',
      'credit.reason': 'reason: {reason}',
      'credit.below': 'below {amount}',
      'title.models': 'Engines in use',
      'model.limitDay': '{limit}/day',
      'model.limitMinute': '{limit}/min',
      'model.tpm': '{limit} TPM',
      'model.context': '{value} context',
      'model.usd': 'Go allowance: {limit}/month',
      'model.split': 'Go share: {list}',
      'model.today': 'today {used}',
      'trigger.saldoBaixo': 'DeepSeek balance {total}, below the alert line',
      'note.models': 'Only the engines used today, each against its own cap. DeepSeek Go is the subscription allowance in US$; the free engines have their own daily or per-minute limits; the DeepSeek credit above is the pay-per-token balance.'
    }

    const zh = {
      'aria.open': '会话用量面板，上下文窗口已用 {percent}',
      'title.context': '上下文窗口',
      'title.usage': '会话用量',
      'title.session': '会话',
      'row.system': '系统提示',
      'row.tools': '工具',
      'row.messages': '对话',
      'row.input': '输入（未缓存）',
      'row.cacheRead': '缓存读取',
      'row.cacheWrite': '缓存写入',
      'row.output': '输出',
      'row.total': '合计',
      'row.cacheHit': '缓存命中率',
      'row.turns': '轮次',
      'row.steps': '步骤',
      'row.modelTime': '模型耗时',
      'row.toolTime': '工具耗时',
      'row.decodeSpeed': '解码速度',
      'row.firstToken': '首字延迟',
      'row.route': '路由',
      'unit.tokensPerSecond': '{value} tok/s',
      'note.heuristic': '组成为 token meter 的启发式估算，不等于提供方账单。',
      'title.credit': 'DeepSeek 余额',
      'row.creditTotal': '可用',
      'credit.at': '更新于 {time}',
      'credit.failed': '不可用',
      'credit.reason': '原因：{reason}',
      'credit.below': '低于 {amount}',
      'title.models': '在用引擎',
      'model.limitDay': '{limit}/日',
      'model.limitMinute': '{limit}/分钟',
      'model.tpm': '{limit} TPM',
      'model.context': '{value} 上下文',
      'model.usd': 'Go 额度：{limit}/月',
      'model.split': 'Go 占比：{list}',
      'model.today': '今日 {used}',
      'trigger.saldoBaixo': 'DeepSeek 余额 US$ {total}，低于预警线',
      'note.models': '只列出今日使用的引擎，每个引擎按自己的额度。DeepSeek Go 是 US$ 订阅额度；免费引擎有自己的每日或每分钟限额；上方的 DeepSeek 余额是按 token 付费的账户。'
    }
    //#endregion

    //#region formatacao
    /** Contagem compacta: 871, 12.5K, 1M. Igual ao painel nativo. */
    function compact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
      if (value < 1e3) return String(Math.round(value))
      if (value < 1e6) return scaled(value / 1e3) + 'K'
      return scaled(value / 1e6) + 'M'
    }

    /**
     * Saldo em dolar da resposta de `/painel-uso/saldo`.
     *
     * O numero NAO esta em `dados.total`: a rota devolve `moedas[]`, uma por moeda
     * (`{moeda, total, concedido, recarregado}`). Ler `dados.total` dava `NaN`, e a
     * lateral mostrava "US$ ?" (medido em 10/11/2026). Devolve `null` quando nao ha
     * moeda nem numero valido, para o consumidor escolher entre vazio e "—".
     * @param dados - corpo de `/painel-uso/saldo`.
     * @returns o total em USD, ou o da primeira moeda; `null` se nao der para ler.
     */
    function saldoUsd(dados) {
      if (dados === null || dados === undefined) return null
      const lista = Array.isArray(dados.moedas) ? dados.moedas : []
      const moeda = lista.find((item) => item?.moeda === 'USD') ?? lista[0] ?? null
      const numero = moeda === null ? Number(dados.total) : Number(moeda.total)
      return Number.isFinite(numero) ? numero : null
    }

    /** Contagem exata com o separador de milhar do idioma ativo da pagina. */
    function exact(value) {
      const rounded = Math.round(value)
      try {
        return new Intl.NumberFormat((typeof document !== 'undefined' && document.documentElement.lang) || 'en').format(rounded)
      } catch {
        return String(rounded)
      }
    }

    /** Duracao legivel: 41s, 1m 26s, 2h 3m. */
    function duration(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return hours + 'h ' + minutes + 'm'
      if (minutes > 0) return minutes + 'm ' + seconds + 's'
      return seconds + 's'
    }

    /**
     * Idioma do dinheiro. O app roda em ingles (`<html lang="en">`), e nesse
     * locale o Intl imprime "$4.07"; o Ramses le em dolar do jeito brasileiro,
     * "US$ 4,07" (pedido de 10/11/2026). Fica fixo aqui de proposito: e o unico
     * numero do painel que nao segue o idioma da pagina.
     */
    const IDIOMA_MOEDA = 'pt-BR'

    /**
     * Valor monetario no formato de `IDIOMA_MOEDA`.
     * @param valor - numero devolvido pela API.
     * @param moeda - codigo ISO da moeda (USD).
     * @returns o texto formatado.
     */
    function dinheiro(valor, moeda) {
      if (typeof valor !== 'number' || !Number.isFinite(valor)) return '?'
      try {
        return new Intl.NumberFormat(IDIOMA_MOEDA, { style: 'currency', currency: moeda }).format(valor)
      } catch {
        return valor.toFixed(2) + ' ' + moeda
      }
    }

    /**
     * Hora local curta de um instante ISO, em 24 horas.
     * @param iso - carimbo devolvido pela rota.
     * @returns HH:MM, ou `?` quando o carimbo nao presta.
     *
     * 24h fixo (pedido de 10/11/2026): com o idioma da pagina (`en`) o Intl imprimia
     * `06:07 PM`, e o painel fica ao lado do relogio da barra do sistema, que e 24h.
     * `hour12: false` e o que garante o formato mesmo com locale ingles.
     */
    function hora(iso) {
      const data = new Date(iso)
      if (Number.isNaN(data.getTime())) return '?'
      return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    /** Ocupacao da janela: so existe quando ha numerador e capacidade. */
    function contextOccupancy(pressure) {
      const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
      if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
      return {
        percent: Math.min(100, Math.round((usedTokens / pressure.contextWindow) * 100)),
        usedTokens,
        contextWindow: pressure.contextWindow
      }
    }

    /**
     * Apelidos curtos dos motores, os mesmos do badge da sidebar: o painel e o
     * widget antigo falavam linguas diferentes para o mesmo modelo ("Gemini
     * Lite" de um lado, "google / gemini-3.1-flash-lite" do outro).
     */
    const APELIDOS = {
      'z-ai/glm-5.3-flash': 'GLM',
      'glm-5.3-flash': 'GLM Go',
      'deepseek-v4.1-flash': 'Flash Go',
      'gemini-3.1-flash-lite': 'Gemini Lite',
      'openrouter/free': 'OR free',
      'cohere/north-mini-code:free': 'Cohere'
    }

    /**
     * Nome curto de um motor na lista.
     * @param provedor - rota do modelo.
     * @param modelo - id do modelo na rota.
     * @returns o apelido; sem apelido, o fim do id.
     */
    function apelido(provedor, modelo) {
      // O `auto` nao e um motor: e o roteador que gasta a franquia do Go e cai nos
      // gratuitos quando o Go nao responde. Chamar a linha de "DeepSeek Go" diz de
      // qual bolso sai o dolar; a rota aparece no rodape do painel.
      if (provedor === 'auto') return 'DeepSeek Go'
      const curto = APELIDOS[modelo]
      if (curto !== undefined) return curto
      const fim = String(modelo).split('/').pop().replace(/:free$/, '')
      return fim.length > 14 ? fim.slice(0, 13) + '…' : fim
    }
    //#endregion

    //#region situacao do plano Go
    /**
     * Janelas da franquia do Go, na ordem em que importam para o texto do aviso:
     * a semanal e a que corta o trabalho, a de 5 horas so trava rajada e a mensal
     * vira por ultimo.
     */
    const JANELAS_GO = [
      ['weekly', 'semanal'],
      ['rolling', 'de 5 horas'],
      ['monthly', 'mensal']
    ]

    /**
     * O que o painel sabe e o que ele nao sabe, no texto do aviso de esgotamento.
     *
     * O painel le a franquia pela API do provedor (`/painel-uso/franquia`), entao
     * ele prova QUAL franquia acabou. Ele nao le o log do roteador `auto`, entao
     * ele NAO prova qual via atendeu cada pedido. Dizer isso no aviso e o ponto:
     * a frase anterior ("cota de solicitacao esgotada") escondia as duas coisas.
     */
    const NOTA_SEM_VIA =
      'O painel lê a franquia do plano, não o log do roteador: qual via do `auto` atendeu cada pedido não aparece aqui.'

    /**
     * Data e hora curtas de um carimbo ISO, em 24 horas (dd/mm HH:MM).
     * @param iso - carimbo devolvido pelo roteador.
     * @returns o texto, ou `null` quando o carimbo nao presta.
     */
    function quandoCurto(iso) {
      if (typeof iso !== 'string') return null
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return null
      const dois = (n) => String(n).padStart(2, '0')
      return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + ' ' + dois(d.getHours()) + ':' + dois(d.getMinutes())
    }

    /**
     * Janela do Go que esta no teto, segundo a leitura do provedor.
     *
     * O provedor marca a janela estourada com `status: "rate-limited"` e
     * `percent: 100` (medido em 12/11/2026 na `/franquia` do roteador). Qualquer
     * uma das duas marcas serve: `percent` sem `status` ja e motivo suficiente,
     * e `status` de limite sem `percent` numerico tambem.
     * @param dados - corpo de `/painel-uso/franquia`.
     * @returns `{ chave, rotulo, percent, status, resetsAt }` da primeira janela
     * no teto, ou `null` quando nenhuma esta.
     */
    function janelaGoEsgotada(dados) {
      const janelas = dados !== null && typeof dados === 'object' ? dados.janelas ?? {} : {}
      for (const [chave, rotulo] of JANELAS_GO) {
        const janela = janelas[chave]
        if (janela === null || typeof janela !== 'object') continue
        const percent = Number(janela.percent)
        const status = typeof janela.status === 'string' ? janela.status : null
        const noTeto = (Number.isFinite(percent) && percent >= 100) || (status !== null && /limit|rate/i.test(status))
        if (!noTeto) continue
        return {
          chave,
          rotulo,
          percent: Number.isFinite(percent) ? percent : null,
          status,
          resetsAt: typeof janela.resetsAt === 'string' ? janela.resetsAt : null
        }
      }
      return null
    }

    /**
     * As duas linhas do aviso de plano Go esgotado, em pt-BR.
     *
     * A primeira diz QUAL franquia acabou e quando ela vira. A segunda separa o
     * plano Go da conta DeepSeek, que e o que o texto antigo misturava. Nenhuma
     * das duas afirma fallback confirmado, porque o painel nao tem esse dado.
     * @param alvo - resultado de {@link janelaGoEsgotada}.
     * @returns `[principal, contexto]`.
     */
    function textoGoEsgotado(alvo) {
      const quando = quandoCurto(alvo.resetsAt)
      const principal =
        'Plano Go esgotado: a janela ' +
        alvo.rotulo +
        ' está no teto' +
        (alvo.percent !== null ? ' (' + alvo.percent + '%)' : '') +
        (alvo.status !== null && /limit|rate/i.test(alvo.status)
          ? ' e o provedor está recusando por limite de uso (status ' + alvo.status + ')'
          : '') +
        (quando !== null ? ', vira ' + quando : '') +
        '.'
      const contexto =
        'Quem esgotou foi a franquia do plano Go (OpenCode); a conta DeepSeek é pré-paga e o consumo por token aparece no saldo.'
      return [principal, contexto]
    }

    /**
     * Titulo e linhas do aviso que substitui o Toast generico do DSH.
     *
     * O DSH entrega so o codigo do erro (`QUOTA` ou `ACCOUNT_QUOTA`) e a copy
     * neutra; ele nao diz qual provedor recusou. O que este texto faz e juntar o
     * codigo com a leitura da franquia que o painel ja tem, e dizer na cara o que
     * continua sem resposta.
     * @param entrada - `{ codigo, franquia, saldo }`, com `franquia` no formato de estado do painel.
     * @returns `{ titulo, linhas, nota }`.
     */
    function textoAvisoCota(entrada) {
      const codigo = entrada?.codigo
      const franquia = entrada?.franquia
      const leituraOk = franquia?.estado === 'ok'
      const alvo = leituraOk ? janelaGoEsgotada(franquia.dados) : null
      const saldo = typeof entrada?.saldo === 'number' && Number.isFinite(entrada.saldo) ? entrada.saldo : null

      if (codigo === 'ACCOUNT_QUOTA') {
        return {
          titulo: 'Saldo da conta DeepSeek esgotado',
          linhas: [
            'O DSH marcou erro de cota da conta, que é o saldo pré-pago' + (saldo !== null ? '; saldo agora: ' + dinheiro(saldo, 'USD') : '') + '.',
            alvo !== null
              ? textoGoEsgotado(alvo)[0]
              : 'A franquia do plano Go não aparece esgotada na última leitura do painel' + (leituraOk ? '.' : ' (a leitura da franquia falhou).')
          ],
          nota: NOTA_SEM_VIA
        }
      }

      const linhas = []
      if (alvo !== null) {
        linhas.push(textoGoEsgotado(alvo)[0])
      } else if (franquia?.estado === 'carregando') {
        linhas.push('Lendo a franquia do Go no roteador do `auto`.')
      } else if (leituraOk) {
        linhas.push('O plano Go não aparece esgotado na última leitura do painel.')
      } else {
        linhas.push('A leitura da franquia do Go falhou' + (typeof franquia?.motivo === 'string' ? ': ' + franquia.motivo : '') + '.')
      }
      linhas.push('O DSH marcou erro de cota, mas o aviso dele não diz qual provedor recusou.')
      linhas.push('Na cadeia do `auto`, o DeepSeek direto é o último elo: é por ele que a sessão continua quando as vias anteriores recusam.')
      return {
        titulo: alvo !== null ? 'Plano Go esgotado' : 'Cota de um provedor esgotada',
        linhas,
        nota: NOTA_SEM_VIA
      }
    }
    //#endregion

    //#region componente
    /**
     * Uma linha `dt`/`dd` do painel.
     * @param key - chave React.
     * @param label - texto ja traduzido.
     * @param value - valor ja formatado.
     * @param tint - classe do quadradinho de legenda, quando a linha tem cor.
     * @param valueClass - classe extra do valor (alerta de credito baixo).
     */
    function row(key, label, value, tint, valueClass) {
      return React.createElement(
        'div',
        { className: 'pu_row', key },
        React.createElement(
          'dt',
          null,
          tint === undefined ? null : React.createElement('span', { className: 'pu_swatch ' + tint, 'aria-hidden': true }),
          label
        ),
        React.createElement('dd', { className: valueClass }, value)
      )
    }

    /** Uma secao: titulo + linhas. */
    function section(titleKey, t, rows) {
      return React.createElement(
        'div',
        { key: titleKey },
        React.createElement('div', { className: 'pu_section' }, t(titleKey)),
        React.createElement('dl', { className: 'pu_rows' }, rows)
      )
    }

    /**
     * Gatilho + painel de uso do composer.
     * @param props - `useProjection` (hook padrao do slot de sessao) e `t` do namespace.
     */
    function UsoPanel(props) {
      const project = typeof props.useProjection === 'function' ? props.useProjection : () => undefined
      const t = props.t
      const pressure = project('contextPressure')
      const breakdown = project('contextBreakdown')
      const usage = project('tokenUsage')
      const stats = project('sessionStats')
      const selection = project('modelSelection')

      const [open, setOpen] = React.useState(false)
      const [credito, setCredito] = React.useState({ estado: 'carregando' })
      const [modelos, setModelos] = React.useState({ estado: 'carregando' })
      const [franquia, setFranquia] = React.useState({ estado: 'carregando' })
      const rootRef = React.useRef(null)
      const occupancy = contextOccupancy(pressure)
      const available = occupancy !== null

      // Sem numerador e capacidade o painel nao tem o que dizer: some, como o
      // medidor nativo, e nunca fica aberto sobre um estado vazio.
      React.useEffect(() => {
        if (!available && open) setOpen(false)
      }, [available, open])

      // Bandeira que libera a ocultacao do anel nativo, ligada apenas enquanto o
      // gatilho esta na tela: o plugin nunca troca um indicador por nenhum.
      React.useEffect(() => {
        if (!available) return undefined
        document.documentElement.dataset.painelUso = 'on'
        return () => {
          delete document.documentElement.dataset.painelUso
        }
      }, [available])

      // Saldo da conta: vem do host, que e quem guarda a chave. O navegador so ve
      // numeros. O cache do host absorve a repeticao; aqui basta buscar na montagem
      // (para o painel abrir com o valor pronto) e de tempo em tempo.
      React.useEffect(() => {
        let vivo = true
        const buscar = () => {
          fetch('/painel-uso/saldo', { credentials: 'same-origin' })
            .then(async (resposta) => ({ status: resposta.status, corpo: await resposta.json().catch(() => undefined) }))
            .then(({ status, corpo }) => {
              if (!vivo) return
              if (status === 200 && corpo?.ok === true) setCredito({ estado: 'ok', dados: corpo })
              else setCredito({ estado: 'falhou', motivo: corpo?.erro ?? 'HTTP ' + status })
            })
            .catch((erro) => {
              if (!vivo) return
              setCredito({ estado: 'falhou', motivo: erro instanceof Error ? erro.message : String(erro) })
            })
        }
        buscar()
        const timer = setInterval(buscar, 300000)
        return () => {
          vivo = false
          clearInterval(timer)
        }
      }, [])

      // Franquia do Go: os percentuais das tres janelas vem do roteador `auto`,
      // que e quem fala com a API do plano. Isso substitui a leitura de
      // `uso.json` como fonte de verdade do limite, porque o contador local so
      // ve o que passa por ele (medido em 11/11/2026: 13% no arquivo contra 27%
      // na API). Renova a cada minuto: e este numero que diz quando a cota acaba.
      React.useEffect(() => {
        if (!open) return undefined
        let vivo = true
        // Duas fontes: a rota do host (mesma origem, entra no boot do Harness) e,
        // enquanto o Harness nao reiniciou, o roteador direto. O roteador libera
        // CORS so para origem local; a segunda tentativa nao manda cookie do DSH.
        const fontes = ['/painel-uso/franquia', 'http://127.0.0.1:8799/franquia']
        const buscar = async () => {
          let motivo = 'sem leitura'
          for (const fonte of fontes) {
            try {
              const resposta = await fetch(fonte, {
                credentials: fonte.charAt(0) === '/' ? 'same-origin' : 'omit'
              })
              const corpo = await resposta.json().catch(() => undefined)
              if (resposta.status === 200 && corpo?.ok === true) {
                if (vivo) setFranquia({ estado: 'ok', dados: corpo })
                return
              }
              motivo = corpo?.erro ?? 'HTTP ' + resposta.status
            } catch (erro) {
              motivo = erro instanceof Error ? erro.message : String(erro)
            }
          }
          if (vivo) setFranquia({ estado: 'falhou', motivo })
        }
        buscar()
        const timer = setInterval(buscar, 60000)
        return () => {
          vivo = false
          clearInterval(timer)
        }
      }, [open])

      // Limites por modelo: lista curada do host. So busca quando o painel abre e
      // renova a cada 30 s, porque o numero e contagem viva de chamadas.
      React.useEffect(() => {
        if (!open) return undefined
        let vivo = true
        const buscar = () => {
          fetch('/painel-uso/modelos', { credentials: 'same-origin' })
            .then(async (resposta) => ({ status: resposta.status, corpo: await resposta.json().catch(() => undefined) }))
            .then(({ status, corpo }) => {
              if (!vivo) return
              if (status === 200 && corpo?.ok === true && Array.isArray(corpo.modelos)) {
                setModelos({ estado: 'ok', dados: corpo.modelos })
              } else {
                setModelos({ estado: 'falhou' })
              }
            })
            .catch(() => {
              if (vivo) setModelos({ estado: 'falhou' })
            })
        }
        buscar()
        const timer = setInterval(buscar, 30000)
        return () => {
          vivo = false
          clearInterval(timer)
        }
      }, [open])

      React.useEffect(() => {
        if (!open || !available) return undefined
        const onPointerDown = (event) => {
          if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [available, open])

      if (!available) return null

      const percent = occupancy.percent
      const reading = percent + '%'

      // Barra de contexto: proporcional a ocupacao e segmentada pela composicao.
      const breakdownTotal =
        breakdown === undefined ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
      const segments =
        breakdown === undefined || breakdownTotal === 0
          ? [{ key: 'total', tint: undefined, width: percent }]
          : [
              { key: 'system', tint: 'pu_tintSystem', width: (percent * breakdown.systemTokens) / breakdownTotal },
              { key: 'tools', tint: 'pu_tintTools', width: (percent * breakdown.toolsTokens) / breakdownTotal },
              { key: 'messages', tint: 'pu_tintMessages', width: (percent * breakdown.messageTokens) / breakdownTotal }
            ].filter((segment) => segment.width > 0)

      const legend =
        breakdown === undefined
          ? []
          : [
              row('system', t('row.system'), '~' + compact(breakdown.systemTokens), 'pu_tintSystem'),
              row('tools', t('row.tools'), '~' + compact(breakdown.toolsTokens), 'pu_tintTools'),
              row('messages', t('row.messages'), '~' + compact(breakdown.messageTokens), 'pu_tintMessages')
            ]

      // Uso da sessao: totais de provider. A taxa de acerto e o cache lido sobre
      // todo o prompt (lido + nao cacheado); o que foi escrito nao conta como acerto.
      const cacheRead = usage?.cacheReadTokens ?? 0
      const uncached = usage?.uncachedInputTokens ?? 0
      const cacheWrite = usage?.cacheWriteTokens ?? 0
      const promptTotal = cacheRead + uncached
      const cacheHit = promptTotal > 0 ? Math.round((cacheRead / promptTotal) * 100) : null
      const billedTotal =
        usage === undefined
          ? null
          : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

      const usageRows = []
      if (usage !== undefined) {
        const traffic =
          promptTotal + cacheWrite > 0
            ? React.createElement(
                'div',
                { className: 'pu_bar', key: 'traffic' },
                cacheRead > 0
                  ? React.createElement('div', {
                      className: 'pu_segment pu_tintMessages',
                      style: { width: (cacheRead / (promptTotal + cacheWrite)) * 100 + '%' }
                    })
                  : null,
                uncached > 0
                  ? React.createElement('div', {
                      className: 'pu_segment pu_tintSystem',
                      style: { width: (uncached / (promptTotal + cacheWrite)) * 100 + '%' }
                    })
                  : null
              )
            : null
        if (traffic !== null) usageRows.push(traffic)
        usageRows.push(row('input', t('row.input'), exact(uncached)))
        if (cacheRead > 0) usageRows.push(row('cacheRead', t('row.cacheRead'), exact(cacheRead)))
        if (cacheWrite > 0) usageRows.push(row('cacheWrite', t('row.cacheWrite'), exact(cacheWrite)))
        usageRows.push(row('output', t('row.output'), exact(usage.outputTokens)))
        if (billedTotal !== null) usageRows.push(row('total', t('row.total'), exact(billedTotal)))
        if (cacheHit !== null) usageRows.push(row('cacheHit', t('row.cacheHit'), cacheHit + '%'))
      }

      // Sessao: contagens e tempos do fold whole-log.
      const sessionRows = []
      if (stats !== undefined && stats.steps > 0) {
        sessionRows.push(row('turns', t('row.turns'), exact(stats.turns)))
        sessionRows.push(row('steps', t('row.steps'), exact(stats.steps)))
        if (stats.llmMs > 0) sessionRows.push(row('modelTime', t('row.modelTime'), duration(stats.llmMs)))
        if (stats.toolMs > 0) sessionRows.push(row('toolTime', t('row.toolTime'), duration(stats.toolMs)))
        if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
          sessionRows.push(
            row('decodeSpeed', t('row.decodeSpeed'), t('unit.tokensPerSecond', { value: Math.round(stats.decodeTokens / (stats.decodeMs / 1000)) }))
          )
        }
        if (stats.ttftSteps > 0) {
          sessionRows.push(row('firstToken', t('row.firstToken'), exact(stats.ttftMs / stats.ttftSteps) + ' ms'))
        }
      }

      const route = selection?.next ?? selection?.lastUsed ?? null
      const routeText =
        route === null || route === undefined
          ? null
          : route.provider + ' / ' + route.model + (route.reasoningEffort === undefined ? '' : ' (' + route.reasoningEffort + ')')

      const children = [
        React.createElement(
          'div',
          { className: 'pu_head', key: 'head' },
          React.createElement('span', { className: 'pu_title' }, t('title.context')),
          React.createElement(
            'span',
            { className: 'pu_figures' },
            '~' + compact(occupancy.usedTokens) + ' / ' + compact(occupancy.contextWindow) + ' (' + reading + ')'
          )
        ),
        React.createElement(
          'div',
          { className: 'pu_bar', key: 'contextBar' },
          segments.map((segment) =>
            React.createElement('div', {
              key: segment.key,
              className: segment.tint === undefined ? 'pu_segment' : 'pu_segment ' + segment.tint,
              style: { width: segment.width + '%' }
            })
          )
        )
      ]

      if (legend.length > 0) children.push(React.createElement('dl', { className: 'pu_rows', key: 'legend' }, legend))
      if (usageRows.length > 0) {
        children.push(React.createElement('div', { className: 'pu_rule', key: 'ruleUsage' }))
        children.push(section('title.usage', t, usageRows))
      }
      if (sessionRows.length > 0) {
        children.push(React.createElement('div', { className: 'pu_rule', key: 'ruleSession' }))
        children.push(section('title.session', t, sessionRows))
      }
      // Credito: o DeepSeek e o motor pago que o Ramses recarrega, entao ele entra
      // como saldo, e nao como barra de limite. So ocupa espaco quando ha resposta
      // (ok ou falha), para o painel nunca abrir com uma secao vazia.
      if (credito.estado !== 'carregando') {
        const linhasCredito = []
        if (credito.estado === 'ok') {
          const primeira = Array.isArray(credito.dados.moedas) ? credito.dados.moedas[0] : undefined
          if (primeira !== undefined) {
            const alerta = credito.dados.abaixoDoAlerta === true
            linhasCredito.push(
              row('creditTotal', t('row.creditTotal'), dinheiro(primeira.total, primeira.moeda), undefined, alerta ? 'pu_valAlerta' : undefined)
            )
            if (alerta) {
              linhasCredito.push(
                React.createElement(
                  'div',
                  { className: 'pu_valAlerta', key: 'creditBelow' },
                  t('credit.below', { amount: dinheiro(credito.dados.alertaAbaixoDe, primeira.moeda) })
                )
              )
            }
          } else {
            linhasCredito.push(React.createElement('div', { className: 'pu_sub', key: 'creditEmpty' }, t('credit.failed')))
          }
          linhasCredito.push(
            React.createElement('div', { className: 'pu_sub', key: 'creditAt' }, t('credit.at', { time: hora(credito.dados.atualizadoEm) }))
          )
        } else {
          linhasCredito.push(React.createElement('div', { className: 'pu_valAlerta', key: 'creditFailed' }, t('credit.failed')))
          linhasCredito.push(
            React.createElement('div', { className: 'pu_sub', key: 'creditReason' }, t('credit.reason', { reason: credito.motivo }))
          )
        }
        children.push(React.createElement('div', { className: 'pu_rule', key: 'ruleCredit' }))
        children.push(section('title.credit', t, linhasCredito))
      }

      // Franquia do Go em tres janelas. O provedor limita 5 horas, semana e mes,
      // e a que aperta primeiro e a semanal (metade do mes), nao a mensal: por
      // isso as tres aparecem, com a hora em que cada uma vira e a previsao de
      // esgotamento calculada sobre as amostras que o roteador grava.
      if (franquia.estado !== 'carregando') {
        const quando = (iso) => {
          const d = new Date(iso)
          if (Number.isNaN(d.getTime())) return String(iso)
          const dois = (n) => String(n).padStart(2, '0')
          return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + ' ' + dois(d.getHours()) + ':' + dois(d.getMinutes())
        }
        const linhasFranquia = []
        if (franquia.estado === 'ok') {
          const janelas = franquia.dados.janelas ?? {}
          const previsao = franquia.dados.previsao ?? {}
          const itens = [
            ['rolling', 'Go 5 horas'],
            ['weekly', 'Go semana'],
            ['monthly', 'Go mes']
          ]
          for (const [chave, rotulo] of itens) {
            const janela = janelas[chave] ?? {}
            const pct = Number(janela.percent)
            if (!Number.isFinite(pct)) continue
            const critico = pct >= 85
            const prever = previsao[chave] ?? {}
            const acaba = prever.esgotaAntesDeVirar === true && typeof prever.esgotaEm === 'string'
            const partes = []
            if (typeof janela.resetsAt === 'string') partes.push('vira ' + quando(janela.resetsAt))
            if (acaba) {
              const horas = Number(prever.horasAteEsgotar)
              partes.push('acaba ' + quando(prever.esgotaEm) + (Number.isFinite(horas) ? ' (' + horas.toFixed(1) + ' h)' : ''))
            } else if (typeof prever.ritmoPorHora === 'number' && prever.ritmoPorHora > 0) {
              // Acaba depois da virada: no ritmo atual a janela cabe, e o que
              // interessa e o ritmo, nao uma data de esgotamento que nunca chega.
              partes.push(prever.ritmoPorHora.toFixed(1) + '%/h, cabe na janela')
            }
            // Barra, e nao linha de tabela: o painel e a lateral mostram o mesmo
            // desenho do limite, porque o numero sozinho nao diz de relance se a
            // janela esta apertada.
            linhasFranquia.push(
              React.createElement(
                'div',
                { className: 'pu_model', key: 'franquia-' + chave },
                React.createElement(
                  'div',
                  { className: 'pu_mtop' },
                  React.createElement('span', { className: 'pu_mnome' }, rotulo),
                  React.createElement('span', { className: 'pu_mnum' }, pct + '%')
                ),
                React.createElement(
                  'div',
                  { className: 'pu_frac' },
                  React.createElement('div', {
                    className: 'pu_segment',
                    style: {
                      width: Math.max(1, Math.min(100, pct)) + '%',
                      '--pu-tint': critico
                        ? 'var(--dsw-alias-state-error-primary)'
                        : pct >= 60
                          ? '#d99a2b'
                          : 'var(--dsw-static-blue-450)'
                    }
                  })
                ),
                partes.length > 0
                  ? React.createElement('div', { className: acaba ? 'pu_valAlerta' : 'pu_sub' }, partes.join(' - '))
                  : null
              )
            )
          }
          // Franquia estourada entra como aviso com nome e sobrenome: qual janela,
          // em que porcentagem, quando vira, e que o esgotado e o plano Go e nao a
          // conta DeepSeek. Sem isso o painel mostrava 100% na barra e nada dizia,
          // e o unico texto na tela era o "cota de solicitacao esgotada" do DSH.
          const alvoGo = janelaGoEsgotada(franquia.dados)
          if (alvoGo !== null) {
            const [principal, contexto] = textoGoEsgotado(alvoGo)
            linhasFranquia.push(React.createElement('div', { className: 'pu_valAlerta', key: 'goEsgotado' }, principal))
            linhasFranquia.push(React.createElement('div', { className: 'pu_sub', key: 'goEsgotadoContexto' }, contexto))
            linhasFranquia.push(React.createElement('div', { className: 'pu_note', key: 'goEsgotadoNota' }, NOTA_SEM_VIA))
          }
          if (linhasFranquia.length === 0) {
            linhasFranquia.push(React.createElement('div', { className: 'pu_sub', key: 'franquiaVazia' }, 'sem leitura'))
          }
        } else {
          linhasFranquia.push(React.createElement('div', { className: 'pu_valAlerta', key: 'franquiaFalhou' }, 'sem leitura'))
          if (franquia.motivo !== undefined) {
            linhasFranquia.push(
              React.createElement('div', { className: 'pu_sub', key: 'franquiaMotivo' }, 'motivo: ' + franquia.motivo)
            )
          }
        }
        children.push(React.createElement('div', { className: 'pu_rule', key: 'ruleFranquia' }))
        children.push(
          React.createElement(
            'div',
            { key: 'blocoFranquia' },
            React.createElement('div', { className: 'pu_section' }, 'Franquia Go'),
            React.createElement('div', { className: 'pu_rows' }, linhasFranquia)
          )
        )
      }

      // Motores: entra so o que foi usado hoje, ou o que esta selecionado agora.
      // Cada linha e uma barra contra o teto que vale para aquele motor: os
      // gratuitos contra o teto publicado, o `auto` contra a franquia do Go em
      // US$ (gasto do ciclo sobre o limite). O numero do auto saia como
      // "2.65560835/100"; agora sai "US$ 2,66/100".
      if (modelos.estado === 'ok' && modelos.dados.length > 0) {
        const emUso = (m) => route !== null && route !== undefined && route.provider === m.provedor && route.model === m.modelo
        // `usadoHoje` e a contagem do dia que o host manda para todo motor, mesmo
        // os que so tem teto por minuto; o resto e o fallback de um host antigo.
        const usadoHoje = (m) => m.usadoHoje ?? m.dia?.usado ?? m.minuto?.usado ?? 0
        const usados = modelos.dados.filter((m) => usadoHoje(m) > 0 || (m.usd?.usado ?? 0) > 0 || emUso(m))
        if (usados.length > 0) {
          const linhasModelos = usados.map((m) => {
            const dia = m.dia ?? null
            const minuto = m.minuto ?? null
            const tpm = m.tpm ?? null
            const usd = m.usd ?? null
            const atual = emUso(m)
            // A manchete e a barra usam a base que o motor tem: franquia em US$,
            // depois teto diario. Motor so com teto por minuto (a NVIDIA e 40/min)
            // nao tem como ser medido por dia: a manchete mostra o total de hoje e
            // a legenda carrega o teto do minuto, em vez do "0/40" que parecia
            // motor parado ao lado de "today 29".
            const janela = usd ?? dia
            // O `auto` e o roteador: o contador dele e local e subestima a franquia
            // (13% no arquivo contra 27% na API, medido em 11/11/2026), entao a
            // manchete dele mostra so o dolar que passou por aqui e a barra passa a
            // ser a da semana do plano, que e a janela que corta o trabalho.
            const roteador = m.provedor === 'auto'
            const semana = franquia.estado === 'ok' ? Number(franquia.dados?.janelas?.weekly?.percent) : NaN
            const pct = roteador
              ? Number.isFinite(semana)
                ? Math.min(100, semana)
                : 0
              : janela === null || janela.limite <= 0
                ? 0
                : Math.min(100, (janela.usado / janela.limite) * 100)
            const nivel = pct >= 85 ? 'critico' : pct >= 60 ? 'alerta' : undefined
            const numero =
              janela === null
                ? minuto === null
                  ? ''
                  : typeof m.usadoHoje === 'number' && m.usadoHoje > 0
                    ? t('model.today', { used: compact(m.usadoHoje) })
                    : minuto.usado + '/' + compact(minuto.limite)
                : usd !== null
                  ? dinheiro(usd.usado, 'USD') + (roteador ? '' : '/' + compact(usd.limite))
                  : dia.usado + '/' + compact(dia.limite)
            const partes = []
            // Motor que so tem teto por minuto ja mostra o dia na manchete; a
            // legenda fica livre para o teto do minuto e o contexto.
            if (usd === null && dia === null && typeof m.usadoHoje === 'number' && m.usadoHoje > 0) {
              partes.push(t('model.today', { used: compact(m.usadoHoje) }))
            }
            if (usd !== null) {
              partes.push(roteador ? 'gasto que passou pelo roteador' : t('model.usd', { limit: dinheiro(usd.limite, 'USD') }))
              // Chamada que saiu por modelo grátis do plano nao gasta dolar: sem
              // esta linha ela nao apareceria em lugar nenhum do painel.
              if (typeof usd.gratis === 'number' && usd.gratis > 0) {
                partes.push(usd.gratis + ' na via livre')
              }
            } else {
              if (dia !== null) partes.push(t('model.limitDay', { limit: compact(dia.limite) }))
              if (minuto !== null) partes.push(t('model.limitMinute', { limit: compact(minuto.limite) }))
              if (tpm !== null) partes.push(t('model.tpm', { limit: compact(tpm) }))
            }
            // Contexto so entra quando o host sabe o numero: o catalogo nem sempre
            // responde para uma rota local (o `auto` do roteador cai no fallback de
            // subagente), e `compact(null)` imprimia "Contexto: 0", que e mentira.
            if (typeof m.contexto === 'number' && m.contexto > 0) {
              partes.push(t('model.context', { value: compact(m.contexto) }))
            }
            // Divisao da franquia Go: o provedor cobra os dois modelos dele no mesmo
            // teto de US$ (medido em 10/11/2026), entao a linha mostra o total e o
            // quanto veio de cada modelo. So aparece quando o roteador ja gravou a
            // divisao; ate reiniciar, a lista vem vazia.
            const divisao = (() => {
              if (usd === null || !Array.isArray(usd.porModelo) || usd.porModelo.length === 0) return ''
              const soma = usd.porModelo.reduce((total, item) => total + (Number(item.usd) || 0), 0)
              if (!(soma > 0)) return ''
              return usd.porModelo
                .filter((item) => Number(item.usd) > 0)
                .map((item) => {
                  const fatia = Math.round((Number(item.usd) / soma) * 100)
                  return apelido('auto', item.modelo) + ' ' + fatia + '%'
                })
                .join(' · ')
            })()
            return React.createElement(
              'div',
              { className: 'pu_model', key: 'modelo:' + m.provedor + '/' + m.modelo },
              React.createElement(
                'div',
                { className: 'pu_mtop' },
                React.createElement(
                  'span',
                  { className: atual ? 'pu_mnome pu_atual' : 'pu_mnome', title: m.provedor + ' / ' + m.modelo },
                  apelido(m.provedor, m.modelo)
                ),
                React.createElement('span', { className: 'pu_mnum' }, numero)
              ),
              janela === null || (roteador && !Number.isFinite(semana))
                ? null
                : React.createElement(
                    'div',
                    { className: 'pu_mbar' },
                    React.createElement('div', {
                      className: 'pu_mfill',
                      'data-nivel': nivel,
                      style: { width: Math.max(1, pct) + '%' }
                    })
                  ),
              React.createElement('div', { className: 'pu_msub' }, partes.join(' · ')),
              divisao === ''
                ? null
                : React.createElement('div', { className: 'pu_msub' }, t('model.split', { list: divisao }))
            )
          })
          children.push(React.createElement('div', { className: 'pu_rule', key: 'ruleModelos' }))
          children.push(
            React.createElement(
              'div',
              { key: 'modelos' },
              React.createElement('div', { className: 'pu_section' }, t('title.models')),
              linhasModelos
            )
          )
          children.push(React.createElement('div', { className: 'pu_note', key: 'noteModelos' }, t('note.models')))
        }
      }

      children.push(React.createElement('div', { className: 'pu_rule', key: 'ruleFoot' }))
      if (routeText !== null) {
        children.push(React.createElement('dl', { className: 'pu_rows', key: 'route' }, [row('route', t('row.route'), routeText)]))
      }

      // Saldo da conta DeepSeek, para o aviso de "compactar com conta negativa
      // passa a ser recusado" existir no gatilho, nao so no painel aberto.
      const creditoSaldo = credito.estado === 'ok' ? credito.dados : null
      const saldo = saldoUsd(creditoSaldo)
      const saldoBaixo =
        saldo !== null && Number.isFinite(saldo) && saldo < (typeof alertaAbaixoDe === 'number' ? alertaAbaixoDe : 1)
      children.push(React.createElement('div', { className: 'pu_note', key: 'note' }, t('note.heuristic')))

      return React.createElement(
        'span',
        { className: 'pu_root', ref: rootRef },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'pu_trigger',
            'aria-label': t('aria.open', { percent: reading }),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen((current) => !current)
          },
          React.createElement('span', { className: 'pu_ring', style: { '--pu-pct': reading }, 'aria-hidden': true }),
          React.createElement('span', null, reading),
          saldoBaixo
            ? React.createElement('span', { className: 'pu_alertaSaldo', title: t('trigger.saldoBaixo', { total: saldo }) })
            : null
        ),
        open
          ? React.createElement(
              'div',
              { className: 'pu_panel', role: 'dialog', 'aria-label': t('aria.open', { percent: reading }) },
              children
            )
          : null
      )
    }
    /**
     * Gatilho compacto do rodape da lateral esquerda.
     *
     * O rodape da sidebar nao tem escopo de sessao: aqui entram so os numeros
     * globais, saldo da conta DeepSeek e o gasto da franquia Go. O painel que abre
     * lista o credito e cada motor com o teto que e dele, sem as linhas de sessao.
     * @param props - `t` do namespace, quando o slot entrega o tradutor.
     */
    function UsoLateral(props) {
      const dic = (chave, valores) => {
        const doSlot = typeof props.t === 'function' ? props.t(chave, valores) : undefined
        return doSlot !== undefined && doSlot !== chave ? doSlot : en[chave] ?? chave
      }
      const [open, setOpen] = React.useState(false)
      const [credito, setCredito] = React.useState({ estado: 'carregando' })
      const [modelos, setModelos] = React.useState({ estado: 'carregando' })
      const [franquia, setFranquia] = React.useState({ estado: 'carregando' })
      const rootRef = React.useRef(null)

      // Franquia do Go: a lateral fica sempre montada, entao a leitura roda na
      // montagem e de dois em dois minutos. E o limite que aperta primeiro e o
      // Ramses le barra, nao tabela: por isso o bloco da lateral e em barras.
      React.useEffect(() => {
        let vivo = true
        const buscar = () => {
          fetch('/painel-uso/franquia', { credentials: 'same-origin' })
            .then(async (resposta) => ({ status: resposta.status, corpo: await resposta.json().catch(() => undefined) }))
            .then(({ status, corpo }) => {
              if (!vivo) return
              if (status === 200 && corpo?.ok === true) setFranquia({ estado: 'ok', dados: corpo })
              else if (status === 404) setFranquia({ estado: 'falhou', motivo: 'rota nova: reinicie o Harness' })
              else setFranquia({ estado: 'falhou', motivo: corpo?.erro ?? 'HTTP ' + status })
            })
            .catch((erro) => {
              if (vivo) setFranquia({ estado: 'falhou', motivo: erro instanceof Error ? erro.message : String(erro) })
            })
        }
        buscar()
        const timer = setInterval(buscar, 120000)
        return () => {
          vivo = false
          clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        let vivo = true
        const buscar = () => {
          fetch('/painel-uso/saldo', { credentials: 'same-origin' })
            .then(async (resposta) => ({ status: resposta.status, corpo: await resposta.json().catch(() => undefined) }))
            .then(({ status, corpo }) => {
              if (!vivo) return
              if (status === 200 && corpo?.ok === true) setCredito({ estado: 'ok', dados: corpo })
              else setCredito({ estado: 'falhou' })
            })
            .catch(() => {
              if (vivo) setCredito({ estado: 'falhou' })
            })
        }
        buscar()
        const timer = setInterval(buscar, 300000)
        return () => {
          vivo = false
          clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        let vivo = true
        const buscar = () => {
          fetch('/painel-uso/modelos', { credentials: 'same-origin' })
            .then(async (resposta) => ({ status: resposta.status, corpo: await resposta.json().catch(() => undefined) }))
            .then(({ status, corpo }) => {
              if (!vivo) return
              if (status === 200 && corpo?.ok === true && Array.isArray(corpo.modelos)) {
                setModelos({ estado: 'ok', dados: corpo.modelos })
              } else {
                setModelos({ estado: 'falhou' })
              }
            })
            .catch(() => {
              if (vivo) setModelos({ estado: 'falhou' })
            })
        }
        buscar()
        const timer = setInterval(buscar, 30000)
        return () => {
          vivo = false
          clearInterval(timer)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const fora = (evento) => {
          if (evento.target instanceof Node && rootRef.current?.contains(evento.target) === true) return
          setOpen(false)
        }
        const esc = (evento) => {
          if (evento.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', fora)
        document.addEventListener('keydown', esc)
        return () => {
          document.removeEventListener('pointerdown', fora)
          document.removeEventListener('keydown', esc)
        }
      }, [open])

      const saldo = credito.estado === 'ok' ? saldoUsd(credito.dados) : null
      const motores = modelos.estado === 'ok' ? modelos.dados : []
      const go = motores.find((m) => m.provedor === 'auto' && m.usd !== null && m.usd !== undefined) ?? null
      const pct = go === null || !(go.usd.limite > 0) ? 0 : Math.min(100, Math.round((go.usd.usado / go.usd.limite) * 100))
      // Enquanto o saldo nao chega, o botao mostra so o anel: "US$ ?" parecia erro
      // de conta. "—" fica para quando a leitura falhou de vez.
      const leitura = saldo === null ? (credito.estado === 'falhou' ? '—' : '') : dinheiro(saldo, 'USD')

      const filhos = [
        React.createElement(
          'div',
          { className: 'pu_head', key: 'head' },
          React.createElement('span', { className: 'pu_title' }, dic('title.credit')),
          React.createElement('span', { className: 'pu_figures' }, leitura === '' ? '—' : leitura)
        )
      ]
      // Franquia do Go entra na frente de tudo: e o limite que corta o trabalho.
      // A semana vem primeiro de proposito (metade do mes, vira toda segunda);
      // depois as 5 horas, que so travam rajada; o mes, por ultimo.
      if (franquia.estado !== 'carregando') {
        const quando = (iso) => {
          const d = new Date(iso)
          if (Number.isNaN(d.getTime())) return '?'
          const dois = (n) => String(n).padStart(2, '0')
          return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + ' ' + dois(d.getHours()) + ':' + dois(d.getMinutes())
        }
        const cor = (v) =>
          v >= 85 ? 'var(--dsw-alias-state-error-primary)' : v >= 60 ? '#d99a2b' : 'var(--dsw-static-blue-450)'
        const fx = [React.createElement('div', { className: 'pu_rule', key: 'r0' })]
        fx.push(React.createElement('div', { className: 'pu_section', key: 'secFx' }, 'Franquia Go'))
        if (franquia.estado === 'ok') {
          const janelas = franquia.dados.janelas ?? {}
          const previsao = franquia.dados.previsao ?? {}
          for (const [chave, rotulo] of [['weekly', 'semana'], ['rolling', '5 horas'], ['monthly', 'mês']]) {
            const j = janelas[chave] ?? {}
            const v = Number(j.percent)
            if (!Number.isFinite(v)) continue
            const p = previsao[chave] ?? {}
            const horas = Number(p.horasAteEsgotar)
            const linha =
              p.esgotaAntesDeVirar === true && typeof p.esgotaEm === 'string'
                ? React.createElement(
                    'div',
                    { className: 'pu_valAlerta' },
                    'acaba ' + quando(p.esgotaEm) + (Number.isFinite(horas) ? ' (' + horas.toFixed(1) + ' h)' : '')
                  )
                : React.createElement('div', { className: 'pu_sub' }, 'vira ' + quando(j.resetsAt))
            fx.push(
              React.createElement(
                'div',
                { className: 'pu_model', key: 'fx-' + chave },
                React.createElement(
                  'div',
                  { className: 'pu_mtop' },
                  React.createElement('span', { className: 'pu_mnome' }, rotulo),
                  React.createElement('span', { className: 'pu_mnum' }, v + '%')
                ),
                React.createElement(
                  'div',
                  { className: 'pu_frac' },
                  React.createElement('div', {
                    className: 'pu_segment',
                    style: { width: Math.max(1, Math.min(100, v)) + '%', '--pu-tint': cor(v) }
                  })
                ),
                linha
              )
            )
          }
          const alvoGoLateral = janelaGoEsgotada(franquia.dados)
          if (alvoGoLateral !== null) {
            const [principal, contexto] = textoGoEsgotado(alvoGoLateral)
            fx.push(React.createElement('div', { className: 'pu_valAlerta', key: 'fxEsgotado' }, principal))
            fx.push(React.createElement('div', { className: 'pu_note', key: 'fxEsgotadoNota' }, contexto))
          }
        } else {
          fx.push(React.createElement('div', { className: 'pu_valAlerta', key: 'fxFalhou' }, 'sem leitura'))
          fx.push(React.createElement('div', { className: 'pu_sub', key: 'fxMotivo' }, franquia.motivo ?? ''))
        }
        filhos.unshift(...fx)
      }

      if (credito.estado === 'ok') {
        filhos.push(React.createElement('div', { className: 'pu_sub', key: 'at' }, dic('credit.at', { time: hora(credito.dados.atualizadoEm) })))
      } else if (credito.estado === 'falhou') {
        filhos.push(React.createElement('div', { className: 'pu_valAlerta', key: 'credFalhou' }, dic('credit.failed')))
      }

      if (motores.length > 0) {
        filhos.push(React.createElement('div', { className: 'pu_rule', key: 'r1' }))
        filhos.push(React.createElement('div', { className: 'pu_section', key: 'sec' }, dic('title.models')))
        motores.forEach((m) => {
          const dia = m.dia ?? null
          const minuto = m.minuto ?? null
          const usd = m.usd ?? null
          const janela = usd ?? dia
          // Declarado antes do `numero` porque a manchete usa: o contador do
          // `auto` e local e subestima a franquia, entao ele aparece sem "/100".
          const roteador = m.provedor === 'auto'
          const numero =
            janela === null
              ? typeof m.usadoHoje === 'number' && m.usadoHoje > 0
                ? dic('model.today', { used: compact(m.usadoHoje) })
                : ''
              : usd !== null
                ? dinheiro(usd.usado, 'USD') + (roteador ? '' : '/' + compact(usd.limite))
                : dia.usado + '/' + compact(dia.limite)
          const detalhe = []
          // Barra do motor: so quando existe teto (dia ou franquia em US$). Motor
          // sem teto publicado (NVIDIA e os gratuitos do Go) nao tem o que medir.
          const pctBarra = janela === null || !(janela.limite > 0) || roteador
            ? null
            : Math.min(100, Math.round((janela.usado / janela.limite) * 100))
          if (usd !== null) detalhe.push(roteador ? 'gasto que passou pelo roteador' : dic('model.usd', { limit: dinheiro(usd.limite, 'USD') }))
          else {
            if (dia !== null) detalhe.push(dic('model.limitDay', { limit: compact(dia.limite) }))
            if (minuto !== null) detalhe.push(dic('model.limitMinute', { limit: compact(minuto.limite) }))
          }
          // Mesma divisao do painel completo: a franquia Go e compartilhada pelos
          // modelos do plano, e a legenda mostra a fatia de cada um.
          if (usd !== null && Array.isArray(usd.porModelo) && usd.porModelo.length > 0) {
            const soma = usd.porModelo.reduce((total, item) => total + (Number(item.usd) || 0), 0)
            if (soma > 0) {
              detalhe.push(
                dic('model.split', {
                  list: usd.porModelo
                    .filter((item) => Number(item.usd) > 0)
                    .map((item) => apelido('auto', item.modelo) + ' ' + Math.round((Number(item.usd) / soma) * 100) + '%')
                    .join(' · ')
                })
              )
            }
          }
          filhos.push(
            React.createElement(
              'div',
              { className: 'pu_model', key: 'm:' + m.provedor + '/' + m.modelo },
              React.createElement(
                'div',
                { className: 'pu_mtop' },
                React.createElement('span', { className: 'pu_mnome' }, apelido(m.provedor, m.modelo)),
                React.createElement('span', { className: 'pu_mnum' }, numero)
              ),
              pctBarra === null
                ? null
                : React.createElement(
                    'div',
                    { className: 'pu_frac' },
                    React.createElement('div', {
                      className: 'pu_segment',
                      style: {
                        width: Math.max(1, pctBarra) + '%',
                        '--pu-tint':
                          pctBarra >= 85
                            ? 'var(--dsw-alias-state-error-primary)'
                            : pctBarra >= 60
                              ? '#d99a2b'
                              : 'var(--dsw-static-blue-450)'
                      }
                    })
                  ),
              React.createElement('div', { className: 'pu_msub' }, detalhe.join(' · '))
            )
          )
        })
        filhos.push(React.createElement('div', { className: 'pu_note', key: 'nota' }, dic('note.models')))
      }

      return React.createElement(
        'span',
        { className: 'pu_root pu_lateral', ref: rootRef },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'pu_trigger',
            'aria-label': dic('title.credit') + ' ' + leitura,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            title: dic('title.credit') + ' ' + leitura,
            onClick: () => setOpen((atual) => !atual)
          },
          React.createElement('span', { className: 'pu_ring', style: { '--pu-pct': pct + '%' }, 'aria-hidden': true }),
          React.createElement('span', null, leitura)
        ),
        open ? React.createElement('div', { className: 'pu_panel', role: 'dialog' }, filhos) : null
      )
    }
    //#endregion

    //#region aviso de cota
    /**
     * Aviso de cota que ocupa a cadeia `shell.quota-notice`.
     *
     * O DSH registra o aviso de cota em `shell.overlay` e entrega o erro a esta
     * cadeia, com um Toast generico como fallback: "Cota de solicitacao
     * esgotada." No perfil deste notebook o aviso apareceu enquanto o plano Go
     * estava estourado e o roteador `auto` tinha a resposta na cadeia, e a frase
     * nao dizia nenhuma das duas coisas. Este componente substitui o fallback
     * para `QUOTA` e `ACCOUNT_QUOTA` e diz o que o painel sabe provar: qual
     * franquia esta no teto (leitura da API do plano) e que o aviso do DSH nao
     * identifica o provedor.
     *
     * Nao mexe em nada do DSH: quem renderiza a cadeia continua sendo o
     * `ui-chat`; aqui so existe uma entrada que se candidata a atender o aviso.
     * @param props - `code`/`matched`, `dismiss` e `keepOpen` entregues pela cadeia.
     */
    function AvisoCota(props) {
      const codigo = props?.code ?? props?.matched?.code
      const fechar = () => {
        try {
          props?.dismiss?.()
        } catch {
          // Aviso ja fechado por outro caminho: nao ha o que desfazer.
        }
      }
      const [franquia, setFranquia] = React.useState({ estado: 'carregando' })
      const [saldo, setSaldo] = React.useState(null)

      React.useEffect(() => {
        let vivo = true
        const buscar = (rota) =>
          fetch(rota, { credentials: 'same-origin' }).then(async (resposta) => ({
            status: resposta.status,
            corpo: await resposta.json().catch(() => undefined)
          }))
        buscar('/painel-uso/franquia')
          .then(({ status, corpo }) => {
            if (!vivo) return
            if (status === 200 && corpo?.ok === true) setFranquia({ estado: 'ok', dados: corpo })
            else setFranquia({ estado: 'falhou', motivo: corpo?.erro ?? 'HTTP ' + status })
          })
          .catch((erro) => {
            if (vivo) setFranquia({ estado: 'falhou', motivo: erro instanceof Error ? erro.message : String(erro) })
          })
        buscar('/painel-uso/saldo')
          .then(({ status, corpo }) => {
            if (vivo && status === 200 && corpo?.ok === true) setSaldo(saldoUsd(corpo))
          })
          .catch(() => {
            // Sem saldo o aviso continua util: ele nao depende do numero.
          })
        // O Toast do DSH se fecha sozinho; esta entrada nao tem tempo de vida
        // proprio, entao o fechamento automatico mora aqui, para um aviso de 30
        // segundos atras nao ficar preso na tela.
        const timer = setTimeout(fechar, 30000)
        return () => {
          vivo = false
          clearTimeout(timer)
        }
      }, [codigo])

      const texto = textoAvisoCota({ codigo, franquia, saldo })
      return React.createElement(
        'div',
        { className: 'pu_aviso', role: 'status', 'aria-live': 'polite' },
        React.createElement('div', { className: 'pu_avisoTitulo' }, texto.titulo),
        texto.linhas.map((linha, indice) => React.createElement('div', { className: 'pu_avisoLinha', key: 'linha' + indice }, linha)),
        texto.nota === null ? null : React.createElement('div', { className: 'pu_avisoNota' }, texto.nota),
        React.createElement(
          'div',
          { className: 'pu_avisoAcoes' },
          React.createElement('button', { type: 'button', className: 'pu_avisoBotao', onClick: fechar }, 'Entendi')
        )
      )
    }
    //#endregion

    //#region plugin
    /** `slots` registra o occupant; `locale` publica os dicionarios. */
    const inject = ['slots', 'locale']

    /**
     * Corpo do plugin de cliente: publica a copy e ocupa tres slots, a faixa do
     * composer (`conversation.input.right`), o rodape da lateral esquerda
     * (`sidebar.footer.action`), para o painel nao depender so do composer, e a
     * cadeia do aviso de cota (`shell.quota-notice`), que e onde o texto do DSH
     * para erro de cota pode dizer qual franquia esgotou.
     * @param ctx - contexto raiz do cliente.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en
          }),
        'dsh-painel-uso: dicionarios'
      )
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            locale: NS,
            id: 'painel-uso',
            order: 10,
            registrant: 'dsh-painel-uso'
          },
          UsoPanel
        )
      )
      // Rodape da lateral esquerda: mesmo painel, com os numeros globais (saldo e
      // franquia Go). `sidebar.footer.action` nao tem escopo de sessao, por isso o
      // componente da lateral nao le projecoes da sessao.
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            locale: NS,
            id: 'painel-uso-lateral',
            order: 10,
            registrant: 'dsh-painel-uso'
          },
          UsoLateral
        )
      )
      // Aviso de cota: o `ui-chat` declara a cadeia `shell.quota-notice` e entrega
      // a ela o codigo do erro (`QUOTA` ou `ACCOUNT_QUOTA`), caindo no Toast
      // generico quando ninguem se candidata. A entrada precisa de `select`:
      // devolver `null` declina e deixa o fallback do DSH aparecer, que e o certo
      // quando o aviso nao e de cota.
      ctx.slots.inject('shell.quota-notice', () =>
        ctx.slots.register(
          {
            name: 'shell.quota-notice',
            locale: NS,
            id: 'painel-uso-aviso-cota',
            order: 10,
            registrant: 'dsh-painel-uso',
            select: (dono) => (dono?.code === 'QUOTA' || dono?.code === 'ACCOUNT_QUOTA' ? { code: dono.code } : null)
          },
          AvisoCota
        )
      )
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
