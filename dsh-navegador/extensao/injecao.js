/*
 * Funções injetadas na aba. Elas são passadas como `func` para
 * `chrome.scripting.executeScript`, e isso impõe uma regra dura: **o corpo da
 * função tem de ser auto-suficiente**. O Chrome serializa o TEXTO da função e
 * reconstrói ela na página, então nada de variável de módulo, nada de import,
 * nada de função de apoio declarada fora: tudo isso vira "X is not defined" na
 * cara do usuário, na hora de ler ou de agir. Foi exatamente o que aconteceu em
 * 16/10/2026, quando `extrairTexto` e `listarElementos` moravam fora de
 * `lerNaPagina`; a conferência estática (`ferramentas/conferir-extensao.mjs`)
 * passou a checar isso.
 *
 * `lerNaPagina` e as leituras de apoio (`localizarNaPagina`, `rolarNaPagina`,
 * `lerParaCopiar`) rodam no mundo isolado: só leem e medem o DOM.
 * `agirNaPagina` roda no mundo MAIN, e isso não é capricho: propriedades
 * adicionadas em nós do DOM são por mundo, então o rastreador de valor do React
 * (um expando no elemento) não existe no mundo isolado, e digitar daria a volta
 * sem o React perceber. No mundo MAIN o comportamento é o de um humano digitando.
 *
 * Desde 04/11/2026 toda leitura roda em TODOS os quadros (`allFrames: true`), e
 * cada função devolve junto `quadro: {id, url, titulo, principal}`. O id nasce no
 * primeiro uso e fica guardado na janela daquele quadro, é o que permite marcar
 * elemento (`data-dsh-nav="qab12:3"`) de forma única no navegador inteiro e
 * depois mandar a ação para o quadro certo. Quem junta os quadros é
 * `quadros.js`, no service worker, porque aqui dentro não cabe import.
 */

/**
 * Lê a aba: identificação, texto, seleção, rolagem ou a lista de elementos
 * acionáveis. Roda em um quadro por chamada.
 *
 * Auto-suficiente de propósito (ver o comentário do topo): os auxiliares moram
 * aqui dentro.
 * @param opções - `{ oQue, seletor, limite }`.
 * @returns objeto simples, serializável, com `quadro` sempre presente.
 */
