/*
 * Conferência estática da extensão.
 *
 * Existe por um motivo prático: a extensão não roda no Node, então a maior parte
 * dela só seria testada abrindo o navegador, e erro de referência (id de elemento
 * que não existe, campo de `tela` com nome torto, API do Chrome usada sem a
 * permissão no manifesto, arquivo citado no manifesto que não está no disco) só
 * apareceria na cara do usuário. Nenhum desses erros é pego por `node --check`,
 * porque todos são sintaticamente válidos.
 *
 * Uso: node conferir-extensao.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(AQUI, '..', 'extensao');
const placar = { ok: 0, falhou: 0 };

function conferir(rotulo, condicao, detalhe = '') {
  if (condicao) {
    placar.ok += 1;
    console.log(`  ok    ${rotulo}${detalhe === '' ? '' : ` (${detalhe})`}`);
  } else {
    placar.falhou += 1;
    console.log(`  FALHA ${rotulo}${detalhe === '' ? '' : ` (${detalhe})`}`);
  }
}

const ler = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');
const html = ler('painel/painel.html');
const painel = ler('painel/painel.js');
const sw = ler('sw.js');
const comum = ler('comum.js');
const injecao = ler('injecao.js');
const manifesto = JSON.parse(ler('manifest.json'));

// ---------------------------------------------------------------------------
// 1. ids do HTML x ids pedidos pelo painel
// ---------------------------------------------------------------------------

const idsNoHtml = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const idsPedidos = [...painel.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]);
const semElemento = idsPedidos.filter((id) => !idsNoHtml.has(id));

conferir('todo `el(...)` do painel existe no HTML', semElemento.length === 0, semElemento.join(', ') || `${idsPedidos.length} ids`);

const idsSelectors = [...painel.matchAll(/querySelector\('#([^']+)'\)/g)].map((m) => m[1]);
const selectorsOrfaos = idsSelectors.filter((id) => !idsNoHtml.has(id));
conferir('todo `querySelector(#...)` existe no HTML', selectorsOrfaos.length === 0, selectorsOrfaos.join(', ') || `${idsSelectors.length} seletores`);

const idsOrfaos = [...idsNoHtml].filter((id) => !idsPedidos.includes(id) && !html.includes(`for="${id}"`) && !html.includes(`#${id}`));
console.log(`  info  ${idsNoHtml.size} ids no HTML, ${idsOrfaos.length} sem uso direto pelo painel${idsOrfaos.length === 0 ? '' : `: ${idsOrfaos.join(', ')}`}`);

// ---------------------------------------------------------------------------
// 2. campos de `tela` e `ui` usados x declarados
// ---------------------------------------------------------------------------

/** Lê as chaves de um objeto literal `const nome = { ... };` de primeiro nível. */
function chavesDe(fonte, nome) {
  const inicio = fonte.indexOf(`const ${nome} = {`);
  if (inicio < 0) return new Set();
  let i = fonte.indexOf('{', inicio);
  let profundidade = 0;
  let fim = -1;
  for (let p = i; p < fonte.length; p += 1) {
    const c = fonte[p];
    if (c === '{') profundidade += 1;
    else if (c === '}') {
      profundidade -= 1;
      if (profundidade === 0) {
        fim = p;
        break;
      }
    }
  }
  const corpo = fonte.slice(i + 1, fim);
  const chaves = new Set();
  for (const achado of corpo.matchAll(/^\s{2}([a-zA-Z_$][\w$]*)\s*[:,]/gm)) chaves.add(achado[1]);
  // chaves definidas depois, por atribuição: `tela.x = ...`
  return chaves;
}

const chavesTela = chavesDe(painel, 'tela');
const chavesUi = chavesDe(painel, 'ui');

function usos(fonte, nome, declaradas) {
  const achados = new Set([...fonte.matchAll(new RegExp(`\\b${nome}\\.([a-zA-Z_$][\\w$]*)`, 'g'))].map((m) => m[1]));
  return [...achados].filter((chave) => !declaradas.has(chave));
}

