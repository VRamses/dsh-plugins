/*
 * Service worker do add-on.
 *
 * Ele é fino de propósito: quem fala com a ponte do DSH é o PAINEL, que é onde o
 * token e o estado da conversa vivem. Aqui só mora o que exige API de extensão:
 * abrir o painel, menu de contexto, atalhos, e injetar código na aba (ler e
 * agir). Assim existe um dono só para a conexão, e não dois.
 */

import { lerPonte, salvarPonte } from './comum.js';
import { agirNaPagina, lerNaPagina, lerParaCopiar, localizarNaPagina, medirParaPrint, rolarNaPagina } from './injecao.js';
import {
  comporElementosDosQuadros,
  comporRolagemDosQuadros,
  comporSelecaoDosQuadros,
  comporTextoDosQuadros,
  descreverQuadros,
  escolherQuadroDeRolagem,
  escolherQuadroDeTexto,
  escolherQuadroParaAcao,
  quadrosValidos,
  resumoDaRolagem,
} from './quadros.js';

/** Caminho do painel, usado para achar uma janela destacada já aberta. */
const CAMINHO_PAINEL = 'painel/painel.html';

/** Id da janela destacada, quando existe. */
let janelaDestacada = null;

/**
 * Última janela conhecida.
 *
 * Existe porque `chrome.sidePanel.open` precisa ser chamado DENTRO do gesto do
 * usuário, e qualquer `await` antes da chamada quebra esse vínculo (era o defeito
 * que fazia o painel abrir em janela separada). Guardar o id da janela numa
 * variável lida de forma síncrona permite chamar `open` sem esperar nada.
 */
let ultimaJanelaId = null;

/** Teto de fatias do print de página inteira. */
const MAX_FATIAS_PRINT = 10;

/**
 * Teto de quadros (iframes) por leitura.
 *
 * Página de anúncio chega a ter dezenas de iframes; injetar em todos é lento e
 * não ajuda o agente. Doze cobre o uso real (chat do Droz, player, widgets) e
 * mantém a leitura abaixo de um segundo.
 */
const MAX_QUADROS = 12;

/**
 * Pausa entre capturas do print de página inteira.
 *
 * `captureVisibleTab` tem cota de 2 chamadas por segundo no Chrome; abaixo de
 * 500 ms a captura seguinte falha com "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND".
 */
const PAUSA_CAPTURA_MS = 650;

/**
 * Domínios cujos cookies a extensão pode ler.
 *
 * A permissão `cookies` do manifesto é ampla (vale para todo host que o
 * `host_permissions` alcança, e aqui ele inclui `<all_urls>`), então a única
 * barreira real é esta lista. Ela é deliberadamente curta: só os domínios que o
 * Ramses pediu, casados por sufixo, nunca por `includes`.
 */
const DOMINIOS_DE_COOKIE = ['zendesk.com', 'slack.com', 'recurly.com', 'ubersuggest.com', 'neilpatel.com'];

/**
 * Procura o token `xoxc-` da sessão do Slack no armazenamento da página.
 *
 * O token do cliente web do Slack não é cookie: ele vive no armazenamento da aba
 * e só vale junto com o cookie `d`. Nas versões atuais o `localStorage` fica
 * vazio e o token mora no IndexedDB, então a leitura é assíncrona.
 *
 * Limites de propósito: no máximo 4 bancos, 6 stores por banco e 60 registros por
 * store, com corte no primeiro acerto. O IndexedDB do Slack é grande, e varrer
 * tudo travaria a aba.
 *
 * Devolve também os nomes dos bancos e das chaves quando não acha o token, para a
 * próxima tentativa não ser às cegas.
 */
function lerTokenSlackNaPagina() {
  const achados = [];
  const varrerTexto = (valor, onde) => {
    if (typeof valor !== 'string' || valor === '') return;
    const achado = valor.match(/xoxc-[0-9A-Za-z-]{10,}/);
    if (achado !== null) achados.push({ onde, token: achado[0] });
  };
  const chaves = [];

  try {
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        chaves.push(store.key(i));
        varrerTexto(store.getItem(store.key(i)), 'storage:' + store.key(i));
      }
    }
  } catch {
    /* armazenamento bloqueado */
  }

  const abrirBanco = (nome) =>
    new Promise((resolver, rejeitar) => {
      const pedido = indexedDB.open(nome);
      pedido.onsuccess = () => resolver(pedido.result);
      pedido.onerror = () => rejeitar(pedido.error);
    });

  const lerStore = (banco, nome) =>
    new Promise((resolver, rejeitar) => {
      let transacao;
      try {
        transacao = banco.transaction(nome, 'readonly');
      } catch (erro) {
        rejeitar(erro);
        return;
      }
      const pedido = transacao.objectStore(nome).getAll();
      pedido.onsuccess = () => resolver(pedido.result ?? []);
      pedido.onerror = () => rejeitar(pedido.error);
    });

  const varrerIndexedDb = async () => {
    if (achados.length > 0) return;
    let bancos = [];
    try {
      bancos = (await indexedDB.databases?.()) ?? [];
    } catch {
      bancos = [];
    }
    for (const info of bancos.slice(0, 4)) {
      const nome = String(info?.name ?? '');
      if (nome === '') continue;
      chaves.push('idb:' + nome);
      let banco;
      try {
        banco = await abrirBanco(nome);
      } catch {
        continue;
      }
      const stores = Array.from(banco.objectStoreNames).slice(0, 6);
      for (const store of stores) {
        if (achados.length > 0) break;
        let registros = [];
        try {
          registros = await lerStore(banco, store);
        } catch {
          continue;
        }
        for (const registro of registros.slice(0, 60)) {
          if (achados.length > 0) break;
          let texto = '';
          try {
            texto = typeof registro === 'string' ? registro : JSON.stringify(registro);
          } catch {
            texto = '';
          }
          if (texto.length > 400000) continue;
          varrerTexto(texto, 'idb:' + nome + '/' + store);
        }
      }
      try {
        banco.close();
      } catch {
        /* já fechado */
      }
      if (achados.length > 0) break;
    }
  };

  return varrerIndexedDb().then(() => {
    if (achados.length > 0) return { token: achados[0].token, onde: achados[0].onde, chaves };
    return { token: '', onde: '', chaves };
  });
}

