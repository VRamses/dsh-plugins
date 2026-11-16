/**
 * dsh-deepseek-web: o botao da barra lateral que leva ao DeepSeek gratuito.
 *
 * O que ele faz: ocupa o slot `sidebar.footer.action` (slot de lista, escopo
 * root) com um link para https://chat.deepseek.com/, a faixa logo acima de
 * "Settings". Clicar nao navega o app: a casca Electron manda o http/https para
 * `shell.openExternal`, entao o site abre no navegador padrao, na janela dele.
 *
 * Por que um link e nao um painel embutido: a casca bloqueia de proposito pagina
 * de terceiro dentro da janela. `webviewTag` nao esta ligado,
 * `will-attach-webview` e cancelado em toda janela e `isHarnessUrl` so confia em
 * 127.0.0.1/localhost. Embutir o site exigiria furar justamente essa regra.
 *
 * O bundle e escrito a mao no formato que `dsh-client-modules` espera: um script
 * classico que registra uma factory CJS em `window.__ModuleLoader__`, sem passo
 * de build. Editar este arquivo e recarregar a pagina basta (o host serve o
 * arquivo do pacote na rota /plugins/dsh-deepseek-web/client.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Destino: o chat gratuito do DeepSeek, na raiz (sem sessao nem idioma). */
    const URL_DESTINO = 'https://chat.deepseek.com/'

    /** Copy do gatilho, usada no rotulo, no title e no aria-label. */
    const ROTULO = 'DeepSeek gratuito'
    const DICA = 'Abrir o chat.deepseek.com no navegador (DeepSeek gratuito, sem gastar a API)'

    //#region estilos
    // Tokens do tema do DSH, os mesmos que o painel de uso usa. A regra de largura
    // e `flex:1 1 auto` porque a faixa do rodape pode ser linha ou coluna: assim
    // o botao ocupa o que houver sem empurrar o que estiver ao lado.
    const CSS = [
      '.dsw_link{box-sizing:border-box;display:flex;flex:1 1 auto;align-items:center;gap:8px;min-width:0;height:32px;padding:0 8px;border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;text-decoration:none;cursor:pointer}',
      '.dsw_link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsw_link:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.dsw_icon{flex:none;opacity:.8}',
      '.dsw_text{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dsw_estreito{justify-content:center;padding:0}'
    ].join('')

    const CSS_TAG = 'dsh-deepseek-web/client.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-deepseek-web'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

    /**
     * Icone de link externo, desenhado em currentColor para seguir o tema.
     * @returns o elemento svg.
     */
    function IconeSaida() {
      return React.createElement(
        'svg',
        {
          className: 'dsw_icon',
          width: 15,
          height: 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true'
        },
        React.createElement('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }),
        React.createElement('polyline', { points: '15 3 21 3 21 9' }),
        React.createElement('line', { x1: 10, y1: 14, x2: 21, y2: 3 })
      )
    }

    /**
     * O gatilho. Recebe `wide` da propria sidebar: com a barra recolhida so cabe
     * o icone, entao o texto e omitido em vez de ser cortado.
     * @param props - `{ wide }` publicado pelo occupant do slot.
     * @returns o link.
     */
    function BotaoDeepSeekGratuito(props) {
      const estreito = props !== undefined && props !== null && props.wide === false
      return React.createElement(
        'a',
        {
          className: estreito ? 'dsw_link dsw_estreito' : 'dsw_link',
          href: URL_DESTINO,
          target: '_blank',
          rel: 'noreferrer',
          title: DICA,
          'aria-label': DICA
        },
        React.createElement(IconeSaida, null),
        estreito
          ? null
          : React.createElement('span', { className: 'dsw_text' }, ROTULO)
      )
    }
    //#endregion

    //#region plugin
    /** `slots` registra o occupant; o slot pertence a ui-sidebar. */
    const inject = ['slots']

    /**
     * Corpo do plugin de cliente: ocupa `sidebar.footer.action` (slot de lista,
     * escopo root, logo acima de "Settings").
     * @param ctx - contexto raiz do cliente.
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'deepseek-web',
            order: 10,
            registrant: 'dsh-deepseek-web'
          },
          BotaoDeepSeekGratuito
        )
      )
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