const telaTortas = usos(painel, 'tela', chavesTela);
const uiTortas = usos(painel, 'ui', chavesUi);

conferir('nenhum campo de `tela` fora do declarado', telaTortas.length === 0, telaTortas.join(', ') || `${chavesTela.size} campos`);
conferir('nenhum campo de `ui` fora do declarado', uiTortas.length === 0, uiTortas.join(', ') || `${chavesUi.size} campos`);

// ---------------------------------------------------------------------------
// 3. APIs do Chrome usadas x permissões declaradas
// ---------------------------------------------------------------------------

/** Permissão exigida por cada namespace (o resto não pede nada). */
const EXIGE = {
  storage: 'storage',
  tabs: 'tabs',
  scripting: 'scripting',
  contextMenus: 'contextMenus',
  sidePanel: 'sidePanel',
};

const perms = new Set(manifesto.permissions ?? []);
const apisUsadas = new Set();
for (const fonte of [painel, sw, comum, injecao]) {
  for (const achado of fonte.matchAll(/chrome\.([a-zA-Z]+)\./g)) apisUsadas.add(achado[1]);
}
const faltando = [...apisUsadas].filter((api) => EXIGE[api] !== undefined && !perms.has(EXIGE[api]));
conferir('toda API do Chrome usada tem permissao', faltando.length === 0, faltando.map((a) => `${a} -> ${EXIGE[a]}`).join(', ') || [...apisUsadas].sort().join(', '));

// ---------------------------------------------------------------------------
// 4. arquivos citados no manifesto existem
// ---------------------------------------------------------------------------

const citados = new Set();
const colher = (valor) => {
  if (typeof valor === 'string' && /\.(png|html|js|css|json)$/.test(valor)) citados.add(valor);
  else if (Array.isArray(valor)) valor.forEach(colher);
  else if (valor !== null && typeof valor === 'object') Object.values(valor).forEach(colher);
};
colher(manifesto);
const ausentes = [...citados].filter((rel) => !fs.existsSync(path.join(EXT, rel)));
conferir('todo arquivo citado no manifesto existe', ausentes.length === 0, ausentes.join(', ') || `${citados.size} arquivos`);

// ---------------------------------------------------------------------------
// 5. imports relativos resolvem
// ---------------------------------------------------------------------------

const modulos = ['sw.js', 'comum.js', 'injecao.js', 'quadros.js', 'painel/painel.js', 'painel/api.js', 'painel/transcrito.js', 'painel/markdown.js'];
const importsQuebrados = [];
for (const rel of modulos) {
  const fonte = ler(rel);
  for (const achado of fonte.matchAll(/from\s+'(\.[^']+)'/g)) {
    const alvo = path.resolve(path.dirname(path.join(EXT, rel)), achado[1]);
    if (!fs.existsSync(alvo)) importsQuebrados.push(`${rel} -> ${achado[1]}`);
  }
}
conferir('todo import relativo aponta para arquivo existente', importsQuebrados.length === 0, importsQuebrados.join(', ') || `${modulos.length} modulos`);

// ---------------------------------------------------------------------------
// 7. tipos de mensagem: o que o painel manda tem de ser tratado pelo worker
// ---------------------------------------------------------------------------

/*
 * `chrome.runtime.sendMessage` que não casa com nenhum `case` cai no `default` do
 * worker e volta como erro genérico. Como o painel trata erro mostrando texto, um
 * nome torto vira uma mensagem estranha na tela em vez de um teste vermelho, e por
 * isso a conferência existe.
 */