export function lerNaPagina(opcoes) {
  const oQue = String(opcoes?.oQue ?? 'aba');
  const limite = Number(opcoes?.limite ?? 20000);
  const marca = 'data-dsh-nav';

  /** Id deste quadro, criado uma vez por documento e mundo isolado. */
  function idDoQuadro() {
    try {
      if (typeof window.__dshNavQuadroId !== 'string' || window.__dshNavQuadroId === '') {
        Object.defineProperty(window, '__dshNavQuadroId', {
          value: `q${Math.random().toString(36).slice(2, 8)}`,
          configurable: true,
        });
      }
      return String(window.__dshNavQuadroId);
    } catch {
      return 'q0';
    }
  }

  /** Identificação deste quadro: id, URL, título, e se é o principal. */
  function quadroAtual() {
    let principal = false;
    try {
      principal = window.top === window;
    } catch {
      principal = false;
    }
    let moldura = '';
    try {
      const elemento = window.frameElement;
      if (elemento !== null && elemento !== undefined) {
        const tag = String(elemento.tagName ?? 'iframe').toLowerCase();
        const id = String(elemento.getAttribute?.('id') ?? '');
        const nome = String(elemento.getAttribute?.('name') ?? '');
        moldura = tag + (id === '' ? '' : '#' + id) + (nome === '' ? '' : '[name=' + nome + ']');
      }
    } catch {
      moldura = '';
    }
    return {
      id: idDoQuadro(),
      url: location.href,
      titulo: document.title || '',
      principal,
      ...(moldura === '' ? {} : { moldura }),
    };
  }

  const base = {
    url: location.href,
    titulo: document.title || '',
    quadro: quadroAtual(),
  };

  /** Texto legível da página: escolhe o bloco mais denso e achata o resto. */
  function extrairTexto() {
    const corpo = document.body;
    const corpoTamanho = (corpo?.innerText ?? '').replace(/\s+/g, ' ').trim().length;

    /*
     * Escolha do bloco, do mais específico para o mais genérico. Medir só o
     * tamanho não serve: `body` contém `main`, então ganharia sempre e o texto
     * viria com cabeçalho, lateral e rodapé. Critério: o primeiro container que
     * tenha pelo menos 25% do texto do corpo (é um mínimo absoluto) vence.
     */
    const candidatos = [document.querySelector('article'), document.querySelector('[role="main"]'), document.querySelector('main'), corpo].filter(
      (el) => el !== null && el !== undefined,
    );
    let melhor = corpo;
    for (const el of candidatos) {
      const tamanho = (el.innerText ?? '').replace(/\s+/g, ' ').trim().length;
      if (tamanho >= Math.max(200, corpoTamanho * 0.25)) {
        melhor = el;
        break;
      }
    }

    const partes = [];
    let ultimoTipo = '';

    /*
     * `bloco` começa uma linha nova; `texto` continua a anterior. Sem essa
     * distinção, cada `<strong>` ou `<a>` no meio de uma frase virava uma linha
     * solta, e o agente lia a página picada.
     */
    const empurrar = (texto, tipo) => {
      if (texto === '') return;
      if (tipo === 'texto' && ultimoTipo === 'texto' && partes.length > 0) {
        /*
         * Junta com um espaço, menos quando o texto começa por pontuação: o
         * "Hangzhou ," e o "chatbot ," da Wikipédia vinham de tratar a vírgula
         * que seguia o link como se fosse palavra nova. E não põe espaço depois
         * de parêntese, colchete ou aspas de abertura, que é o " ( chinês:".
         */
        const colado = /^[,.;:!?)\]}"'»”’]/.test(texto) || /[(\[{«"'“‘]$/.test(partes[partes.length - 1]);
        partes[partes.length - 1] = `${partes[partes.length - 1]}${colado ? '' : ' '}${texto}`;
      } else {
        partes.push(texto);
      }
      ultimoTipo = tipo;
    };

    const andar = (no) => {
      if (no.nodeType === Node.TEXT_NODE) {
        empurrar((no.textContent ?? '').replace(/\s+/g, ' ').trim(), 'texto');
        return;
      }
      if (no.nodeType !== Node.ELEMENT_NODE) return;
      const el = no;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'svg', 'canvas', 'template', 'iframe', 'head', 'nav', 'header', 'aside', 'footer'].includes(tag)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      // `innerText` de um nó que não está sendo renderizado devolve o
      // `textContent`, então conteúdo escondido por CSS vazava para a leitura.
      if (typeof el.checkVisibility === 'function' && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false) return;
      if (/^h[1-6]$/.test(tag)) {
        empurrar(`${'#'.repeat(Number(tag[1]))} ${(el.innerText ?? '').replace(/\s+/g, ' ').trim()}`, 'bloco');
        return;
      }
      if (tag === 'li') {
        const t = (el.innerText ?? '').replace(/\s+/g, ' ').trim();
        if (t !== '') {
          empurrar(`- ${t}`, 'bloco');
          return;
        }
      }
      if (tag === 'tr') {
        /*
         * Linha que tem tabela dentro não é linha de dados: é layout. O Hacker
         * News embrulha a lista inteira numa `<td>` de uma tabela externa, e o
         * `innerText` daquela `<tr>` devolvia a página toda numa linha só. Nesse
         * caso descemos, e as linhas de verdade (as internas) viram linhas.
         */
        if (el.querySelector('table, tr') !== null) {
          ultimoTipo = 'bloco';
          for (const filho of el.childNodes) andar(filho);
          ultimoTipo = 'bloco';
          return;
        }
        const celulas = [...el.children]
          .map((c) => (c.innerText ?? '').replace(/\s+/g, ' ').trim())
          // célula vazia (a tabela do Hacker News tem várias, de espaçamento) só
          // polui a linha: "| 1. |  | Título |" vira "| 1. | Título |"
          .filter((c) => c !== '');
        if (celulas.some((c) => c !== '')) empurrar(`| ${celulas.join(' | ')} |`, 'bloco');
        return;
      }
      if (tag === 'button' || tag === 'a' || tag === 'summary') {
        const t = (el.innerText ?? '').replace(/\s+/g, ' ').trim();
        if (tag === 'a') {
          /*
           * Link entra INLINE, e sem marcador, porque na prosa de verdade (a
           * Wikipedia foi o teste) cada `a` virava uma linha nova: "o fundo de
           * investimento quantitativo" / "[link] High-Flyer" / "seu principal
           * financiador". O agente lia a frase picada. O alvo clicavel e o href
           * continuam disponiveis em `o_que: 'elementos'`, que e onde importam.
           * Link sem texto (icone) cai no href, senao não sobra nada.
           */
          const href = el.getAttribute('href') ?? '';
          if (t !== '') empurrar(t, 'texto');
          else if (href !== '') empurrar(href.slice(0, 160), 'texto');
        } else if (t !== '') {
          empurrar(`[${tag === 'button' ? 'botao' : 'resumo'}] ${t}`, 'bloco');
        }
        return;
      }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const rotulo = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '';
        const tipo = el.getAttribute('type') ?? tag;
        empurrar(`[campo ${tipo}${rotulo === '' ? '' : ` ${JSON.stringify(rotulo)}`}]`, 'bloco');
        return;
      }
      if (tag === 'br') {
        ultimoTipo = 'bloco';
        return;
      }
      /*
       * Container de bloco fecha a linha: dois `<p>` seguidos têm de sair em duas
       * linhas, e não colados como "eco do nome: (vazio) cliques no botao: 0".
       */
      if (['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'table', 'form', 'blockquote', 'pre', 'dl', 'figure', 'fieldset', 'details', 'tbody', 'thead', 'tr'].includes(tag)) {
        ultimoTipo = 'bloco';
        for (const filho of el.childNodes) andar(filho);
        ultimoTipo = 'bloco';
        return;
      }
      for (const filho of el.childNodes) andar(filho);
    };

    andar(melhor);
    return partes
      .join('\n')
      // linha que virou só pontuação (o "." depois de um link) não ajuda ninguém
      .replace(/^[.,;:!?]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((linha) => linha.replace(/^[.,;:!?]+\s+/, '').trim())
      .filter((linha) => linha !== '')
      .join('\n')
      .trim();
  }

  /**
   * Lista os elementos acionáveis visíveis e numera cada um com `data-dsh-nav`,
   * para o agente ter um alvo estável entre a leitura e a ação.
   *
   * O valor da marca é `id-do-quadro:n`, e não só `n`: com iframe, cada documento
   * numerava do 1, e `[data-dsh-nav="3"]` existia em todos eles ao mesmo tempo.
   */
  function listarElementos(seletorBruto) {
    const seletor =
      typeof seletorBruto === 'string' && seletorBruto.trim() !== ''
        ? seletorBruto
        : 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]';
    let achados;
    try {
      achados = [...document.querySelectorAll(seletor)];
    } catch (erro) {
      return { resumo: `seletor invalido: ${String(erro?.message ?? erro)}`, itens: [] };
    }
    const visivel = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const estilo = getComputedStyle(el);
      return estilo.visibility !== 'hidden' && estilo.display !== 'none' && estilo.opacity !== '0';
    };
    // A numeração recomeça a cada leitura, então marca velha tem de sair: um
    // `[data-dsh-nav="qab12:1"]` antigo apontaria para outro elemento e a ação
    // iria no lugar errado.
    for (const antigo of document.querySelectorAll(`[${marca}]`)) antigo.removeAttribute(marca);
    const id = idDoQuadro();
    const itens = [];
    let n = 0;
    for (const el of achados) {
      if (itens.length >= 120) break;
      if (!visivel(el)) continue;
      n += 1;
      el.setAttribute(marca, `${id}:${n}`);
      const tag = el.tagName.toLowerCase();
      /*
       * O teto por item era 80 caracteres, e isso bastava para achar alvo mas nao
       * para ler conteudo: mensagem de Slack e corpo de card chegavam cortados no
       * meio da primeira frase. Agora o teto segue o `limite` da chamada, com piso
       * de 80 (lista curta continua util) e teto de 4000 (uma leitura de 120
       * elementos nao vira centenas de KB no contexto).
       */
      const tetoItem = Number.isFinite(limite) ? Math.min(Math.max(limite, 80), 4000) : 4000;
      const texto = String(el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, tetoItem);
      const extra = [];
      const href = el.getAttribute('href');
      if (href !== null && href !== '') extra.push(`href=${href.slice(0, 120)}`);
      const nome = el.getAttribute('name');
      if (nome !== null && nome !== '') extra.push(`name=${nome}`);
      const tipo = el.getAttribute('type');
      if (tipo !== null && tipo !== '') extra.push(`type=${tipo}`);
      if (el.disabled === true) extra.push('desabilitado');
      itens.push(`[${marca}="${id}:${n}"] <${tag}> ${JSON.stringify(texto)}${extra.length === 0 ? '' : ` (${extra.join(', ')})`}`);
    }
    return {
      itens,
      resumo:
        itens.length === 0
          ? 'nenhum elemento acionavel visivel casou com o seletor'
          : `${itens.length} elemento(s) acionavel(is); use o seletor [${marca}="..."] em navegador_agir`,
    };
  }

  /**
   * Estado de rolagem do quadro.
   *
   * Existe para o agente (e para o teste) saberem ANTES de rolar quem rola de
   * verdade: em aplicativo com scroller próprio (Slack, Gmail, Miro) a janela não
   * rola nada, e `window.scrollBy` fica sem efeito.
   */
  function listarRolagem() {
    const linhas = [];
    const pagina = document.scrollingElement ?? document.documentElement;
    if (pagina !== null && pagina !== undefined) {
      const restante = Math.max(0, pagina.scrollHeight - window.innerHeight);
      if (restante > 4) linhas.push(`a pagina: ${Math.round(window.scrollY)}px de ${restante}px rolaveis`);
    }
    let achados = 0;
    let vistos = 0;
    for (const el of document.querySelectorAll('*')) {
      if (achados >= 8) break;
      vistos += 1;
      if (vistos > 6000) break;
      if (el === document.documentElement || el === document.body) continue;
      const restante = el.scrollHeight - el.clientHeight;
      if (restante < 8) continue;
      const estilo = getComputedStyle(el);
      if (estilo.overflowY !== 'auto' && estilo.overflowY !== 'scroll' && estilo.overflowY !== 'overlay') continue;
      const ret = el.getBoundingClientRect();
      if (ret.width < 40 || ret.height < 40) continue;
      const tag = el.tagName.toLowerCase();
      const id = el.id === '' ? '' : `#${el.id}`;
      const classes = typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      const rotulo = String(el.getAttribute('aria-label') ?? el.getAttribute('role') ?? '');
      linhas.push(`<${tag}${id}${classes}>${rotulo === '' ? '' : ` ${JSON.stringify(rotulo)}`}: ${Math.round(el.scrollTop)}px de ${Math.round(restante)}px rolaveis`);
      achados += 1;
    }
    return linhas;
  }

  // Pelo mesmo motivo da ação, o erro da leitura volta como dado.
  try {
    if (oQue === 'aba') return { ...base, resumo: 'identificacao da aba' };

    if (oQue === 'selecao') {
      const selecao = String(window.getSelection?.() ?? '').trim();
      return { ...base, selecao, resumo: selecao === '' ? 'nada selecionado na pagina' : 'selecao do usuario' };
    }

    if (oQue === 'elementos') return { ...base, ...listarElementos(opcoes?.seletor) };

    if (oQue === 'rolagem') {
      const linhas = listarRolagem();
      return {
        ...base,
        rolagem: linhas,
        resumo: linhas.length === 0 ? 'nada rolavel neste quadro' : `${linhas.length} area(s) rolavel(is) neste quadro`,
      };
    }

    // oQue === 'texto' (padrão)
    const extraido = extrairTexto();
    const truncado = extraido.length > limite;
    return {
      ...base,
      texto: truncado ? `${extraido.slice(0, limite)}\n[... texto cortado em ${limite} caracteres]` : extraido,
      truncado,
      resumo: truncado ? `texto da pagina, cortado em ${limite} caracteres` : 'texto da pagina',
    };
  } catch (erro) {
    return { resumo: 'falha na leitura da aba', erro: `nao consegui ler a aba: ${String(erro?.message ?? erro)}` };
  }
}