/**
 * Lê o token anti-CSRF da página do Zendesk.
 *
 * Roda INJETADA na aba (`chrome.scripting.executeScript` serializa só o corpo da
 * função), então não pode fechar sobre nada de fora: todos os candidatos são
 * resolvidos aqui dentro. O Zendesk já mudou esse token de lugar mais de uma vez,
 * por isso a lista de tentativas em vez de um seletor só.
 */
function lerCsrfNaPagina() {
  const achados = [];
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta !== null) achados.push(meta.getAttribute('content'));
  const campo = document.querySelector('input[name="authenticity_token"]');
  if (campo !== null) achados.push(campo.value);
  const atributo = document.querySelector('[data-csrf-token]');
  if (atributo !== null) achados.push(atributo.getAttribute('data-csrf-token'));
  const zendesk = window.Zendesk;
  if (zendesk !== undefined && zendesk !== null) {
    if (zendesk.ENV !== undefined && zendesk.ENV !== null) achados.push(zendesk.ENV.csrfToken);
    if (zendesk.currentUser !== undefined && zendesk.currentUser !== null) achados.push(zendesk.currentUser.csrfToken);
  }
  for (const valor of achados) {
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
  }
  return '';
}

/**
 * Acha uma aba cujo endereço contenha o host pedido.
 *
 * Existe porque `abaAtual()` devolve a aba ativa da janela em foco, e quando o
 * painel está em janela separada a aba do Slack/Zendesk pode estar em outra
 * janela: a injeção então rodava na aba errada e voltava vazia. Aqui procuro em
 * todas as abas, preferindo a ativa.
 */
async function abaDoHost(host) {
  const proprio = chrome.runtime.getURL('');
  const abas = await chrome.tabs.query({});
  let candidata = null;
  for (const aba of abas) {
    const url = String(aba.url ?? '');
    if (url.startsWith(proprio) || url.includes(host) === false) continue;
    if (aba.active === true) return descreverAba(aba);
    if (candidata === null) candidata = aba;
  }
  return candidata === null ? null : descreverAba(candidata);
}

function dominioPermitido(dominio) {
  const alvo = String(dominio ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '');
  if (alvo === '') return false;
  return DOMINIOS_DE_COOKIE.some((base) => alvo === base || alvo.endsWith(`.${base}`));
}

chrome.runtime.onInstalled.addListener(async () => {
  const ponte = await lerPonte();
  await salvarPonte(ponte);
  await criarMenu();
  // Migração: o modo antigo abria o painel numa janela `popup`, que aparecia no
  // Alt+Tab. Ao recarregar a extensão, essa janela é fechada e o clique no ícone
  // passa a abrir a barra lateral.
  const fechadas = await fecharJanelasDoPainel();
  await prepararPainelLateral();
  if (fechadas > 0) console.log(`dsh-navegador: ${fechadas} janela(s) destacada(s) do painel fechada(s) na migracao`);
  await sincronizarAbas();
});

chrome.runtime.onStartup.addListener(() => {
  criarMenu().catch(() => undefined);
  prepararPainelLateral().catch(() => undefined);
  sincronizarAbas().catch(() => undefined);
});

async function criarMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'dsh-perguntar-selecao',
    title: 'Perguntar ao DSH sobre a seleção',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'dsh-perguntar-pagina',
    title: 'Perguntar ao DSH sobre esta página',
    contexts: ['page'],
  });
}

// ---------------------------------------------------------------------------
// Abrir o painel
// ---------------------------------------------------------------------------

/**
 * Abre o painel do jeito que o navegador permitir.
 *
 * Ordem: `chrome.sidePanel` (Chrome e Edge), depois uma janela destacada.
 *
 * **No Opera a janela destacada é o único caminho**, e isso foi medido: o Opera GX
 * 136 roda sobre Chromium 152, mas não expõe `chrome.sidePanel` nem
 * `chrome.sidebarAction` (`typeof` devolve `undefined` nos dois). O Opera também não
 * implementa `sidebar_action` (chave do Firefox), então ela foi REMOVIDA do
 * manifesto em 04/11/2026: o Chrome a acusava como "Unrecognized manifest key" no
 * cartão da extensão e ela não funcionava em navegador nenhum.
 *
 * A REGRA DURA deste trecho: nada de `await` antes de `chrome.sidePanel.open`.
 * `open` só vale dentro do gesto do usuário (clique no ícone, atalho, menu de
 * contexto), e o `await chrome.windows.getCurrent()` que existia aqui antes
 * consumia o gesto: a chamada lançava, o `catch` engolia e o painel caía na
 * janela destacada, que aparece no Alt+Tab. Medido em 04/11/2026. Por isso o id
 * da janela chega de fora (o listener já recebe a aba) ou vem da variável
 * `ultimaJanelaId`, lidos de forma síncrona.
 *
 * @param aba - aba que originou o pedido (o listener do Chrome entrega).
 * @returns `{modo, janelaId}` dizendo por qual caminho o painel abriu.
 */