const tratados = new Set([...sw.matchAll(/case\s+'([^']+)'/g)].map((m) => m[1]));
const enviados = new Set(
  [...painel.matchAll(/servico\(\{\s*tipo:\s*'([^']+)'/g)].map((m) => m[1]),
);
const naoTratados = [...enviados].filter((tipo) => !tratados.has(tipo));
conferir('todo tipo de mensagem enviado pelo painel tem `case` no worker', naoTratados.length === 0, naoTratados.join(', ') || [...enviados].sort().join(', '));

const nuncaEnviados = [...tratados].filter((tipo) => !enviados.has(tipo));
console.log(`  info  ${tratados.size} tipos tratados no worker, ${nuncaEnviados.length} sem envio do painel${nuncaEnviados.length === 0 ? '' : `: ${nuncaEnviados.join(', ')}`}`);

// ---------------------------------------------------------------------------
// 8. o painel é standalone (sem import de módulo de fundo)
// ---------------------------------------------------------------------------

const proibidos = ['sw.js', 'injecao.js'];
const citaFundo = proibidos.filter((nome) => painel.includes(nome));
conferir('o painel nao depende do service worker', citaFundo.length === 0, citaFundo.join(', ') || 'sem referencia');

// ---------------------------------------------------------------------------
// 9. as funções injetadas são autossuficientes
// ---------------------------------------------------------------------------

/*
 * `chrome.scripting.executeScript` serializa SÓ o corpo da função: qualquer
 * fechamento (variável ou função de fora) quebra na página com "X is not
 * defined", e isso só aparece quando o usuário manda ler ou agir. A conferência
 * aqui é grosseira de propósito: procura, no corpo das duas funções, nomes
 * livres que não sejam declarados dentro delas.
 */
function corpoDaFuncao(fonte, nome) {
  const inicio = fonte.indexOf(`function ${nome}(`);
  if (inicio < 0) return null;
  let i = fonte.indexOf('{', inicio);
  let profundidade = 0;
  for (let p = i; p < fonte.length; p += 1) {
    if (fonte[p] === '{') profundidade += 1;
    else if (fonte[p] === '}') {
      profundidade -= 1;
      if (profundidade === 0) return fonte.slice(i, p + 1);
    }
  }
  return null;
}

const PERMITIDOS = new Set([
  'window', 'document', 'globalThis', 'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Set', 'Map',
  'WeakMap', 'WeakSet', 'Promise', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol', 'Proxy', 'Reflect',
  'Infinity', 'NaN', 'undefined', 'null', 'true', 'false', 'arguments',
  'this', 'return', 'typeof', 'instanceof', 'new', 'await', 'async', 'yield', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'var', 'let', 'const', 'function', 'class', 'in', 'of',
  'delete', 'void', 'static', 'get', 'set', 'default', 'export', 'import', 'from', 'as', 'extends', 'super', 'with',
  'Element', 'Node', 'NodeList', 'NodeFilter', 'HTMLElement', 'HTMLCollection', 'Event', 'EventTarget', 'CustomEvent',
  'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'FocusEvent', 'WheelEvent', 'ClipboardEvent', 'DragEvent',
  'TouchEvent', 'UIEvent', 'CompositionEvent', 'getComputedStyle', 'matchMedia', 'scrollTo', 'scrollBy', 'alert',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'XMLSerializer', 'Range', 'Selection',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'structuredClone', 'atob', 'btoa',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'Intl', 'navigator', 'location', 'history', 'screen', 'performance', 'crypto', 'fetch', 'Headers', 'Request', 'Response',
  'FormData', 'Blob', 'File', 'FileReader', 'FileList', 'DataTransfer', 'Image', 'Audio', 'CSS', 'localStorage', 'sessionStorage',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLButtonElement', 'HTMLAnchorElement',
  'HTMLFormElement', 'HTMLImageElement', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLIFrameElement', 'HTMLTableElement',
  'HTMLScriptElement', 'HTMLStyleElement', 'HTMLVideoElement', 'HTMLCanvasElement', 'SVGElement', 'XPathResult', 'XPathEvaluator',
  'process', 'Buffer', 'chrome', 'browser', 'exportar', 'module', 'require', 'global',
  // marcador do próprio `limpar`: sobra no lugar de cada expressão regular
  'REGEX',
  // A limpeza de template literal é best-effort: template DENTRO de template
  // (`... ${a ? ` ${b}` : ''} ...`) deixa um `$` solto para trás. `$` sozinho
  // nunca é identificador, então entra na lista em vez de virar falso positivo.
  '$',
]);

/** Tira comentários, literais de texto, expressões regulares e chaves de objeto. */
function limpar(corpo) {
  return (
    corpo
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(?<![:\\])\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      // literal de expressão regular (com ou sem flags): sem isso, `s`, `g`, `i`
      // e o próprio conteúdo da regex entram como "nomes livres"
      .replace(/(?<![\w$)\]])<\//g, '<\\/')
      .replace(/(?<![\w$)\]])\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, 'REGEX')
      // chave de objeto literal: `nome:` logo depois de `{` ou `,`, e sem `?`
      .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)(\s*:)/g, '$1$3')
  );
}