/**
 * Diz se um seletor casa neste quadro, sem agir em nada.
 *
 * É a primeira fase das ações com seletor quando há iframe: com `allFrames`, o
 * service worker pergunta em todos os quadros quem tem o elemento e só depois
 * manda a ação para UM deles. Agir em todos ao mesmo tempo clicaria em botão de
 * anúncio junto com o botão de verdade.
 *
 * Auto-suficiente (ver o comentário do topo do arquivo).
 * @param pedido - `{ seletor }`.
 * @returns `{quadro, casam, amostra, resumo}`, ou `{erro}`.
 */
export function localizarNaPagina(pedido) {
  const idDoQuadro = () => {
    try {
      if (typeof window.__dshNavQuadroId !== 'string' || window.__dshNavQuadroId === '') {
        Object.defineProperty(window, '__dshNavQuadroId', {
          value: `q${Math.random().toString(36).slice(2, 8)}`,
          configurable: true,
        });
      }
      return String(window.__dshNavQuadroId);
    } catch {
      return 'q0';
    }
  };
  const quadro = (() => {
    let principal = false;
    try {
      principal = window.top === window;
    } catch {
      principal = false;
    }
    return { id: idDoQuadro(), url: location.href, titulo: document.title || '', principal };
  })();
  try {
    const seletor = String(pedido?.seletor ?? '');
    if (seletor === '') return { quadro, casam: 0, amostra: [], resumo: 'sem seletor' };
    let achados;
    try {
      achados = [...document.querySelectorAll(seletor)];
    } catch (erro) {
      return { erro: `seletor invalido: ${String(erro?.message ?? erro)}` };
    }
    const visiveis = achados.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const estilo = getComputedStyle(el);
      return estilo.visibility !== 'hidden' && estilo.display !== 'none' && estilo.opacity !== '0';
    });
    const amostra = visiveis.slice(0, 3).map((el) => {
      const texto = String(el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      return `<${el.tagName.toLowerCase()}>${texto === '' ? '' : ` ${JSON.stringify(texto)}`}`;
    });
    return {
      quadro,
      casam: visiveis.length,
      total: achados.length,
      amostra,
      resumo: visiveis.length === 0 ? 'sem elemento visivel' : `${visiveis.length} elemento(s) visivel(is)`,
    };
  } catch (erro) {
    return { erro: `nao consegui localizar o seletor: ${String(erro?.message ?? erro)}` };
  }
}