async function abrirPainel(aba) {
  const janelaId = janelaDaAba(aba);
  if (chrome.sidePanel?.open !== undefined && janelaId !== null) {
    try {
      await chrome.sidePanel.open({ windowId: janelaId });
      return { modo: 'sidePanel', janelaId };
    } catch (erro) {
      console.warn(`dsh-navegador: sidePanel.open recusou (${String(erro?.message ?? erro)}); abrindo janela`);
    }
  }
  return abrirJanelaDestacada();
}

/** Janela de uma aba, ou a última conhecida, sem esperar nada. */
function janelaDaAba(aba) {
  if (Number.isSafeInteger(aba?.windowId)) return aba.windowId;
  if (Number.isSafeInteger(ultimaJanelaId)) return ultimaJanelaId;
  return null;
}

/**
 * Liga o comportamento nativo "abrir a barra lateral no clique do ícone".
 *
 * Com isso o Chrome abre a barra sozinho, dentro do próprio gesto, e não existe
 * mais `await` no caminho. O listener de `action.onClicked` continua no arquivo
 * para o navegador que não tiver `setPanelBehavior` (o Opera cai na janela
 * destacada): quando o comportamento nativo está ligado, o Chrome simplesmente
 * não dispara o evento.
 * @returns `true` quando o navegador aceitou o comportamento.
 */
async function prepararPainelLateral() {
  if (chrome.sidePanel?.setPanelBehavior === undefined) return false;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fecha as janelas destacadas do painel, na migração para a barra lateral.
 *
 * A extensão antiga abria o painel numa janela `popup`, que aparece no Alt+Tab e
 * não tem nada a ver com a barra lateral. Fechar aqui só acontece na instalação
 * ou na atualização, que é exatamente o momento em que o usuário recarrega a
 * extensão em `chrome://extensions`: o painel é reaberto por ele logo depois, já
 * no lugar certo.
 * @returns quantas janelas foram fechadas.
 */
async function fecharJanelasDoPainel() {
  let fechadas = 0;
  let janelas = [];
  try {
    janelas = await chrome.windows.getAll({ populate: true });
  } catch {
    return 0;
  }
  for (const janela of janelas) {
    if (janela.type !== 'popup') continue;
    const temPainel = (janela.tabs ?? []).some((aba) => (aba.url ?? '').endsWith(CAMINHO_PAINEL));
    if (!temPainel) continue;
    try {
      await chrome.windows.remove(janela.id);
      fechadas += 1;
      if (janela.id === janelaDestacada) janelaDestacada = null;
    } catch {
      /* janela já fechada */
    }
  }
  return fechadas;
}

/** Lê a última posição da janela do painel, se houver e se fizer sentido. */
async function boundsSalvos() {
  try {
    const guardado = (await chrome.storage.local.get('janelaPainel')).janelaPainel;
    if (guardado === undefined || guardado === null) return null;
    const { left, top, width, height } = guardado;
    // largura/altura mínimas para a janela não abrir inutilizável
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 400) return null;
    return {
      width: Math.round(Math.min(width, 2400)),
      height: Math.round(Math.min(height, 2400)),
      ...(Number.isFinite(left) && Number.isFinite(top) ? { left: Math.round(left), top: Math.round(top) } : {}),
    };
  } catch {
    return null;
  }
}

/** Guarda a posição da janela do painel para a próxima abertura. */
async function guardarBounds(janela) {
  if (janela?.id === undefined) return;
  try {
    await chrome.storage.local.set({
      janelaPainel: { left: janela.left, top: janela.top, width: janela.width, height: janela.height },
    });
  } catch {
    /* posição é conveniência: falhar aqui não atrapalha o painel */
  }
}

async function abrirJanelaDestacada() {
  if (janelaDestacada !== null) {
    try {
      await chrome.windows.update(janelaDestacada, { focused: true });
      return { modo: 'janela', janelaId: janelaDestacada };
    } catch {
      janelaDestacada = null;
    }
  }
  const existentes = await chrome.windows.getAll({ populate: true });
  for (const janela of existentes) {
    const temPainel = (janela.tabs ?? []).some((aba) => (aba.url ?? '').endsWith(CAMINHO_PAINEL));
    if (temPainel) {
      janelaDestacada = janela.id ?? null;
      await chrome.windows.update(janela.id, { focused: true });
      return { modo: 'janela', janelaId: janela.id };
    }
  }
  const bounds = await boundsSalvos();
  const janela = await chrome.windows.create({
    url: chrome.runtime.getURL(CAMINHO_PAINEL),
    type: 'popup',
    width: bounds?.width ?? 460,
    height: bounds?.height ?? 860,
    ...(bounds?.left !== undefined ? { left: bounds.left, top: bounds.top } : {}),
  });
  janelaDestacada = janela.id ?? null;
  return { modo: 'janela', janelaId: janela.id };
}

/*
 * A janela do painel no Opera não é barra lateral (o Opera não expõe
 * `chrome.sidePanel`), então ela é uma janela comum: guardar o tamanho e a
 * posição faz a próxima abertura cair onde o usuário deixou.
 *
 * O id em memória não basta: o service worker hiberna e volta com
 * `janelaDestacada` nulo, e aí a janela já aberta pararia de ser lembrada. Quem
 * responde é a URL da aba dentro da janela.
 */
chrome.windows.onBoundsChanged.addListener((janela) => {
  if (janela?.id === undefined) return;
  if (janela.id === janelaDestacada) {
    guardarBounds(janela).catch(() => undefined);
    return;
  }
  chrome.windows
    .get(janela.id, { populate: true })
    .then((completa) => {
      const temPainel = (completa.tabs ?? []).some((aba) => (aba.url ?? '').endsWith(CAMINHO_PAINEL));
      if (!temPainel) return undefined;
      janelaDestacada = completa.id ?? null;
      return guardarBounds(completa);
    })
    .catch(() => undefined);
});