/** Nomes declarados na lista de parâmetros da função, inclusive desestruturados. */
function parametrosDe(fonte, nome) {
  const inicio = fonte.indexOf(`function ${nome}(`);
  if (inicio < 0) return new Set();
  const abre = fonte.indexOf('(', inicio);
  let profundidade = 0;
  let fecha = -1;
  for (let i = abre; i < fonte.length; i += 1) {
    if (fonte[i] === '(') profundidade += 1;
    else if (fonte[i] === ')') {
      profundidade -= 1;
      if (profundidade === 0) {
        fecha = i;
        break;
      }
    }
  }
  const lista = fonte.slice(abre + 1, fecha);
  const nomes = new Set();
  for (const pedaco of lista.replace(/[{}[\]]/g, ' ').split(',')) {
    const limpo = pedaco.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
    if (/^[a-zA-Z_$][\w$]*$/.test(limpo)) nomes.add(limpo);
  }
  return nomes;
}

for (const nome of ['lerNaPagina', 'localizarNaPagina', 'rolarNaPagina', 'lerParaCopiar', 'agirNaPagina', 'medirParaPrint']) {
  const corpo = corpoDaFuncao(injecao, nome);
  if (corpo === null) {
    conferir(`corpo de ${nome} encontrado em injecao.js`, false);
    continue;
  }
  // Nomes citados como propriedade (depois de ponto) não contam.
  const semPropriedades = limpar(corpo).replace(/\.\s*[a-zA-Z_$][\w$]*/g, '.');
  const livres = new Set(
    [...semPropriedades.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)/g)]
      .map((m) => m[1])
      .filter((palavra) => !PERMITIDOS.has(palavra)),
  );
  const declarados = new Set([
    ...corpo.matchAll(/\b(?:const|let|var|function|class)\s+([a-zA-Z_$][\w$]*)/g),
  ].map((m) => m[1]));
  // nomes declarados por desestruturação: `const { a, b } = ...`
  for (const achado of corpo.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const pedaco of achado[1].split(',')) {
      const limpo = pedaco.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(limpo)) declarados.add(limpo);
    }
  }
  for (const parametro of parametrosDe(injecao, nome)) declarados.add(parametro);
  // parâmetros das funções e setas de dentro do corpo (auxiliares aninhados)
  for (const lista of semPropriedades.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const pedaco of lista[1].split(',')) {
      const limpo = pedaco.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(limpo)) declarados.add(limpo);
    }
  }
  // `function nome(...)` aninhada, e `catch (erro)`
  for (const achado of semPropriedades.matchAll(/\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    declarados.add(achado[1]);
    for (const pedaco of achado[2].split(',')) {
      const limpo = pedaco.trim().split(/[=:]/)[0].trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(limpo)) declarados.add(limpo);
    }
  }
  for (const achado of semPropriedades.matchAll(/\bcatch\s*\(([^)]*)\)/g)) {
    const limpo = achado[1].trim();
    if (/^[a-zA-Z_$][\w$]*$/.test(limpo)) declarados.add(limpo);
  }
  const suspeitos = [...livres].filter((palavra) => !declarados.has(palavra));
  conferir(`${nome} nao cita nada de fora`, suspeitos.length === 0, suspeitos.slice(0, 12).join(', ') || `${corpo.length} bytes`);
}