/**
 * Rola o container certo, não só a janela.
 *
 * Ordem de escolha do alvo: o container do elemento do `seletor` (quando vem), o
 * container rolável sob o centro da tela, a própria página, e por fim o maior
 * container rolável visível. É o que conserta o Slack: a lista de mensagens tem
 * scroller interno e `window.scrollBy` não move nada.
 *
 * Modos: `procurar` só mede (usado para escolher o quadro antes de rolar) e
 * `rolar` mede e rola.
 *
 * Auto-suficiente (ver o comentário do topo do arquivo).
 * @param pedido - `{ modo, direcao, pixels, seletor }`.
 * @returns `{quadro, rolavel, alvo, posicao, restante, movimento}`, ou `{erro}`.
 */
export function rolarNaPagina(pedido) {
  const idDoQuadro = () => {
    try {
      if (typeof window.__dshNavQuadroId !== 'string' || window.__dshNavQuadroId === '') {
        Object.defineProperty(window, '__dshNavQuadroId', {
          value: `q${Math.random().toString(36).slice(2, 8)}`,
          configurable: true,
        });
      }
      return String(window.__dshNavQuadroId);
    } catch {
      return 'q0';
    }
  };
  const quadro = (() => {
    let principal = false;
    try {
      principal = window.top === window;
    } catch {
      principal = false;
    }
    return { id: idDoQuadro(), url: location.href, titulo: document.title || '', principal };
  })();

  const descrever = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id === '' ? '' : `#${el.id}`;
    const classes = typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const rotulo = String(el.getAttribute('aria-label') ?? el.getAttribute('role') ?? '');
    return `<${tag}${id}${classes}>${rotulo === '' ? '' : ` ${JSON.stringify(rotulo)}`}`;
  };
  const rolavel = (el) => {
    if (el === null || el === undefined) return false;
    if (el.scrollHeight - el.clientHeight <= 4) return false;
    const estilo = getComputedStyle(el);
    return estilo.overflowY === 'auto' || estilo.overflowY === 'scroll' || estilo.overflowY === 'overlay';
  };
  const paginaRolavel = () => {
    const pagina = document.scrollingElement ?? document.documentElement;
    if (pagina === null || pagina === undefined) return false;
    return pagina.scrollHeight - window.innerHeight > 4;
  };

  try {
    const modo = String(pedido?.modo ?? 'rolar');
    const direcao = String(pedido?.direcao ?? 'baixo');
    const pixels = Math.max(1, Math.abs(Number(pedido?.pixels ?? 600)));
    const seletor = String(pedido?.seletor ?? '');

    let alvo = null;
    let tipo = 'pagina';

    if (seletor !== '') {
      const elemento = document.querySelector(seletor);
      if (elemento === null) return { erro: `nao achei nenhum elemento para o seletor ${JSON.stringify(seletor)}` };
      let atual = elemento;
      for (let i = 0; i < 20 && atual !== null && atual !== undefined; i += 1) {
        if (rolavel(atual)) {
          alvo = atual;
          break;
        }
        atual = atual.parentElement;
      }
      if (alvo !== null) tipo = 'elemento';
    }

    if (alvo === null && seletor === '') {
      // Container sob o ponteiro do meio da tela: é o que o usuário vê como "a
      // lista que rola". Só serve quando a página em si não é a rolagem.
      let ponto = null;
      try {
        ponto = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      } catch {
        ponto = null;
      }
      let atual = ponto;
      for (let i = 0; i < 20 && atual !== null && atual !== undefined; i += 1) {
        if (rolavel(atual) && paginaRolavel() === false) {
          alvo = atual;
          tipo = 'elemento';
          break;
        }
        atual = atual.parentElement;
      }
    }

    if (alvo === null && paginaRolavel() === false) {
      // Último recurso: o maior container rolável visível. O teto de elementos
      // visitados evita varrer página patológica (Gmail tem milhares de nós).
      let melhor = null;
      let melhorGanho = 0;
      let vistos = 0;
      for (const el of document.querySelectorAll('*')) {
        vistos += 1;
        if (vistos > 6000) break;
        if (el === document.documentElement || el === document.body) continue;
        const restante = el.scrollHeight - el.clientHeight;
        if (restante < 24) continue;
        const estilo = getComputedStyle(el);
        if (estilo.overflowY !== 'auto' && estilo.overflowY !== 'scroll' && estilo.overflowY !== 'overlay') continue;
        const ret = el.getBoundingClientRect();
        if (ret.width < 60 || ret.height < 60) continue;
        const ganho = Math.min(restante, el.clientHeight) * ret.width;
        if (ganho > melhorGanho) {
          melhorGanho = ganho;
          melhor = el;
        }
      }
      if (melhor !== null) {
        alvo = melhor;
        tipo = 'elemento';
      }
    }

    const medir = () => {
      if (alvo !== null) {
        return {
          posicao: Math.round(alvo.scrollTop),
          restante: Math.max(0, Math.round(alvo.scrollHeight - alvo.clientHeight)),
          altura: Math.round(alvo.scrollHeight),
          visivel: Math.round(alvo.clientHeight),
          alvo: descrever(alvo),
          tipo: 'elemento',
        };
      }
      const pagina = document.scrollingElement ?? document.documentElement;
      return {
        posicao: Math.round(window.scrollY),
        restante: pagina === null || pagina === undefined ? 0 : Math.max(0, Math.round(pagina.scrollHeight - window.innerHeight)),
        altura: pagina === null || pagina === undefined ? 0 : Math.round(pagina.scrollHeight),
        visivel: Math.round(window.innerHeight),
        alvo: 'a pagina',
        tipo: 'pagina',
      };
    };

    const antes = medir();
    if (modo !== 'rolar') {
      const rolavelAgora = tipo === 'elemento' ? true : paginaRolavel();
      return {
        quadro,
        rolavel: rolavelAgora && antes.restante > 0,
        ...antes,
        resumo: rolavelAgora ? `rolavel: ${antes.alvo}` : 'nada rolavel neste quadro',
      };
    }

    const delta = direcao === 'cima' ? -pixels : pixels;
    if (alvo !== null) alvo.scrollBy({ top: delta, behavior: 'instant' });
    else window.scrollBy({ top: delta, behavior: 'instant' });
    const depois = medir();
    return {
      quadro,
      ok: true,
      rolavel: true,
      ...depois,
      movimento: depois.posicao - antes.posicao,
      pedido: delta,
      resumo: `rolei ${antes.alvo} em ${depois.posicao - antes.posicao}px; agora em ${depois.posicao}px de ${depois.restante}px rolaveis`,
    };
  } catch (erro) {
    return { quadro, erro: `nao consegui rolar: ${String(erro?.message ?? erro)}` };
  }
}