chrome.action.onClicked.addListener((aba) => {
  // Com `openPanelOnActionClick` ligado o Chrome nem dispara este evento; ele
  // fica para o navegador que não aceitou o comportamento nativo.
  abrirPainel(aba).catch(() => undefined);
});

chrome.contextMenus.onClicked.addListener(async (info, aba) => {
  const pergunta = info.menuItemId === 'dsh-perguntar-selecao' ? info.selectionText ?? '' : '';
  /*
   * A ordem importa: `abrirPainel` tem de rodar ANTES de qualquer `await` para
   * não perder o gesto. A gravação do pedido do menu fica em paralelo, e o painel
   * leva mais tempo para carregar do que a escrita no `storage.session`.
   */
  const gravacao = chrome.storage.session.set({
    pedidoDoMenu: { tipo: info.menuItemId, pergunta, abaId: aba?.id ?? null, quando: Date.now() },
  });
  const aberto = abrirPainel(aba).catch(() => undefined);
  await gravacao;
  await aberto;
});

chrome.commands.onCommand.addListener((comando, aba) => {
  if (comando === 'abrir-painel') {
    abrirPainel(aba).catch(() => undefined);
    return;
  }
  if (comando === 'usar-aba-atual') {
    /*
     * O segundo parâmetro do listener é a aba que estava ativa quando o atalho
     * disparou. Antes ele era descartado e o código fazia `await abaAtual()`
     * antes de abrir o painel, o que quebrava o gesto e mandava a barra lateral
     * para a janela destacada.
     */
    const alvo = Number.isSafeInteger(aba?.id) ? aba : null;
    const gravacao = chrome.storage.session.set({
      pedidoDoMenu: {
        tipo: 'dsh-perguntar-pagina',
        pergunta: '',
        abaId: alvo?.id ?? null,
        quando: Date.now(),
      },
    });
    const aberto = abrirPainel(aba).catch(() => undefined);
    gravacao.then(() => aberto).catch(() => undefined);
    return;
  }
});

// ---------------------------------------------------------------------------
// Aba atual: o painel pergunta, o worker responde
// ---------------------------------------------------------------------------

/** A aba ativa da janela em foco, ignorando o próprio painel. */
async function abaAtual() {
  const [focada] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focada !== undefined && !ehProprioPainel(focada.url)) {
    if (Number.isSafeInteger(focada.windowId)) ultimaJanelaId = focada.windowId;
    return descreverAba(focada);
  }

  /*
   * Quando o painel é barra lateral, a aba ativa da janela em foco pode ser o
   * próprio painel? Não: barra lateral não é aba. Quando ele é janela destacada
   * (Opera), ele É a aba ativa da janela em foco, e adotar a si mesmo deixaria o
   * agente lendo o próprio painel. A ordem abaixo resolve o caso com VÁRIAS
   * janelas do Chrome: primeiro a última janela normal em foco
   * (`getLastFocused`, que é o que o usuário acabou de usar), e só depois as
   * demais. Antes era a primeira janela que aparecesse, e com duas janelas abertas
   * o painel podia fixar a aba da janela errada.
   */
  const janelas = [];
  try {
    const ultima = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (ultima?.id !== undefined) janelas.push(ultima);
  } catch {
    /* sem janela normal em foco */
  }
  try {
    for (const janela of await chrome.windows.getAll({ windowTypes: ['normal'] })) {
      if (janela?.id !== undefined && janelas.every((vista) => vista.id !== janela.id)) janelas.push(janela);
    }
  } catch {
    /* sem lista de janelas */
  }
  for (const janela of janelas) {
    const [ativa] = await chrome.tabs.query({ active: true, windowId: janela.id });
    if (ativa !== undefined && !ehProprioPainel(ativa.url)) {
      if (Number.isSafeInteger(ativa.windowId)) ultimaJanelaId = ativa.windowId;
      return descreverAba(ativa);
    }
  }
  return focada === undefined ? null : descreverAba(focada);
}

/** Diz se uma URL é uma página do próprio add-on. */
function ehProprioPainel(url) {
  const base = chrome.runtime.getURL('');
  return typeof url === 'string' && url.startsWith(base);
}

/** Reduz uma aba do chrome.tabs ao que o painel e a ponte precisam. */
function descreverAba(aba) {
  return {
    id: aba.id ?? null,
    janelaId: aba.windowId ?? null,
    url: aba.url ?? '',
    titulo: aba.title ?? '',
    ativa: aba.active === true,
  };
}

/**
 * Lista as abas de verdade do navegador, para a ferramenta `navegador_abas`.
 *
 * As páginas do próprio add-on ficam de fora: o painel e as opções não são alvo
 * útil, e listá-las faria o agente tentar ler o painel.
 *
 * A marca `fixada` NÃO é decidida aqui: quem guarda a aba fixada é o painel, e
 * ele acrescenta o campo ao repassar a lista.
 * @returns lista de `{id, titulo, url, ativa, janela, indice}`.
 */
async function listarAbas() {
  const abas = await chrome.tabs.query({});
  const lista = [];
  for (const aba of abas) {
    const url = String(aba.url ?? '');
    if (url === '' || ehProprioPainel(url)) continue;
    lista.push({
      id: aba.id ?? null,
      titulo: aba.title ?? '',
      url,
      ativa: aba.active === true,
      janela: aba.windowId ?? null,
      indice: aba.index ?? 0,
    });
  }
  return lista;
}

/** Guarda a última aba ativa para o painel já abrir sabendo onde está. */
async function sincronizarAbas() {
  const aba = await abaAtual();
  await chrome.storage.session.set({ ultimaAba: aba });
  return aba;
}