// ---------------------------------------------------------------------------
// 10. o painel abre na barra lateral, sem perder o gesto do usuario
// ---------------------------------------------------------------------------

/*
 * `chrome.sidePanel.open` so vale dentro do gesto do usuario: qualquer `await`
 * antes dela consome o gesto, a chamada lanca, o `catch` cai na janela destacada
 * e o painel aparece no Alt+Tab. Foi o defeito medido em 04/11/2026, e nenhum
 * `node --check` pega isso, porque e sintaticamente valido.
 */
console.log('');
const corpoAbrir = corpoDaFuncao(sw, 'abrirPainel') ?? '';
const posicaoOpen = corpoAbrir.indexOf('chrome.sidePanel.open');
const antesDoOpen = posicaoOpen < 0 ? corpoAbrir : corpoAbrir.slice(0, posicaoOpen);
// O `await` que precede a propria chamada nao conta: ele e a forma correta de
// chamar dentro do gesto. Qualquer outro `await` antes e o defeito.
const antesSemOProprioAwait = antesDoOpen.replace(/await\s*$/, '');
conferir('abrirPainel chama chrome.sidePanel.open', posicaoOpen > 0);
conferir(
  'nada de `await` antes de sidePanel.open',
  antesSemOProprioAwait.includes('await') === false,
  antesSemOProprioAwait.includes('await') ? 'tem await antes' : 'gesto preservado',
);
conferir('nao pede a janela com await antes do open', antesDoOpen.includes('chrome.windows.getCurrent') === false);
conferir('o open usa o windowId que chega pronto', /sidePanel\.open\(\{\s*windowId:/.test(corpoAbrir), 'windowId direto');
conferir('o id da janela sai de um helper sincrono', corpoAbrir.includes('janelaDaAba('));

const clique = /chrome\.action\.onClicked\.addListener\(\((\w+)\)/.exec(sw);
conferir('o listener do icone recebe a aba', clique !== null && clique[1] !== '', clique?.[1] ?? 'sem parametro');
const comando = /chrome\.commands\.onCommand\.addListener\(\((\w+),\s*(\w+)\)/.exec(sw);
conferir('o listener do atalho recebe a aba', comando !== null, comando === null ? 'so o comando' : `${comando[1]}, ${comando[2]}`);

const corpoComando =
  sw.slice(sw.indexOf('chrome.commands.onCommand.addListener'), sw.indexOf('// ---', sw.indexOf('chrome.commands.onCommand.addListener')) < 0
    ? undefined
    : sw.indexOf('// ---', sw.indexOf('chrome.commands.onCommand.addListener'))) ?? '';
conferir('o atalho abre o painel antes de qualquer await', /abrirPainel\(/.test(corpoComando) && corpoComando.indexOf('abrirPainel(') < (corpoComando.indexOf('await') < 0 ? corpoComando.length : corpoComando.indexOf('await')));

conferir('o comportamento nativo do icone e ligado', /setPanelBehavior\(\{\s*openPanelOnActionClick:\s*true/.test(sw));
/*
 * `sidebar_action` e chave do Firefox. O Opera nunca a implementou e o Chrome a
 * acusa como "Unrecognized manifest key" no cartao da extensao (visto em
 * 04/11/2026, na versao 0.2.0). Enquanto ela estiver aqui, o cartao mostra aviso
 * em navegador nenhum ganhando a barra lateral.
 */
conferir('o manifesto nao declara sidebar_action', manifesto.sidebar_action === undefined, manifesto.sidebar_action === undefined ? 'ausente' : 'presente');
conferir(
  'a barra lateral do Chromium esta declarada',
  manifesto.side_panel?.default_path === 'painel/painel.html' && (manifesto.permissions ?? []).includes('sidePanel'),
  `side_panel=${manifesto.side_panel?.default_path ?? 'ausente'}`,
);
conferir('a migracao fecha a janela popup antiga', sw.includes('fecharJanelasDoPainel(') && /onInstalled[\s\S]{0,400}fecharJanelasDoPainel\(/.test(sw));

// ---------------------------------------------------------------------------
// 11. as abas e o print existem nos dois lados
// ---------------------------------------------------------------------------

console.log('');
const ferramentas = fs.readFileSync(path.join(EXT, '..', 'plugin', 'ferramentas.js'), 'utf8');
const casos = new Set([...sw.matchAll(/case\s+'([^']+)'/g)].map((m) => m[1]));
conferir("o worker trata o pedido de lista de abas", casos.has('abas'));
conferir("o worker trata navegacao em aba nova", casos.has('navegar-nova'));
conferir('o worker devolve a aba nova com id', /case 'navegar-nova'[\s\S]{0,1200}chrome\.tabs\.create\(/.test(sw));
conferir('o painel resolve a aba do pedido', painel.includes('abaAlvoDoPedido(') && painel.includes('casarAba('));
conferir('o painel lista as abas com marca de fixada', /servico\(\{\s*tipo:\s*'abas'\s*\}\)/.test(painel) && painel.includes('fixada:'));
conferir('o painel atende print', painel.includes("pedido?.tipo === 'print'") && painel.includes('montarPaginaInteira('));
conferir('o print de pagina inteira costura as fatias', painel.includes('createImageBitmap(') && painel.includes('toDataURL('));
conferir('o painel fixa a aba nova', painel.includes('fixarAba(') && /navegarEmAbaNova[\s\S]{0,600}fixarAba\(/.test(painel));

conferir("a ferramenta navegador_abas existe", /name: 'navegador_abas'/.test(ferramentas));
conferir("a ferramenta navegador_print existe", /name: 'navegador_print'/.test(ferramentas));
conferir('a ferramenta de print devolve imagem', /name: 'navegador_print'[\s\S]{0,4000}type: 'image',\s*\n\s*attachment:/.test(ferramentas));
conferir('a ferramenta de print grava o arquivo', ferramentas.includes('caminhoDoPrint(') && ferramentas.includes('writeFileSync(arquivo, bytes)'));
conferir('ler e agir aceitam o parametro aba', (ferramentas.match(/type: 'string',\s*\n\s*description:\s*\n?\s*'Aba alvo:/g) ?? []).length + (ferramentas.match(/Aba alvo: id em numero/g) ?? []).length >= 3);
conferir('agir aceita nova_aba', ferramentas.includes('nova_aba: {') && ferramentas.includes('pedido.novaAba = true'));
conferir('a saida da acao declara pendente', /const SAIDA_ACAO = \{[\s\S]{0,900}pendente: \{ type: 'boolean' \}/.test(ferramentas));
conferir('a leitura informa ativa e fixada', /const ABA_SCHEMA = \{[\s\S]{0,600}ativa: \{ type: 'boolean' \}/.test(ferramentas) && ferramentas.includes('janela: { type: '));

// ---------------------------------------------------------------------------
// 12. iframe, rolagem em container, digitação e cópia (04/11/2026)
// ---------------------------------------------------------------------------

console.log('');
const quadros = ler('quadros.js');
const transferencia = fs.readFileSync(path.join(EXT, '..', 'plugin', 'transferencia.js'), 'utf8');

conferir('o módulo de quadros existe e exporta a composição', /export function comporTextoDosQuadros/.test(quadros) && /export function escolherQuadroParaAcao/.test(quadros));
conferir('a leitura roda em todos os quadros', sw.includes('injetarEmQuadros(') && sw.includes('getAllFrames') && sw.includes('MAX_QUADROS'));
conferir('a leitura compõe os quadros pelo módulo', sw.includes('comporTextoDosQuadros(') && sw.includes('comporElementosDosQuadros(') && sw.includes('comporRolagemDosQuadros('));
conferir('a marca do elemento inclui o id do quadro', injecao.includes('el.setAttribute(marca, `${id}:${n}`)') && injecao.includes('document.querySelectorAll(`[${marca}]`)'));
conferir('a leitura tem o modo rolagem', sw.includes("oQue === 'rolagem'") && injecao.includes("oQue === 'rolagem'"));
conferir('a ação resolve o quadro antes de agir', sw.includes('escolherQuadroParaAcao(') && sw.includes('escolherQuadroDeRolagem(') && sw.includes('escolherQuadroDeTexto('));
conferir('a rolagem usa a função de container', sw.includes('rolarNaPagina,') && /acao === 'rolar'[\s\S]{0,1200}rolarNaPagina/.test(sw));
conferir('a rolagem não é mais window.scrollBy solto no agir', injecao.includes('scrollBy({ top: delta') && sw.includes("modo: 'procurar'"));
conferir('a digitação dispara eventos nativos e confere o valor', injecao.includes("new InputEvent('beforeinput'") && injecao.includes('verificado') && injecao.includes("modo === 'teclas'"));
conferir('a cópia lê o texto no worker e grava no painel', sw.includes('lerParaCopiar') && painel.includes('atenderCopiar(') && painel.includes('concluirCopia('));
conferir('o painel tem a função de copiar com três caminhos', painel.includes('copiarParaAreaDeTransferencia(') && painel.includes("'navigator.clipboard'") && painel.includes("'execCommand'"));
conferir('o host tem o fallback de área de transferência', transferencia.includes('Set-Clipboard') && transferencia.includes('[Console]::In.ReadToEnd()'));
conferir('o host copia por stdin, nunca por argv', transferencia.includes('processo.stdin?.end(') && transferencia.includes("'Set-Clipboard -Value $texto'"));
conferir('o painel despacha o pedido de copiar', /pedido\?\.tipo === 'copiar'/.test(painel) && /async function atenderCopiar/.test(painel));
conferir('a ação copiar sai do agir com o resultado copiado', /pedido\.acao === 'copiar'[\s\S]{0,200}concluirCopia/.test(painel));
conferir('o painel manda o quadro escolhido ao agir', painel.includes("{ quadro: pedido.quadro }"));

conferir('o painel tem o diálogo de abas', idsNoHtml.has('abas') && idsNoHtml.has('btn-abas') && idsNoHtml.has('lista-abas') && painel.includes('abrirListaDeAbas('));
conferir('o diálogo de abas lista várias janelas', painel.includes('recarregarAbas(') && painel.includes('janelas.size > 1'));
conferir('a aba fixada é lembrada', comum.includes('CHAVE_ABA_FIXADA') && painel.includes('lerAbaFixada(') && painel.includes('salvarAbaFixada('));
conferir('o worker olha a última janela normal em foco', sw.includes('getLastFocused({ windowTypes') && sw.includes('chrome.windows.onFocusChanged'));
conferir('o painel acompanha a troca de janela', painel.includes('chrome.windows?.onFocusChanged?.addListener'));

conferir('o manifesto libera as duas permissões de clipboard', (manifesto.permissions ?? []).includes('clipboardRead') && (manifesto.permissions ?? []).includes('clipboardWrite'));
conferir('a extensão subiu para 0.3.0 ou mais', /^\d+\.\d+\.\d+$/.test(manifesto.version ?? '') && Number(String(manifesto.version).split('.')[1]) >= 3, manifesto.version);

conferir('a ferramenta navegador_copiar existe', /name: 'navegador_copiar'/.test(ferramentas));
conferir('o agir aceita copiar, quadro e modo', ferramentas.includes("'esperar', 'copiar'") && ferramentas.includes('quadro: {') && ferramentas.includes('modo: {'));
conferir('a leitura declara quadros e rolagem na saída', /quadros: \{ type: 'array', items: QUADRO_SCHEMA \}/.test(ferramentas) && /rolagem: \{ type: 'array', items: \{ type: 'string' \} \}/.test(ferramentas));

console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
process.exit(placar.falhou === 0 ? 0 : 1);