/**
 * Lê o texto que o agente quer copiar: do elemento do seletor, da seleção do
 * usuário, ou do começo do texto do quadro.
 *
 * A cópia em si é feita pelo painel (ou, se ele não puder, pelo host), porque
 * clique sintético não vale como ativação de usuário e `navigator.clipboard`
 * recusa gravar fora de um gesto. Aqui só se lê, que é o que depende do DOM.
 *
 * Auto-suficiente (ver o comentário do topo do arquivo).
 * @param pedido - `{ seletor }`.
 * @returns `{quadro, texto, origem, resumo}`, ou `{erro}`.
 */
export function lerParaCopiar(pedido) {
  const idDoQuadro = () => {
    try {
      if (typeof window.__dshNavQuadroId !== 'string' || window.__dshNavQuadroId === '') {
        Object.defineProperty(window, '__dshNavQuadroId', {
          value: `q${Math.random().toString(36).slice(2, 8)}`,
          configurable: true,
        });
      }
      return String(window.__dshNavQuadroId);
    } catch {
      return 'q0';
    }
  };
  const quadro = (() => {
    let principal = false;
    try {
      principal = window.top === window;
    } catch {
      principal = false;
    }
    return { id: idDoQuadro(), url: location.href, titulo: document.title || '', principal };
  })();
  try {
    const seletor = String(pedido?.seletor ?? '');
    const limite = Math.min(Math.max(Number(pedido?.limite ?? 200000), 1), 200000);
    let texto = '';
    let origem = '';
    if (seletor !== '') {
      const el = document.querySelector(seletor);
      if (el !== null) {
        texto = String(el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? el.textContent ?? '');
        origem = `elemento ${seletor}`;
      }
    }
    if (texto.trim() === '') {
      const selecao = String(window.getSelection?.() ?? '');
      if (selecao.trim() !== '') {
        texto = selecao;
        origem = 'selecao do usuario';
      }
    }
    if (texto.trim() === '' && seletor === '') {
      texto = String(document.body?.innerText ?? '');
      origem = 'texto do quadro';
    }
    texto = texto.slice(0, limite);
    return {
      quadro,
      texto,
      origem,
      resumo: texto.trim() === '' ? 'nada para copiar neste quadro' : `${texto.length} caractere(s) de ${origem}`,
    };
  } catch (erro) {
    return { erro: `nao consegui ler o texto para copiar: ${String(erro?.message ?? erro)}` };
  }
}