chrome.tabs.onActivated.addListener(() => {
  sincronizarAbas().catch(() => undefined);
});
chrome.tabs.onUpdated.addListener((_id, mudanca, aba) => {
  if (mudanca.status === 'complete' || mudanca.url !== undefined) {
    if (aba.active === true) sincronizarAbas().catch(() => undefined);
  }
});
/*
 * Trocar de janela não dispara `tabs.onActivated` da aba que continua ativa na
 * outra janela, e era esse o buraco do "usar a aba atual" com várias janelas.
 */
chrome.windows.onFocusChanged.addListener((janelaId) => {
  if (!Number.isSafeInteger(janelaId) || janelaId < 0) return;
  ultimaJanelaId = janelaId;
  sincronizarAbas().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Injeção na aba
// ---------------------------------------------------------------------------

/** Páginas onde nenhuma extensão injeta código. */
function paginaRestrita(url) {
  return /^(chrome|opera|edge|brave|about|devtools|view-source|chrome-extension|opera-extension|extension):/i.test(url ?? '');
}

/**
 * Injeta uma função na aba, em UM quadro.
 *
 * A função é repassada DIRETO para `chrome.scripting.executeScript`: o Chrome
 * serializa só o corpo dela, então qualquer função embrulhadora que fechasse
 * sobre outra coisa quebraria na página com "func is not defined". A exceção
 * lançada dentro da página chega aqui como rejeição, e o texto dela é o que o
 * agente lê.
 *
 * Quem precisa de todos os quadros usa `injetarEmQuadros`, que enumera os quadros
 * e chama esta função um por um: `allFrames: true` derruba a chamada inteira
 * quando UM quadro recusa a injeção (anúncio sandbox, frame de extensão), e era
 * isso que fazia a leitura do simulador do Droz voltar vazia mesmo com o iframe
 * acessível.
 * @param abaId - aba alvo.
 * @param func - função a injetar (autossuficiente).
 * @param args - argumentos da função.
 * @param mundo - `ISOLATED` ou `MAIN`.
 * @param opcoes - `{ frameId }`; padrão é o quadro principal.
 */
async function injetar(abaId, func, args, mundo, opcoes = {}) {
  const aba = await chrome.tabs.get(abaId);
  if (paginaRestrita(aba.url)) {
    throw new Error(`não consigo trabalhar nesta página (${aba.url || 'sem endereço'})`);
  }
  const frameId = Number.isSafeInteger(opcoes.frameId) ? opcoes.frameId : 0;
  let resultados;
  try {
    resultados = await chrome.scripting.executeScript({
      target: { tabId: abaId, frameIds: [frameId] },
      func,
      args,
      world: mundo,
    });
  } catch (erro) {
    throw new Error(limparMensagemDeInjecao(String(erro?.message ?? erro)));
  }
  const resultado = resultados?.[0];
  if (resultado === undefined) throw new Error('a injeção não devolveu resultado');
  const valor = resultado.result;
  if (valor !== null && typeof valor === 'object' && typeof valor.erro === 'string') throw new Error(valor.erro);
  return valor;
}

/**
 * Lista os quadros (iframes) de uma aba pela API de navegação.
 *
 * `chrome.webNavigation.getAllFrames` é a única forma barata de saber os frameIds
 * de verdade. Sem a permissão, ou quando a aba ainda não tem navegação, cai no
 * quadro principal: ler o principal é melhor do que não ler nada.
 * @param abaId - aba alvo.
 * @returns `[{frameId, url}]`, principal primeiro.
 */
async function listarQuadrosDaAba(abaId) {
  try {
    const quadros = await chrome.webNavigation?.getAllFrames?.({ tabId: abaId });
    if (Array.isArray(quadros) && quadros.length > 0) {
      return quadros
        .map((quadro) => ({ frameId: quadro.frameId, url: String(quadro.url ?? '') }))
        .sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId))
        .slice(0, MAX_QUADROS);
    }
  } catch {
    /* sem permissão ou aba sem navegação: cai no principal */
  }
  return [{ frameId: 0, url: '' }];
}

/**
 * Injeta a mesma função em todos os quadros da aba, um por um.
 *
 * Cada quadro que falha vira um resultado com `erro`, e não derruba os outros: o
 * quadro de anúncio sandbox não pode levar junto o iframe do chat. O resultado é
 * a lista crua que `quadros.js` entende: `[{frameId, result}]`.
 * @returns `[{frameId, result}]`, na ordem do principal para os demais.
 */
async function injetarEmQuadros(abaId, func, args, mundo) {
  const quadros = await listarQuadrosDaAba(abaId);
  const saida = [];
  for (const quadro of quadros) {
    try {
      const valor = await injetar(abaId, func, args, mundo, { frameId: quadro.frameId });
      saida.push({ frameId: quadro.frameId, result: valor });
    } catch (erro) {
      saida.push({
        frameId: quadro.frameId,
        result: {
          erro: String(erro?.message ?? erro),
          quadro: { id: '', url: quadro.url, titulo: '', principal: quadro.frameId === 0 },
        },
      });
    }
  }
  return saida;
}

/** Quantos quadros não puderam ser lidos (para o resumo da leitura). */
function quadrosComErro(brutos) {
  return (Array.isArray(brutos) ? brutos : []).filter((bruto) => {
    const resultado = bruto?.result;
    return resultado !== null && typeof resultado === 'object' && typeof resultado.erro === 'string';
  }).length;
}

/**
 * Executa uma ação numa aba, resolvendo o QUADRO certo antes quando a ação leva
 * seletor.
 *
 * Três famílias: ação de página inteira (navegar, voltar, avançar, recarregar,
 * esperar) roda sempre no principal; ação com seletor pergunta em todos os
 * quadros quem casa e age em um só; rolagem escolhe o quadro pelo que tem área
 * rolável. A cópia lê o texto aqui e grava a área de transferência no painel.
 * @param abaId - aba alvo.
 * @param pedido - pedido do agente (`acao` + campos).
 * @param quadroPedido - id do quadro escolhido pelo agente, quando veio.
 */
async function agirNaAba(abaId, pedido, quadroPedido) {
  const acao = String(pedido?.acao ?? '');
  if (acao === '') throw new Error('pedido de acao sem acao');

  if (acao === 'rolar') {
    /*
     * Duas fases: primeiro mede em todos os quadros, escolhe um, e só então rola
     * de verdade. Rolar em todos moveria iframe de anúncio junto.
     */
    const procurar = quadrosValidos(
      await injetarEmQuadros(
        abaId,
        rolarNaPagina,
        [{ modo: 'procurar', direcao: pedido.direcao, pixels: pedido.pixels, seletor: pedido.seletor }],
        'ISOLATED',
      ),
    );
    const escolha = escolherQuadroDeRolagem(procurar, quadroPedido);
    if (escolha.erro !== undefined) throw new Error(escolha.erro);
    const valor = await injetar(
      abaId,
      rolarNaPagina,
      [{ modo: 'rolar', direcao: pedido.direcao, pixels: pedido.pixels, seletor: pedido.seletor }],
      'ISOLATED',
      { frameId: escolha.escolhido.frameId },
    );
    return { ...valor, quadro: valor?.quadro ?? escolha.escolhido.resultado?.quadro, resumo: resumoDaRolagem(valor?.quadro ?? escolha.escolhido.resultado?.quadro, valor) };
  }

  if (acao === 'copiar') {
    const lidos = quadrosValidos(await injetarEmQuadros(abaId, lerParaCopiar, [{ seletor: pedido.seletor }], 'ISOLATED'));
    const escolha = escolherQuadroDeTexto(lidos, quadroPedido);
    if (escolha.erro !== undefined) throw new Error(escolha.erro);
    const resultado = escolha.escolhido.resultado;
    return {
      ok: true,
      copiado: true,
      texto: String(resultado?.texto ?? ''),
      origem: String(resultado?.origem ?? ''),
      quadro: resultado?.quadro,
      resumo: `copiei ${String(resultado?.texto ?? '').length} caractere(s) de ${String(resultado?.origem ?? 'texto da aba')}`,
    };
  }

  const dePaginaInteira = ['navegar', 'voltar', 'avancar', 'recarregar', 'esperar'];
  if (dePaginaInteira.includes(acao)) {
    return injetar(abaId, agirNaPagina, [pedido], 'MAIN', { frameId: 0 });
  }

  if (acao === 'teclar' && (typeof pedido.seletor !== 'string' || pedido.seletor === '')) {
    return injetar(abaId, agirNaPagina, [pedido], 'MAIN', { frameId: 0 });
  }

  /*
   * Ação com seletor: localiza em todos os quadros e age em UM. O seletor de
   * elemento lido (`[data-dsh-nav="qab12:3"]`) já é único no navegador inteiro,
   * então o caso comum tem exatamente um candidato.
   */
  const localizados = quadrosValidos(await injetarEmQuadros(abaId, localizarNaPagina, [{ seletor: pedido.seletor }], 'ISOLATED'));
  const escolha = escolherQuadroParaAcao(localizados, quadroPedido);
  if (escolha.erro !== undefined) throw new Error(escolha.erro);
  const valor = await injetar(abaId, agirNaPagina, [pedido], 'MAIN', { frameId: escolha.escolhido.frameId });
  return { ...valor, quadro: localizados.find((item) => item.frameId === escolha.escolhido.frameId)?.resultado?.quadro };
}