/**
 * Executa UMA ação aprovada na aba, em UM quadro.
 *
 * É `async` de propósito: `chrome.scripting.executeScript` aguarda a promessa
 * devolvida, então a espera e o tempo de acomodação da página acontecem antes de
 * o resultado voltar para o agente.
 *
 * A rolagem NÃO mora aqui: ela precisa escolher o container e o quadro, e quem
 * faz isso é o service worker com `rolarNaPagina`.
 *
 * @param pedido - `{ acao, seletor, texto, tecla, url, segundos, modo }`.
 * @returns objeto simples com o resultado.
 */
export async function agirNaPagina(pedido) {
  const acao = String(pedido?.acao ?? '');
  const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const achar = (seletor) => {
    if (typeof seletor !== 'string' || seletor.trim() === '') throw new Error('esta acao precisa de um seletor CSS');
    const el = document.querySelector(seletor);
    if (el === null) throw new Error(`nao achei nenhum elemento para o seletor ${JSON.stringify(seletor)}`);
    return el;
  };
  const descrever = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const texto = String(el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return `<${tag}${id}>${texto === '' ? '' : ` "${texto}"`}`;
  };

  /*
   * O erro volta como DADO (`{ ok: false, erro }`), nunca como exceção.
   *
   * Motivo medido em 16/10/2026: com `world: 'MAIN'`, quando a função injetada
   * rejeita, o `chrome.scripting.executeScript` NÃO rejeita do lado do service
   * worker, devolve `[{ result: undefined }]`. O erro virava "o painel devolveu
   * uma resposta inválida" e a mensagem de verdade (o seletor que não existe, por
   * exemplo) se perdia no console da página. Devolvendo o erro no objeto, o
   * caminho é o mesmo nos dois mundos e a mensagem chega ao agente.
   */
  try {
    switch (acao) {
    case 'clicar': {
      const el = achar(pedido.seletor);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      el.focus?.({ preventScroll: true });
      const opts = { bubbles: true, cancelable: true, view: window, composed: true };
      for (const tipo of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const Ctor = tipo.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(tipo, opts));
      }
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', opts));
      await pausa(400);
      return { ok: true, resumo: `cliquei em ${descrever(el)}; a aba agora esta em ${location.href}` };
    }

    case 'digitar': {
      const el = achar(pedido.seletor);
      const texto = String(pedido.texto ?? '');
      const modo = String(pedido.modo ?? 'eventos');
      const disparar = (tipo, no, dados) => {
        try {
          no.dispatchEvent(new Event(tipo, { bubbles: true, cancelable: true, composed: true, ...dados }));
        } catch {
          /* evento recusado pelo navegador: o próximo tenta */
        }
      };
      const entrada = (no, inputType, dados) => {
        try {
          const evento = new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType, ...dados });
          no.dispatchEvent(evento);
        } catch {
          disparar('input', no, dados);
        }
      };
      const antes = (no, inputType, dados) => {
        try {
          no.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType, ...dados }));
        } catch {
          /* navegador sem InputEvent: o change abaixo cobre */
        }
      };
      const valorDe = () => (el.isContentEditable === true ? String(el.textContent ?? '') : String(el.value ?? ''));
      const confere = () => valorDe() === texto;
      const setter = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(setter, 'value');
      const escreverValor = (valor) => {
        if (el.isContentEditable === true) el.textContent = valor;
        else if (typeof descriptor?.set === 'function') descriptor.set.call(el, valor);
        else el.value = valor;
      };

      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      /*
       * O clique ANTES de digitar engaja o componente: é o que o usuário faria.
       * Alguns campos controlados só montam o estado no foco e ignorariam a
       * primeira tecla se ela chegasse sem foco de verdade.
       */
      const opts = { bubbles: true, cancelable: true, view: window, composed: true };
      for (const tipo of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const Ctor = tipo.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(tipo, opts));
      }
      if (typeof el.click === 'function') el.click();
      el.focus?.({ preventScroll: true });
      await pausa(40);

      let como = 'execCommand';
      if (modo === 'teclas') {
        /*
         * Tecla por tecla: para cada caractere, um `keydown`, a inserção pelo
         * pipeline de edição do navegador (`insertText`, que é o que o React e o
         * Vue enxergam) e um `keyup`. É lento de propósito, e é o que faz
         * autocomplete e máscara reagirem como reagem com humano digitando.
         */
        como = 'teclas';
        try {
          el.select?.();
          document.execCommand('delete');
        } catch {
          escreverValor('');
          entrada(el, 'deleteContentBackward', { data: null });
        }
        for (const caractere of [...texto]) {
          try {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: caractere, bubbles: true, cancelable: true, composed: true }));
          } catch {
            /* sem teclado sintético: só a inserção vale */
          }
          let inseriu = false;
          try {
            inseriu = document.execCommand('insertText', false, caractere) === true;
          } catch {
            inseriu = false;
          }
          if (inseriu !== true) {
            const atual = el.isContentEditable === true ? String(el.textContent ?? '') : String(el.value ?? '');
            antes(el, 'insertText', { data: caractere });
            escreverValor(`${atual}${caractere}`);
            entrada(el, 'insertText', { data: caractere });
          }
          try {
            el.dispatchEvent(new KeyboardEvent('keyup', { key: caractere, bubbles: true, cancelable: true, composed: true }));
          } catch {
            /* idem */
          }
          await pausa(12);
        }
      } else {
        /*
         * Primeiro `execCommand('insertText')`, que entra pelo pipeline de edição
         * do navegador e chega em apps que controlam o campo pelo estado (React e
         * afins). Setar `value` direto passa por fora e o app não vê: foi o que
         * aconteceu na busca de contas da Recurly em 23/10/2026, em que o Enter
         * rodava uma busca vazia e a lista não filtrava.
         */
        try {
          el.select?.();
          document.execCommand('delete');
        } catch {
          /* campo sem seleção: a inserção abaixo substitui o valor */
        }
        let digitou = false;
        try {
          el.select?.();
          digitou = document.execCommand('insertText', false, texto) === true && confere();
        } catch {
          digitou = false;
        }
        if (digitou !== true) {
          como = 'eventos';
          antes(el, 'insertText', { data: texto });
          escreverValor(texto);
          entrada(el, 'insertText', { data: texto });
        }
      }

      /*
       * Fecha com `change` e `blur` sintéticos. Formulário que valida no blur
       * (e botão que só habilita depois disso) precisa dos dois, e eles não
       * mudam o foco de verdade do usuário: são só eventos.
       */
      disparar('change', el);
      try {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      } catch {
        /* sem FocusEvent: o change acima já cobre a maioria */
      }
      await pausa(80);
      const atual = valorDe();
      const verificado = atual === texto;
      return {
        ok: true,
        verificado,
        valor_atual: atual.slice(0, 200),
        resumo: verificado
          ? `escrevi ${texto.length} caractere(s) em ${descrever(el)} (${como}; o campo confere)`
          : `escrevi ${texto.length} caractere(s) em ${descrever(el)} (${como}; ATENCAO: o campo nao confere, esta com ${JSON.stringify(atual.slice(0, 80))})`,
      };
    }

    case 'teclar': {
      const alvo = typeof pedido.seletor === 'string' && pedido.seletor !== '' ? achar(pedido.seletor) : document.activeElement ?? document.body;
      const partes = String(pedido.tecla ?? '')
        .split('+')
        .map((p) => p.trim())
        .filter((p) => p !== '');
      if (partes.length === 0) throw new Error('esta acao precisa de uma tecla');
      const nome = partes.pop();
      const altKey = partes.some((p) => /^(alt|option)$/i.test(p));
      const ctrlKey = partes.some((p) => /^(control|ctrl)$/i.test(p));
      const metaKey = partes.some((p) => /^(meta|cmd|command|win)$/i.test(p));
      const shiftKey = partes.some((p) => /^shift$/i.test(p));
      const comum = {
        key: nome,
        code: nome.length === 1 ? `Key${nome.toUpperCase()}` : nome,
        bubbles: true,
        cancelable: true,
        composed: true,
        altKey,
        ctrlKey,
        metaKey,
        shiftKey,
      };
      alvo.dispatchEvent(new KeyboardEvent('keydown', comum));
      alvo.dispatchEvent(new KeyboardEvent('keypress', comum));
      alvo.dispatchEvent(new KeyboardEvent('keyup', comum));
      return { ok: true, resumo: `enviei a tecla ${pedido.tecla} para ${descrever(alvo)}` };
    }

    case 'navegar': {
      const url = String(pedido.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('so navego para enderecos http ou https');
      location.assign(url);
      await pausa(400);
      return { ok: true, resumo: `naveguei para ${url}` };
    }

    case 'voltar': {
      history.back();
      await pausa(400);
      return { ok: true, resumo: `voltei uma pagina no historico; a aba agora esta em ${location.href}` };
    }

    case 'avancar': {
      history.forward();
      await pausa(400);
      return { ok: true, resumo: `avancei uma pagina no historico; a aba agora esta em ${location.href}` };
    }

    case 'recarregar': {
      location.reload();
      await pausa(400);
      return { ok: true, resumo: 'recarreguei a pagina' };
    }

    case 'esperar': {
      const segundos = Math.min(Math.max(Number(pedido.segundos ?? 2), 0), 60);
      await pausa(segundos * 1000);
      return { ok: true, resumo: `esperei ${segundos}s` };
    }

    default:
      return { ok: false, erro: `acao desconhecida: ${JSON.stringify(acao)}` };
    }
  } catch (erro) {
    const motivo = String(erro?.message ?? erro);
    return { ok: false, erro: motivo === '' ? `a acao ${JSON.stringify(acao)} falhou na pagina` : motivo };
  }
}

/**
 * Mede a página e, quando pedido, rola até uma posição, para o print de página
 * inteira.
 *
 * Existe porque a captura de tela do Chrome pega só a área visível: quem monta a
 * imagem completa precisa saber a altura real do documento e em que posição cada
 * captura foi tirada. `scrollTo` com `behavior: instant` é de propósito: rolagem
 * suave deixaria a captura no meio do caminho e as fatias sobrepostas.
 *
 * Roda sempre no quadro principal: o print é da aba, e iframe não entra na
 * costura.
 *
 * Auto-suficiente como as outras (ver o comentário do topo do arquivo).
 * @param pedido - `{ y }` para rolar até `y`; `{ y: null }` só mede.
 * @returns `{ y, altura, largura, visivel, dpr, url }` em pixels CSS.
 */
export function medirParaPrint(pedido) {
  const alvo = pedido?.y;
  if (typeof alvo === 'number' && Number.isFinite(alvo)) {
    try {
      window.scrollTo({ top: alvo, left: 0, behavior: 'instant' });
    } catch {
      /* rolagem bloqueada: a medida abaixo continua valendo */
    }
  }
  const raiz = document.documentElement;
  const corpo = document.body;
  const altura = Math.max(
    raiz?.scrollHeight ?? 0,
    corpo?.scrollHeight ?? 0,
    raiz?.offsetHeight ?? 0,
    corpo?.offsetHeight ?? 0,
  );
  const largura = Math.max(raiz?.scrollWidth ?? 0, corpo?.scrollWidth ?? 0, window.innerWidth ?? 0);
  return {
    y: Math.round(window.scrollY ?? 0),
    altura: Math.round(altura),
    largura: Math.round(largura),
    visivel: Math.round(window.innerHeight ?? 0),
    dpr: Number(window.devicePixelRatio ?? 1),
    url: location.href,
  };
}