/** Tira o ruído do Chrome em volta da exceção lançada dentro da página. */
function limparMensagemDeInjecao(texto) {
  return texto
    .replace(/^Error:\s*/i, '')
    .replace(/\s*at\s+.*$/s, '')
    .trim()
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// Captura de tela
// ---------------------------------------------------------------------------

/**
 * Deixa a aba pronta para `captureVisibleTab`.
 *
 * A captura pega a aba ATIVA da janela, então uma aba de fundo precisa ser
 * ativada antes. A pausa curta é o tempo de o Chrome pintar a aba ativada: sem
 * ela a imagem pode vir com o conteúdo anterior.
 * @param abaId - aba alvo.
 * @returns a aba pronta (ainda com `windowId`).
 */
async function prepararParaCaptura(abaId) {
  const aba = await chrome.tabs.get(abaId);
  if (paginaRestrita(aba.url)) throw new Error(`nao consigo capturar esta pagina (${aba.url || 'sem endereco'})`);
  if (aba.active !== true) {
    await chrome.tabs.update(abaId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return aba;
}

/**
 * Captura a página inteira rolando e empilhando fatias.
 *
 * O Chrome não tem captura de página inteira para extensão (o `debugger` faria,
 * mas mostra a faixa "está sendo depurado" e some com a permissão do usuário).
 * A via aqui é: medir a página, rolar de viewport em viewport, capturar cada
 * tela e devolver as fatias com a posição em que foram tiradas. A montagem do
 * PNG é do PAINEL, que tem canvas; o service worker não tem.
 *
 * Limites: no máximo `MAX_FATIAS_PRINT` telas, e a rolagem volta ao lugar
 * original no fim. Cabeçalho fixo aparece em todas as fatias: é limitação
 * conhecida da costura, não do add-on.
 * @param aba - aba já preparada.
 * @returns `{fatias, inteira, largura, altura, visivel, aba}`.
 */
async function capturarPaginaInteira(aba) {
  const medir = (y) => injetar(aba.id, medirParaPrint, [{ y }], 'ISOLATED');
  const inicio = await medir(null);
  if (inicio.visivel < 50) throw new Error('a aba nao tem area visivel para capturar');
  const fatias = [];
  for (let i = 0; i < MAX_FATIAS_PRINT; i += 1) {
    const fundo = Math.max(0, inicio.altura - inicio.visivel);
    const alvo = Math.min(i * inicio.visivel, fundo);
    const medida = await medir(alvo);
    const anterior = fatias[fatias.length - 1];
    // A rolagem bateu no fim: essa fatia seria igual à anterior.
    if (anterior !== undefined && medida.y <= anterior.y) break;
    if (fatias.length > 0) await new Promise((resolve) => setTimeout(resolve, PAUSA_CAPTURA_MS));
    else await new Promise((resolve) => setTimeout(resolve, 120));
    const dataUrl = await chrome.tabs.captureVisibleTab(aba.windowId, { format: 'png' });
    fatias.push({ dataUrl, y: medida.y, visivel: medida.visivel, altura: medida.altura, dpr: medida.dpr });
    if (medida.y + medida.visivel >= medida.altura - 1) break;
  }
  try {
    await medir(inicio.y);
  } catch {
    /* a página pode ter navegado: a rolagem é conveniência */
  }
  return {
    fatias,
    inteira: true,
    largura: inicio.largura,
    altura: inicio.altura,
    visivel: inicio.visivel,
    dpr: inicio.dpr,
    aba: descreverAba(aba),
  };
}

// ---------------------------------------------------------------------------
// Ponte com o painel
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((mensagem, _remetente, responder) => {
  tratar(mensagem)
    .then((valor) => responder({ ok: true, valor }))
    .catch((erro) => responder({ ok: false, erro: String(erro?.message ?? erro) }));
  return true;
});

async function tratar(mensagem) {
  switch (mensagem?.tipo) {
    case 'aba-atual':
      return (await abaAtual()) ?? (await chrome.storage.session.get('ultimaAba')).ultimaAba ?? null;

    case 'pedido-do-menu': {
      const { pedidoDoMenu } = await chrome.storage.session.get('pedidoDoMenu');
      if (pedidoDoMenu !== undefined) await chrome.storage.session.remove('pedidoDoMenu');
      return pedidoDoMenu ?? null;
    }

    case 'ler': {
      const abaId = mensagem.abaId ?? (await abaAtual())?.id;
      if (abaId === undefined || abaId === null) throw new Error('nenhuma aba ativa para ler');
      const oQue = String(mensagem.oQue ?? 'texto');
      const limite = Number(mensagem.limite ?? 20000);
      const pedido = { oQue, seletor: mensagem.seletor, limite };
      if (oQue === 'aba') {
        const valor = await injetar(abaId, lerNaPagina, [pedido], 'ISOLATED', { frameId: 0 });
        return { ...valor, quadros: descreverQuadros([{ frameId: 0, resultado: valor }]) };
      }
      /*
       * A leitura vale para todos os quadros: o simulador do Droz roda o chat
       * dentro de `<iframe name="preChat">`, e ler só o principal devolvia vazio
       * (medido em 04/11/2026). A composição do que cada quadro devolveu mora em
       * `quadros.js`, que o Node também consegue testar.
       */
      const brutos = await injetarEmQuadros(abaId, lerNaPagina, [pedido], 'ISOLATED');
      const itens = quadrosValidos(brutos);
      const quadros = descreverQuadros(itens);
      const semAcesso = quadrosComErro(brutos);
      const principal = itens.find((item) => item?.resultado?.quadro?.principal === true) ?? itens[0]?.resultado ?? {};
      const base = { url: String(principal.url ?? ''), titulo: String(principal.titulo ?? ''), quadros };
      const notaQuadros = `${quadros.length > 1 ? ` (${quadros.length} quadros)` : ''}${semAcesso > 0 ? `; ${semAcesso} quadro(s) sem acesso` : ''}`;

      if (oQue === 'selecao') {
        const { selecao } = comporSelecaoDosQuadros(itens);
        return {
          ...base,
          selecao,
          resumo: selecao === '' ? 'nada selecionado na pagina' : `selecao do usuario${notaQuadros}`,
        };
      }
      if (oQue === 'elementos') {
        const composto = comporElementosDosQuadros(itens);
        return { ...base, itens: composto.itens, resumo: `${composto.resumo}${notaQuadros}` };
      }
      if (oQue === 'rolagem') {
        const composto = comporRolagemDosQuadros(itens);
        return {
          ...base,
          rolagem: composto.rolagem,
          resumo: composto.rolagem.length === 0 ? 'nada rolavel nesta aba' : `${composto.rolagem.length} area(s) rolavel(is)${notaQuadros}`,
        };
      }
      if (oQue !== 'texto') throw new Error(`o_que desconhecido: ${oQue}`);
      const composto = comporTextoDosQuadros(itens, limite);
      return {
        ...base,
        texto: composto.texto,
        truncado: composto.truncado,
        resumo: (composto.truncado ? `texto da pagina, cortado em ${limite} caracteres` : 'texto da pagina') + notaQuadros,
      };
    }

    case 'agir': {
      const abaId = mensagem.abaId ?? (await abaAtual())?.id;
      if (abaId === undefined || abaId === null) throw new Error('nenhuma aba ativa para agir');
      return agirNaAba(abaId, mensagem.pedido, mensagem.quadro);
    }

    case 'abas':
      return listarAbas();

    case 'navegar-nova': {
      /*
       * Navegação em aba nova não passa pela injeção: `location.assign` muda a
       * aba em que roda, e o pedido aqui é justamente ABRIR outra. Quem cria é a
       * API de abas, e o painel fixa nela quando recebe o id de volta.
       */
      const url = String(mensagem.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('so abro aba para enderecos http ou https');
      const janelaId = Number.isSafeInteger(mensagem.janelaId) ? mensagem.janelaId : ultimaJanelaId;
      const nova = await chrome.tabs.create({
        url,
        active: true,
        ...(janelaId === null ? {} : { windowId: janelaId }),
      });
      if (Number.isSafeInteger(nova.id) === false) throw new Error('o Chrome nao devolveu o id da aba nova');
      // Espera a página começar a carregar: sem isso o título volta vazio e o
      // agente não sabe se a aba abriu.
      const limite = Date.now() + 2500;
      let atual = nova;
      while (Date.now() < limite) {
        atual = await chrome.tabs.get(nova.id);
        if (atual.status === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return descreverAba(atual);
    }

    case 'print': {
      const abaId = mensagem.abaId ?? (await abaAtual())?.id;
      if (abaId === undefined || abaId === null) throw new Error('nenhuma aba ativa para o print');
      const aba = await prepararParaCaptura(abaId);
      if (mensagem.inteira === true) return await capturarPaginaInteira(aba);
      const dataUrl = await chrome.tabs.captureVisibleTab(aba.windowId, { format: 'png' });
      return { dataUrl, inteira: false, aba: descreverAba(aba) };
    }

    case 'cookies': {
      /*
       * Leitura de cookie de sessão (inclusive HttpOnly, que `document.cookie`
       * nunca entrega). Sem a permissão `cookies` no manifesto a API nem existe,
       * então o erro abaixo é o único caminho quando a extensão está velha.
       *
       * O alvo é o HOST exato, não o domínio base: `getAll({domain})` devolve
       * cookie de todos os subdomínios, e mandar a sessão do NP Digital para o
       * `pdi-aktienow` autenticaria na conta errada. O filtro abaixo aceita o
       * cookie do próprio host e o de domínio pai (`.zendesk.com`), que é onde a
       * Zendesk costuma gravar `_zendesk_shared_session`.
       */
      if (chrome.cookies === undefined) {
        throw new Error('esta instalacao da extensao nao tem a permissao "cookies"; recarregue a extensao sem compactacao');
      }
      const host = String(mensagem.host ?? mensagem.dominio ?? '')
        .trim()
        .toLowerCase();
      if (!dominioPermitido(host)) throw new Error(`host fora da lista permitida: ${host || '(vazio)'}`);
      /*
       * `getAll({domain})` ja restringe ao host pedido e aos subdominios dele, entao
       * nao filtro dominio de novo aqui: um filtro caseiro por `endsWith` foi o que
       * zerou a lista quando o cookie veio em `.neilpatel.zendesk.com`.
       * Sobra so o corte de cookie expirado.
       */
      const lista = await chrome.cookies.getAll({ domain: host });
      const agora = Math.floor(Date.now() / 1000);
      const aplicaveis = lista.filter((c) => c.expirationDate === undefined || c.expirationDate > agora + 30);
      if (aplicaveis.length === 0) {
        const totalPerfil = (await chrome.cookies.getAll({})).length;
        const amostra = lista
          .slice(0, 8)
          .map((c) => `${c.domain}:${c.name}`)
          .join(', ');
        throw new Error(
          `zero cookies para "${host}": getAll devolveu ${lista.length}, o perfil tem ${totalPerfil}` +
            (lista.length > 0 ? `, amostra [${amostra}]` : ''),
        );
      }
      /*
       * O token anti-CSRF só existe no documento, então vem por injeção na aba.
       * Se a aba atual não for do mesmo host, devolve vazio em vez de falhar: o
       * cookie continua valendo e a leitura funciona sem escrita.
       */
      let csrf = '';
      try {
        const aba = await abaDoHost(host);
        if (aba !== null) {
          csrf = String((await injetar(aba.id, lerCsrfNaPagina, [], 'MAIN')) ?? '');
        }
      } catch {
        /* sem CSRF: escrita fica bloqueada, leitura não */
      }

      /*
       * O Slack não autentica por cookie sozinho: o cliente web manda o token
       * `xoxc-` (que vive no armazenamento da aba) junto com o cookie `d`.
       * Então, para host do Slack, a captura também vai buscar o token.
       */
      let tokenSlack = { token: '', onde: '', chaves: [] };
      if (host.endsWith('zendesk.com') === false) {
        try {
          const aba = await abaDoHost(host);
          if (aba !== null) {
            const lido = await injetar(aba.id, lerTokenSlackNaPagina, [], 'MAIN');
            if (lido !== null && typeof lido === 'object') tokenSlack = lido;
          }
        } catch {
          /* sem token: sobra o cookie, que sozinho nao autentica a API */
        }
      }

      return {
        host,
        total: aplicaveis.length,
        quando: Date.now(),
        csrf,
        token: typeof tokenSlack.token === 'string' ? tokenSlack.token : '',
        token_onde: typeof tokenSlack.onde === 'string' ? tokenSlack.onde : '',
        chaves: Array.isArray(tokenSlack.chaves) ? tokenSlack.chaves.map(String) : [],
        cookies: aplicaveis.map((c) => ({
          name: c.name,
          value: c.value,
          host: c.domain,
          httpOnly: c.httpOnly === true,
          secure: c.secure === true,
          session: c.session === true,
          expirationDate: c.expirationDate ?? null,
        })),
      };
    }

    default:
      throw new Error(`mensagem desconhecida: ${String(mensagem?.tipo)}`);
  }
}

// O painel pode pedir para sincronizar quando ele abre.
chrome.runtime.onConnect?.addListener?.((porta) => {
  if (porta.name !== 'dsh-painel') return;
  sincronizarAbas().catch(() => undefined);
});
