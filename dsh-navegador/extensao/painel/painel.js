/*
 * Painel do add-on: a conversa.
 *
 * Ele e o dono unico da conexao com a ponte do DSH. O service worker so cuida do
 * que exige API de extensao (abrir o painel, injetar na aba), entao existe um
 * lugar so onde o token, a sessao e o transcrito vivem.
 *
 * Fluxo de uma mensagem:
 *   1. garante uma sessao (`session/create` na primeira vez);
 *   2. abre o `session/follow` ANTES de mandar, porque e o follow que ativa a
 *      sessao no host (o `promote` do proprio DSH);
 *   3. monta o contexto da aba, se o usuario quiser;
 *   4. manda o `session/prompt` e deixa o fluxo desenhar a resposta.
 */

import {
  autoValePara,
  CHAVE_AUTO_APROVAR,
  descobrirPonte,
  horaCurta,
  lerAbaFixada,
  lerAutoAprovar,
  lerConversa,
  lerPonte,
  lerPreferencias,
  normalizarBase,
  salvarAbaFixada,
  salvarAutoAprovar,
  salvarConversa,
  salvarPonte,
  salvarPreferencias,
  tokens,
} from '../comum.js';
import { ErroPonte, Ponte } from './api.js';
import { markdown } from './markdown.js';
import { aplicarProjecoes, aplicarQuadro, novoEstado, valoresDeProjecoes } from './transcrito.js';

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const tela = {
  ponto: el('ponto'),
  situacao: el('situacao-texto'),
  titulo: el('titulo-sessao'),
  medidores: el('medidores'),
  faixaAba: el('faixa-aba'),
  abaNome: el('aba-nome'),
  usarAba: el('btn-usar-aba'),
  btnAbas: el('btn-abas'),
  abas: el('abas'),
  listaAbas: el('lista-abas'),
  buscaAba: el('busca-aba'),
  abasResumo: el('abas-resumo'),
  usarAbaDialogo: el('btn-usar-aba-dialogo'),
  atualizarAbas: el('btn-atualizar-abas'),
  transcrito: el('transcrito'),
  vazio: el('vazio'),
  pendencias: el('pendencias'),
  faixaAuto: el('faixa-auto'),
  btnAuto: el('btn-auto'),
  btnAutoDesligar: el('btn-auto-desligar'),
  texto: el('texto'),
  dica: el('dica'),
  enviar: el('btn-enviar'),
  parar: el('btn-parar'),
  btnAba: el('btn-aba'),
  btnPrint: el('btn-print'),
  btnSelecao: el('btn-selecao'),
  btnLimpar: el('btn-limpar'),
  btnSessao: el('btn-sessao'),
  btnAjustes: el('btn-ajustes'),
  ajustes: el('ajustes'),
  sessoes: el('sessoes'),
  listaSessoes: el('lista-sessoes'),
  buscaSessao: el('busca-sessao'),
  cfgBase: el('cfg-base'),
  cfgToken: el('cfg-token'),
  cfgCwd: el('cfg-cwd'),
  cfgPreset: el('cfg-preset'),
  cfgRolar: el('cfg-rolar'),
  cfgEstado: el('cfg-estado'),
};

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const ui = {
  ponte: null,
  estado: novoEstado(),
  config: { baseUrl: '', token: '' },
  preferencias: {},
  aba: null,
  abaAtiva: null,
  conectado: false,
  autorizado: false,
  turnoAtivo: false,
  abortoFluxo: null,
  abortoPedidos: null,
  sessaoAtual: null,
  nos: new Map(),
  noVivo: null,
  localPendente: null,
  pedidos: new Map(),
  perguntasNos: new Map(),
  autoAprovar: false,
  renderAgendado: false,
  marcas: new Set(),
  presetEscolhido: '',
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fala com o service worker e desembrulha a resposta. */
async function servico(mensagem) {
  const resposta = await chrome.runtime.sendMessage(mensagem);
  if (resposta?.ok === true) return resposta.valor;
  throw new Error(resposta?.erro ?? 'o service worker não respondeu');
}

function situacao(texto, classe = '') {
  tela.situacao.textContent = texto;
  tela.ponto.className = `ponto ${classe}`.trim();
}

function dica(texto) {
  tela.dica.textContent = texto ?? '';
}

function larguraDe(n) {
  return `${n} caracteres`;
}

// ---------------------------------------------------------------------------
// Conexao
// ---------------------------------------------------------------------------

/**
 * Conecta na ponte: tenta o endereco configurado, descobre se preciso e pareia
 * quando ainda nao ha token valido.
 */
async function conectar(silencioso = false) {
  if (!silencioso) situacao('Procurando a ponte...', 'trabalhando');
  ui.conectado = false;
  ui.autorizado = false;
  let base = ui.config.baseUrl;
  let token = ui.config.token;

  let ponte = new Ponte(base, token);
  let ola = null;
  try {
    ola = await ponte.ola();
  } catch {
    const achada = await descobrirPonte(base);
    if (achada === null) {
      situacao('ponte não encontrada: o DSH está aberto nesta máquina?', 'erro');
      dica('Sem a ponte o painel não conversa. Confira o endereço nos ajustes.');
      return false;
    }
    base = achada.baseUrl;
    ponte = new Ponte(base, token);
    ola = await ponte.ola();
  }
  /*
   * A pasta que a metade host prepara para as conversas do add-on. É o `cwd`
   * delas que dá o nome do grupo na barra lateral do DSH: sem pasta própria, o
   * DSH joga as conversas do navegador em "Ungrouped".
   */
  ui.config = { ...ui.config, cwdConversas: ola?.addon?.cwd ?? ui.config.cwdConversas ?? '' };

  // Sem token, ou token recusado: pareia. O `/parear` so responde de loopback.
  if (token === '') {
    try {
      const dado = await ponte.parear();
      token = dado.token;
    } catch (erro) {
      situacao(`não consegui parear: ${erro.message}`, 'erro');
      return false;
    }
  }
  try {
    await ponte.sinal();
  } catch (erro) {
    if (erro instanceof ErroPonte && erro.codigo === 'http/401') {
      try {
        const dado = await ponte.parear();
        token = dado.token;
      } catch (erro2) {
        situacao(`token recusado: ${erro2.message}`, 'erro');
        return false;
      }
    } else {
      situacao(`a ponte respondeu com erro: ${erro.message}`, 'erro');
      return false;
    }
  }

  ui.ponte = ponte;
  ui.config = { baseUrl: base, token };
  ui.conectado = true;
  ui.autorizado = true;
  await salvarPonte(ui.config);
  situacao('conectado', 'ok');
  preencherAjustes();
  assinarPedidos();
  anunciarAba();
  return true;
}

/** Mantem a assinatura do canal de pedidos do agente, reconectando sozinha. */
async function assinarPedidos() {
  ui.abortoPedidos?.abort();
  const ac = new AbortController();
  ui.abortoPedidos = ac;
  const ponte = ui.ponte;

  while (!ac.signal.aborted && ui.ponte === ponte) {
    try {
      await ponte.pedidos((mensagem) => tratarMensagemDePedido(mensagem), ac.signal);
    } catch (erro) {
      if (ac.signal.aborted) return;
      await espera(2000);
    }
    if (ac.signal.aborted || ui.ponte !== ponte) return;
    await espera(1200);
  }
}

// ---------------------------------------------------------------------------
// Aba
// ---------------------------------------------------------------------------

/** Descobre a aba ativa e guarda para comparar com a aba alvo. */
async function atualizarAbaAtiva() {
  try {
    ui.abaAtiva = await servico({ tipo: 'aba-atual' });
  } catch {
    ui.abaAtiva = null;
  }
  /*
   * A mesma aba pode navegar (foi o que o teste no navegador mostrou: abri a
   * Wikipédia, naveguei para outra página e o painel continuou anunciando a
   * anterior). Como o id não muda, a faixa não acusava diferença e o contexto ia
   * com a URL velha. Aqui o alvo acompanha a navegação.
   */
  if (ui.aba !== null && ui.abaAtiva !== null && ui.abaAtiva.id === ui.aba.id && ui.abaAtiva.url !== ui.aba.url) {
    ui.aba = { ...ui.abaAtiva, capturadaEm: Date.now() };
    await anunciarAba();
  }
  desenharFaixaAba();
}

/** Adota a aba ativa como alvo. */
async function usarAbaAtual(anunciar = true) {
  await atualizarAbaAtiva();
  if (ui.abaAtiva === null) {
    dica('não achei uma aba ativa para usar');
    return;
  }
  ui.aba = { ...ui.abaAtiva, capturadaEm: Date.now() };
  desenharFaixaAba();
  salvarAbaFixada(decorarAba(ui.aba)).catch(() => undefined);
  if (anunciar && ui.ponte !== null) {
    try {
      await ui.ponte.anunciarAba(ui.aba);
    } catch {
      /* a ponte aprende a aba de novo no proximo anuncio */
    }
  }
}

async function anunciarAba() {
  if (ui.ponte === null) return;
  if (ui.aba === null) {
    await usarAbaAtual(true);
    return;
  }
  try {
    await ui.ponte.anunciarAba(ui.aba);
  } catch {
    /* silencioso: e so contexto para a ferramenta */
  }
}

function desenharFaixaAba() {
  if (ui.aba === null) {
    tela.abaNome.textContent = 'Nenhuma aba capturada';
    tela.abaNome.classList.remove('aviso');
    return;
  }
  const titulo = ui.aba.titulo === '' ? ui.aba.url : ui.aba.titulo;
  const mudou = ui.abaAtiva !== null && ui.abaAtiva.id !== ui.aba.id;
  tela.abaNome.textContent = mudou ? `${titulo} (não é a aba ativa)` : titulo;
  tela.abaNome.classList.toggle('aviso', mudou);
  tela.abaNome.title = ui.aba.url;
}

// ---------------------------------------------------------------------------
// Abas do navegador
// ---------------------------------------------------------------------------

/**
 * Reduz uma aba ao que a resposta do agente precisa dizer.
 *
 * `fixada` responde à pergunta que o agente não tem como fazer sozinho: a aba
 * que ele acabou de usar é a mesma que o painel está mostrando? E `ativa` diz se
 * é a aba da frente agora, porque o agente pode ter lido uma aba de fundo.
 * @param aba - aba do service worker (`janelaId`) ou da lista (`janela`).
 * @returns `{id, url, titulo, janela, janelaId, ativa, fixada}`.
 */
function decorarAba(aba) {
  if (aba === null || aba === undefined) return null;
  const janela = Number.isSafeInteger(aba.janela)
    ? aba.janela
    : Number.isSafeInteger(aba.janelaId)
      ? aba.janelaId
      : null;
  return {
    id: Number.isSafeInteger(aba.id) ? aba.id : null,
    url: typeof aba.url === 'string' ? aba.url : '',
    titulo: typeof aba.titulo === 'string' ? aba.titulo : '',
    janela,
    janelaId: janela,
    ativa: aba.ativa === true,
    fixada: ui.aba !== null && Number.isSafeInteger(aba.id) && aba.id === ui.aba.id,
  };
}

/** Lista as abas do navegador, com a marca de qual está fixada no painel. */
async function listarAbas() {
  const abas = await servico({ tipo: 'abas' });
  if (!Array.isArray(abas)) return [];
  return abas.map((aba) => ({ ...decorarAba(aba), indice: Number.isSafeInteger(aba.indice) ? aba.indice : 0 }));
}

/** Texto comparável: sem acento e sem caixa. */
function normalizarTexto(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Uma aba numa linha, para o agente e para a mensagem de erro. */
function etiquetaDaAba(aba) {
  const titulo = aba.titulo === '' ? '(sem titulo)' : aba.titulo;
  const marcas = [];
  if (aba.ativa === true) marcas.push('ativa');
  if (aba.fixada === true) marcas.push('fixada no painel');
  return `${aba.id} | ${titulo} | ${aba.url}${marcas.length === 0 ? '' : ` | ${marcas.join(', ')}`}`;
}

/**
 * Casa o alvo pedido pelo agente com uma aba aberta.
 *
 * O alvo pode vir como id (só dígitos) ou como trecho do título ou da URL, sem
 * acento e sem caixa. Quando o trecho casa com mais de uma aba, a preferência é
 * a fixada, depois a ativa, e só então o erro com a lista: escolher a primeira
 * da lista em silêncio foi o que faria o agente agir na aba errada.
 * @param abas - lista de `listarAbas()`.
 * @param alvo - id em texto ou trecho de título/URL.
 * @returns a aba escolhida.
 * @throws {Error} quando não casa ou quando é ambíguo.
 */
function casarAba(abas, alvo) {
  if (abas.length === 0) throw new Error('o navegador nao tem nenhuma aba para usar');
  const bruto = String(alvo ?? '').trim();
  if (/^\d+$/.test(bruto)) {
    const id = Number(bruto);
    const porId = abas.find((aba) => aba.id === id);
    if (porId !== undefined) return porId;
    throw new Error(`nao achei a aba ${id}. Abas abertas: ${abas.map(etiquetaDaAba).join(' ; ')}`);
  }
  const busca = normalizarTexto(bruto);
  if (busca === '') throw new Error('parametro aba vazio');
  const achadas = abas.filter(
    (aba) => normalizarTexto(aba.titulo).includes(busca) || normalizarTexto(aba.url).includes(busca),
  );
  if (achadas.length === 1) return achadas[0];
  const fixada = achadas.find((aba) => aba.fixada === true);
  if (fixada !== undefined) return fixada;
  const ativa = achadas.find((aba) => aba.ativa === true);
  if (ativa !== undefined) return ativa;
  if (achadas.length === 0) {
    throw new Error(`nenhuma aba casa com "${bruto}". Abas abertas: ${abas.map(etiquetaDaAba).join(' ; ')}`);
  }
  throw new Error(
    `"${bruto}" casa com ${achadas.length} abas: ${achadas.map(etiquetaDaAba).join(' ; ')}. Passe o id da aba.`,
  );
}

/**
 * Aba alvo de um pedido do agente.
 *
 * Sem o parâmetro `alvo`, vale a aba fixada no painel, que é o comportamento
 * antigo. Com ele, a aba é resolvida NA HORA do pedido: a lista pode ter mudado
 * desde a última leitura do agente.
 * @param pedido - pedido vindo da ponte.
 * @returns a aba alvo decorada.
 * @throws {Error} quando não há aba fixada nem casa com o alvo.
 */
async function abaAlvoDoPedido(pedido) {
  const alvo = pedido?.alvo;
  if (alvo === undefined || alvo === null || String(alvo).trim() === '') {
    if (ui.aba === null) {
      throw new Error(
        'o painel nao tem aba fixada. Chame navegador_abas e passe o parametro aba, ou clique em "usar a aba atual" no painel',
      );
    }
    return decorarAba(ui.aba);
  }
  return casarAba(await listarAbas(), alvo);
}

/** Fixa uma aba no painel, conta isso à ponte e lembra a escolha. */
async function fixarAba(aba) {
  const decorada = decorarAba(aba);
  // `fixada` é calculado contra a aba anterior; depois de fixar, a nova é a fixada.
  ui.aba = { ...aba, ...decorada, fixada: true, capturadaEm: Date.now() };
  desenharFaixaAba();
  // A escolha sobrevive a fechar e reabrir a barra lateral; a aba em si pode ter
  // sumido, e quem restaura confere contra a lista viva antes de adotar.
  salvarAbaFixada(decorada).catch(() => undefined);
  if (ui.ponte !== null) {
    try {
      await ui.ponte.anunciarAba(ui.aba);
    } catch {
      /* a ponte aprende a aba de novo no proximo anuncio */
    }
  }
  return decorarAba(ui.aba);
}

/**
 * Abre o diálogo de abas, com TODAS as janelas do Chrome.
 *
 * É a resposta ao defeito de 04/11/2026: o painel só sabia fixar a aba ativa da
 * janela que ele mesmo estava usando, então com duas janelas abertas não havia
 * como escolher a aba da outra. Aqui a lista vem do service worker
 * (`chrome.tabs.query({})`), agrupada por janela, com a fixada e a ativa em cima.
 */
async function abrirListaDeAbas() {
  tela.abas.showModal();
  await recarregarAbas();
  tela.buscaAba.focus();
}

/** Redesenha a lista de abas do diálogo, filtrando pelo texto digitado. */
async function recarregarAbas() {
  try {
    const abas = await listarAbas();
    const termo = normalizarTexto(tela.buscaAba.value);
    const filtradas =
      termo === ''
        ? abas
        : abas.filter((aba) => normalizarTexto(aba.titulo).includes(termo) || normalizarTexto(aba.url).includes(termo));
    const janelas = new Set(abas.map((aba) => aba.janela));
    const ordenadas = [...filtradas].sort((a, b) => {
      if ((a.fixada === true) !== (b.fixada === true)) return a.fixada === true ? -1 : 1;
      if ((a.ativa === true) !== (b.ativa === true)) return a.ativa === true ? -1 : 1;
      if (a.janela !== b.janela) return (a.janela ?? 0) - (b.janela ?? 0);
      return a.indice - b.indice;
    });
    const nos = ordenadas.map((aba) => {
      const botao = document.createElement('button');
      botao.className = 'linha-sessao';
      if (aba.fixada === true) botao.classList.add('atual');
      const titulo = document.createElement('span');
      titulo.className = 'titulo';
      const nome = aba.titulo === '' ? '(sem título)' : aba.titulo;
      titulo.append(document.createTextNode(nome));
      if (aba.fixada === true) {
        const marca = document.createElement('span');
        marca.className = 'aba-marca';
        marca.textContent = 'fixada';
        titulo.append(marca);
      }
      const meta = document.createElement('span');
      meta.className = 'meta';
      const pedacos = [aba.url];
      if (aba.ativa === true) pedacos.push('aba ativa agora');
      if (janelas.size > 1) pedacos.push(`janela ${aba.janela ?? '?'}`);
      meta.textContent = pedacos.join(' · ');
      botao.append(titulo, meta);
      botao.addEventListener('click', async () => {
        await fixarAba(aba);
        registrarStatus(`o painel passou a fixar a aba ${aba.id} (${aba.titulo === '' ? aba.url : aba.titulo})`);
        tela.abas.close();
      });
      return botao;
    });
    tela.abasResumo.textContent =
      `${abas.length} aba(s) em ${janelas.size} janela(s)` +
      (ui.aba === null ? ' · nenhuma fixada' : ` · fixada agora: ${ui.aba.titulo === '' ? ui.aba.url : ui.aba.titulo}`);
    tela.listaAbas.replaceChildren(...(nos.length > 0 ? nos : [textoSimples('nenhuma aba encontrada')]));
  } catch (erro) {
    tela.listaAbas.replaceChildren(textoSimples(`não consegui listar: ${erro.message}`));
  }
}

// ---------------------------------------------------------------------------
// Área de transferência
// ---------------------------------------------------------------------------

/**
 * Escreve texto na área de transferência.
 *
 * O clique sintético do agente não conta como ativação de usuário, então
 * `navigator.clipboard` pode recusar. A ordem aqui é: API do Chrome (o painel é
 * página da extensão e tem a permissão `clipboardWrite`), `execCommand('copy')` e,
 * por último, quem chamou cai no host (ver `navegador_copiar` no plugin), que
 * escreve pela área de transferência do sistema.
 * @param texto - o que copiar.
 * @returns `{metodo, conferido}`; `conferido` é `false` quando não deu para reler.
 */
async function copiarParaAreaDeTransferencia(texto) {
  const valor = String(texto ?? '');
  if (valor === '') throw new Error('nada para copiar');
  const tentativas = [];
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(valor);
      return { metodo: 'navigator.clipboard', conferido: await conferirAreaDeTransferencia(valor) };
    } catch (erro) {
      tentativas.push(`navigator.clipboard: ${erro.message}`);
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = valor;
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.append(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy') === true;
    area.remove();
    if (ok) return { metodo: 'execCommand', conferido: await conferirAreaDeTransferencia(valor) };
    tentativas.push('execCommand devolveu false');
  } catch (erro) {
    tentativas.push(`execCommand: ${erro.message}`);
  }
  throw new Error(`a area de transferencia recusou o texto (${tentativas.join('; ')})`);
}

/** Lê a área de transferência, para conferir o que acabou de ser copiado. */
async function lerAreaDeTransferencia() {
  try {
    if (navigator.clipboard?.readText !== undefined) return String(await navigator.clipboard.readText());
  } catch {
    /* sem permissão ou sem foco: a cópia vale, só a conferência falha */
  }
  return '';
}

/** Diz se o texto está na área de transferência. Falha de leitura conta como não conferida. */
async function conferirAreaDeTransferencia(esperado) {
  const lido = await lerAreaDeTransferencia();
  return lido === esperado;
}

/** Atende o pedido de copiar texto do agente (`navegador_copiar`). */
async function atenderCopiar(pedido) {
  try {
    const texto = String(pedido?.texto ?? '');
    const copia = await copiarParaAreaDeTransferencia(texto);
    await ui.ponte.responder({
      id: pedido.id,
      ok: true,
      valor: { copiado: true, metodo: copia.metodo, conferido: copia.conferido, bytes: texto.length, resumo: `copiei ${texto.length} caractere(s)` },
    });
    registrarStatus(`o agente copiou ${texto.length} caractere(s) para a area de transferencia (${copia.metodo})`);
  } catch (erro) {
    await ui.ponte.responder({ id: pedido.id, ok: false, erro: erro.message });
  }
}

/** Fecha a cópia de uma ação `copiar`: grava na área de transferência. */
async function concluirCopia(resultado) {
  const texto = String(resultado?.texto ?? '');
  if (texto === '') throw new Error('nao achei texto para copiar nesta aba: selecione um trecho ou passe um seletor');
  const copia = await copiarParaAreaDeTransferencia(texto);
  const origem = typeof resultado?.origem === 'string' && resultado.origem !== '' ? ` de ${resultado.origem}` : '';
  return {
    ...resultado,
    resumo: `copiei ${texto.length} caractere(s)${origem} para a area de transferencia (${copia.metodo})`,
    copiado: true,
    metodo: copia.metodo,
    conferido: copia.conferido,
    bytes: texto.length,
  };
}

// ---------------------------------------------------------------------------
// Sessao
// ---------------------------------------------------------------------------

/**
 * Limpa um titulo de conversa que veio com o bloco de contexto dentro.
 *
 * O DSH batiza a conversa pelo comeco da primeira mensagem. Nas conversas
 * criadas antes de 17/10/2026 esse comeco era o `<contexto-da-aba>`, entao o
 * titulo saia "URL: https://news.ycom" e aparecia assim no cabecalho e na lista
 * de conversas. O bloco nao tem valor como titulo: sai inteiro, e se nao sobrar
 * nada o chamador mostra "Conversa sem titulo".
 */
function tituloLegivel(bruto) {
  let titulo = String(bruto ?? '');
  titulo = titulo.replace(/<contexto-da-aba>[\s\S]*?<\/contexto-da-aba>/g, ' ');
  // bloco que o DSH cortou no meio (o caso do titulo truncado)
  titulo = titulo.replace(/<contexto-da-aba>[\s\S]*/g, ' ');
  titulo = titulo.replace(/^\s*URL:\s*\S+\s*/i, ' ');
  titulo = titulo.replace(/^\s*T[ií]tulo:\s*/i, ' ');
  return titulo.replace(/\s+/g, ' ').trim();
}

/**
 * Legenda curta do bloco de contexto, para o transcrito nao despejar a pagina
 * inteira na conversa: "contexto da aba - Hacker News - 5.212 caracteres".
 */
function legendaDoContexto(bloco) {
  const titulo = /^T[ií]tulo:\s*(.+)$/m.exec(bloco)?.[1]?.trim() ?? '';
  const corte = bloco.indexOf('Conteúdo da página:');
  const corpo = corte < 0 ? '' : bloco.slice(corte + 'Conteúdo da página:'.length).trim();
  const partes = ['contexto da aba'];
  if (titulo !== '') partes.push(titulo.slice(0, 48));
  if (corpo !== '') partes.push(`${larguraDe(corpo.length)} de texto`);
  return partes.join(' · ');
}

/** Lista as sessoes do DSH, do jeito que a barra lateral as ve. */
async function listarSessoes() {
  const valor = await ui.ponte.valor('session/list', {});
  const itens = valor?.items ?? valor?.sessions ?? [];
  return itens.map((item) => ({
    id: item.sessionId,
    titulo: tituloLegivel(item.projections?.values?.title) || '(sem título)',
    cwd: item.cwd ?? '',
    rodando: item.running === true,
    atualizadoEm: item.updatedAt ?? 0,
  }));
}

/**
 * A conversa guardada ainda existe neste DSH?
 *
 * `session/list` é a mesma lista que a barra lateral mostra: conversa apagada,
 * arquivada ou criada em outro harness home não aparece nela. Falha da ponte
 * conta como "existe", para não trocar de conversa por um erro passageiro.
 *
 * Motivo (medido em 27/10/2026): o painel reabria a conversa guardada sem
 * conferir nada, e quando ela tinha sido apagada o `session/follow` respondia
 * `session "..." not found` para sempre. O painel só mostrava
 * "fluxo caiu (...); reconectando" e a lista de conversas ficava inútil.
 *
 * @param sessionId - id da conversa que o armazenamento guardou.
 * @returns `true` quando a conversa ainda está viva.
 */
async function sessaoExiste(sessionId) {
  try {
    const lista = await listarSessoes();
    return lista.some((sessao) => sessao.id === sessionId);
  } catch {
    return true;
  }
}

/**
 * Pasta que agrupa as conversas do add-on na barra lateral do DSH.
 *
 * A preferencia do usuario manda. Sem ela, usa a pasta que a metade host criou e
 * informa no `/ola`. Se a ponte ainda for a versao anterior (sem esse campo), cai
 * num palpite barato: a pasta de trabalho mais usada no historico mais
 * `Add-on Opera`, que e onde o add-on mora nas duas maquinas. E so um nome de
 * grupo; se nao der certo, a conversa nasce sem cwd e o DSH mostra "Ungrouped".
 * @returns caminho da pasta, ou string vazia.
 */
async function pastaDasConversas() {
  if (ui.preferencias.cwd) return ui.preferencias.cwd;
  if (ui.config.cwdConversas) return ui.config.cwdConversas;
  try {
    const contagem = new Map();
    for (const sessao of await listarSessoes()) {
      if (sessao.cwd) contagem.set(sessao.cwd, (contagem.get(sessao.cwd) ?? 0) + 1);
    }
    const maisUsada = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (maisUsada !== undefined) {
      ui.config.cwdConversas = `${maisUsada}\\Add-on Opera`;
      // o placeholder dos ajustes nasce antes desta descoberta: atualiza ele
      preencherAjustes();
      return ui.config.cwdConversas;
    }
  } catch {
    /* sem historico: segue sem pasta */
  }
  return '';
}

/**
 * Cria uma sessao e devolve o id.
 *
 * O `cwd` nao e detalhe: o DSH agrupa a conversa na barra lateral por ele. Com
 * a pasta do add-on, as conversas do navegador aparecem no grupo dela; sem cwd
 * nenhum, caem em "Ungrouped".
 *
 * Medido em 17/10/2026: `session/create` com `cwd` inexistente NAO recusa, ele
 * cria a pasta. O `catch` abaixo existe por defensividade (versao futura que
 * valide, disco somente leitura): nesse caso a conversa nasce sem `cwd` e fica em
 * "Ungrouped", que e melhor do que nao nascer.
 */
async function criarSessao() {
  const pedido = {};
  if (ui.presetEscolhido !== '') pedido.agentPreset = ui.presetEscolhido;
  const pasta = await pastaDasConversas();
  if (pasta !== '') {
    try {
      const valor = await ui.ponte.valor('session/create', { ...pedido, cwd: pasta });
      return valor.sessionId;
    } catch {
      /* cwd recusado: cai no padrao do DSH */
    }
  }
  const valor = await ui.ponte.valor('session/create', pedido);
  return valor.sessionId;
}

/** Abre uma sessao: zera a tela, assina o fluxo e passa a acompanhar. */
async function abrirSessao(sessionId) {
  ui.abortoFluxo?.abort();
  ui.sessaoAtual = sessionId;
  ui.estado = novoEstado();
  ui.estado.sessao.id = sessionId;
  limparTela();
  limparPendencias();
  // O status dizia "sem conversa" mesmo com uma conversa aberta.
  situacao('Conversa aberta', 'ok');
  dica('');
  // A autoaprovação é presa à conversa: trocar de sessão volta a pedir, e o
  // armazenamento diz se ESTA conversa já estava liberada.
  marcarAutoAprovar(false);
  await carregarAutoAprovar();
  await salvarConversa({ sessionId, titulo: '' });
  lacoFollow(sessionId);
  agendarRender(['sessao', 'itens', 'vivo', 'titulo', 'pendencias']);
  atualizarProjecoes();
}

/**
 * Conversas que ja foram trocadas por não existirem mais.
 *
 * Sem isso, uma conversa nova que também sumisse (outra limpeza no mesmo
 * minuto) faria o painel criar sessão atrás de sessão, sem parar.
 */
const sessoesResgatadas = new Set();

/** Laco do fluxo da sessao, com reconexao. */
async function lacoFollow(sessionId) {
  const ac = new AbortController();
  ui.abortoFluxo = ac;
  let tentativas = 0;
  while (!ac.signal.aborted && ui.sessaoAtual === sessionId) {
    try {
      await ui.ponte.fluxo(
        'session/follow',
        { address: { kind: 'session', sessionId }, assistantStream: true },
        (quadro) => {
          const marcas = aplicarQuadro(ui.estado, quadro);
          if (marcas.length > 0) agendarRender(marcas);
        },
        ac.signal,
      );
      tentativas = 0;
    } catch (erro) {
      if (ac.signal.aborted) return;
      /*
       * "not found" desta conversa não é falha passageira: o DSH não tem mais
       * essa sessão (apagada, arquivada fora da lista, ou de outro perfil).
       * Reconectar só repete o erro a cada 8 s, então troca por uma conversa
       * nova uma única vez e sai do laço.
       */
      if (String(erro.message).includes(sessionId) && /not found/i.test(erro.message)) {
        if (ui.sessaoAtual !== sessionId) return;
        if (sessoesResgatadas.has(sessionId)) {
          situacao(`a conversa ${sessionId} não existe mais neste DSH; escolha outra em Conversa`, 'erro');
          return;
        }
        sessoesResgatadas.add(sessionId);
        ui.sessaoAtual = null;
        situacao('a conversa anterior não existe mais neste DSH; abrindo uma nova', 'erro');
        try {
          await abrirSessao(await criarSessao());
        } catch (erroNovo) {
          situacao(`não consegui abrir outra conversa: ${erroNovo.message}`, 'erro');
        }
        return;
      }
      tentativas += 1;
      /*
       * O erro de host velho merece a instrucao junto: no DSH Desktop 0.12 o
       * gateway exige um Peer na chamada, e o host antigo devolve cru o
       * `Cannot read properties of undefined (reading 'signal')` (medido em
       * 21/10/2026). Sem esta dica, o painel repete o erro tecnico e mais nada.
       */
      const dica = /reading 'signal'/.test(erro.message) ? '. O host esta na versao antiga: feche e reabra o DSH' : '';
      situacao(`fluxo caiu (${erro.message}); reconectando${dica}`, 'erro');
      agendarRender(['itens']);
    }
    if (ac.signal.aborted || ui.sessaoAtual !== sessionId) return;
    if (tentativas > 0) await espera(Math.min(1000 * tentativas, 8000));
  }
}

/** Pede as projecoes: e por onde titulo, tokens e perguntas se atualizam. */
async function atualizarProjecoes() {
  const sessionId = ui.sessaoAtual;
  if (sessionId === null || ui.ponte === null) return;
  try {
    const valor = await ui.ponte.valor('session/projections', { sessionId });
    const valores = valoresDeProjecoes(valor);
    if (valores === null) return;
    if (ui.sessaoAtual !== sessionId) return;
    const marcas = aplicarProjecoes(ui.estado, valores);
    agendarRender([...marcas, 'pendencias']);
  } catch {
    /* projecoes sao enfeite: falhar aqui nao pode atrapalhar a conversa */
  }
}

function limparTela() {
  for (const no of ui.nos.values()) no.remove();
  ui.nos.clear();
  ui.noVivo?.remove();
  ui.noVivo = null;
  tela.vazio.hidden = ui.estado.itens.length > 0;
}

function limparPendencias() {
  for (const { no } of ui.pedidos.values()) no.remove();
  ui.pedidos.clear();
  tela.pendencias.replaceChildren();
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/** Monta o bloco de contexto da aba para ir junto com a pergunta. */
function montarContexto(leitura, comTexto) {
  const linhas = ['<contexto-da-aba>', `URL: ${leitura.url}`, `Título: ${leitura.titulo}`];
  if (typeof leitura.selecao === 'string' && leitura.selecao !== '') {
    linhas.push('', 'Seleção do usuário:', leitura.selecao);
  }
  if (comTexto && typeof leitura.texto === 'string' && leitura.texto !== '') {
    linhas.push('', 'Conteúdo da página:', leitura.texto);
  }
  linhas.push('</contexto-da-aba>');
  return linhas.join('\n');
}

/**
 * Junta o que vai no `content` do prompt.
 *
 * A pergunta vem PRIMEIRO, e o contexto depois. Não é estilo: o DSH batiza a
 * conversa pelo começo da primeira mensagem, então mandando o bloco de contexto
 * na frente a lista de conversas enchia de títulos como
 * "<contexto-da-aba> URL: https://..." (medido em 17/10/2026, na tela de
 * conversas do painel). Com a pergunta na frente o título nasce legível, e o
 * modelo lê a mensagem inteira do mesmo jeito.
 */
async function montarConteudo(pergunta) {
  const conteudo = [{ type: 'text', text: pergunta }];
  const anexarAba = tela.btnAba.classList.contains('ativo');
  const anexarPrint = tela.btnPrint.classList.contains('ativo');

  if (anexarAba || anexarPrint) {
    if (ui.aba === null) await usarAbaAtual(true);
    if (ui.aba === null) throw new Error('nenhuma aba para anexar');
  }

  if (anexarAba) {
    const leitura = await servico({ tipo: 'ler', oQue: 'selecao', abaId: ui.aba.id });
    const completo = await servico({ tipo: 'ler', oQue: 'texto', abaId: ui.aba.id, limite: 40000 });
    conteudo.push({ type: 'text', text: montarContexto({ ...completo, selecao: leitura?.selecao ?? '' }, true) });
  }

  if (anexarPrint) {
    const { dataUrl } = await servico({ tipo: 'print', abaId: ui.aba.id });
    const corte = dataUrl.indexOf(',');
    conteudo.push({ type: 'image', mediaType: 'image/png', data: dataUrl.slice(corte + 1), name: 'print-da-aba.png' });
  }

  return conteudo;
}

async function enviar() {
  const pergunta = tela.texto.value.trim();
  if (pergunta === '') return;
  if (!ui.autorizado) {
    const ok = await conectar();
    if (!ok) return;
  }

  tela.enviar.disabled = true;
  dica('preparando...');
  try {
    if (ui.sessaoAtual === null) {
      const sessionId = await criarSessao();
      await abrirSessao(sessionId);
      await espera(150);
    }

    const conteudo = await montarConteudo(pergunta);
    tela.texto.value = '';
    ui.localPendente = pergunta;
    ui.estado.itens.push({ chave: `local-${Date.now()}`, tipo: 'usuario', versao: 0, texto: pergunta, imagens: 0, local: true, hora: Date.now() });
    agendarRender(['itens']);

    // A sessao precisa estar ATIVA no host para aceitar o prompt, e quem ativa e
    // o `session/follow` (o `promote` do proprio DSH). Numa sessao recem-criada o
    // fluxo pode ainda estar subindo, entao a primeira recusa vale uma segunda
    // tentativa.
    const prompt = {
      requestId: crypto.randomUUID(),
      sessionId: ui.sessaoAtual,
      mode: 'queue',
      content: conteudo,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    try {
      await ui.ponte.valor('session/prompt', prompt);
    } catch (primeira) {
      await espera(700);
      prompt.requestId = crypto.randomUUID();
      try {
        await ui.ponte.valor('session/prompt', prompt);
      } catch {
        throw primeira;
      }
    }
    ui.turnoAtivo = true;
    dica('');
    atualizarProjecoes();
  } catch (erro) {
    dica(`não consegui enviar: ${erro.message}`);
    agendarRender(['itens']);
  } finally {
    tela.enviar.disabled = false;
    ajustarBotoes();
  }
}

async function cancelar() {
  if (ui.sessaoAtual === null) return;
  try {
    await ui.ponte.valor('session/cancel', { sessionId: ui.sessaoAtual });
    dica('pedi o cancelamento');
  } catch (erro) {
    dica(`não consegui cancelar: ${erro.message}`);
  }
}

// ---------------------------------------------------------------------------
// Autoaprovacao
// ---------------------------------------------------------------------------

/*
 * O Ramses pediu, em 22/10/2026, uma opção de deixar aprovado durante toda a
 * sessão: navegar pelo Mercado Livre com o agente pedindo confirmação a cada
 * troca de página inviabiliza o uso. O modo vale para a conversa aberta no
 * painel e morre quando o navegador fecha (`chrome.storage.session`), para não
 * virar um "sempre permitir" esquecido.
 *
 * Ele aparece em dois lugares de propósito: no botão da barra (estado e como
 * desligar) e numa faixa acima do cartão, porque modo ligado sem aviso é o jeito
 * mais fácil de o agente clicar em algo que o usuário não viu.
 */

/** Reflete o modo na tela, sem mexer no armazenamento. */
function marcarAutoAprovar(ligado) {
  ui.autoAprovar = ligado === true;
  tela.btnAuto.classList.toggle('ativo', ui.autoAprovar);
  tela.btnAuto.setAttribute('aria-pressed', String(ui.autoAprovar));
  tela.faixaAuto.hidden = !ui.autoAprovar;
}

/**
 * Liga ou desliga a autoaprovação, grava a escolha e (quando pedido) registra no
 * transcrito.
 *
 * @param ligado - estado desejado.
 * @param opcoes - `gravar` (false quando o valor veio do armazenamento) e
 *   `registrar` (false na abertura, para não sujar o transcrito a cada troca de
 *   conversa).
 */
async function aplicarAutoAprovar(ligado, { gravar = true, registrar = true } = {}) {
  marcarAutoAprovar(ligado);
  if (gravar) {
    await salvarAutoAprovar({ ligado: ui.autoAprovar, sessionId: ui.sessaoAtual });
  }
  if (registrar) registrarAutoAprovacao(ui.autoAprovar);
}

/** Lê a escolha guardada e aplica, adotando a conversa quando ainda não havia uma. */
async function carregarAutoAprovar() {
  const guardado = await lerAutoAprovar();
  const vale = autoValePara(guardado, ui.sessaoAtual);
  marcarAutoAprovar(vale);
  // Ligou antes de existir conversa: a primeira que abrir adota a escolha.
  if (vale && guardado.sessionId === null && ui.sessaoAtual !== null) {
    await salvarAutoAprovar({ ligado: true, sessionId: ui.sessaoAtual });
  }
  return vale;
}

function registrarAutoAprovacao(ligado) {
  ui.estado.itens.push({
    chave: `auto-${Date.now()}`,
    tipo: 'status',
    versao: 0,
    hora: Date.now(),
    texto: ligado
      ? 'autoaprovação ligada nesta conversa: as ações do agente rodam sem pedir confirmação até você desligar'
      : 'autoaprovação desligada: as ações do agente voltam a pedir confirmação',
  });
  agendarRender(['itens']);
}

// ---------------------------------------------------------------------------
// Pedidos do agente
// ---------------------------------------------------------------------------

/**
 * Idade máxima de um pedido que o painel ainda desenha.
 *
 * A ponte já expira o pendente em dois minutos, mas o painel pode ter ficado
 * aberto a noite inteira e receber a reentrega de um pedido velho ao reconectar.
 * O que apareceu no painel do Ramses em 04/11/2026 foi justamente isso: ação do
 * dia anterior parada em "Executando...".
 */
const IDADE_MAXIMA_PEDIDO_MS = 5 * 60 * 1000;

/** Teto de espera de uma execução antes de devolver o cartão ao usuário. */
const TETO_EXECUCAO_MS = 30_000;

/** Diz se um pedido já venceu pelo relógio. */
function pedidoVencido(pedido) {
  const criado = Date.parse(String(pedido?.criadoEm ?? ''));
  if (Number.isFinite(criado)) return Date.now() - criado > IDADE_MAXIMA_PEDIDO_MS;
  const expira = Date.parse(String(pedido?.expiraEm ?? ''));
  if (Number.isFinite(expira)) return Date.now() > expira;
  // Sem carimbo de tempo não dá para saber a idade: o pedido é tratado como novo,
  // porque recusar tudo o que não tem data quebraria um host antigo.
  return false;
}

function tratarMensagemDePedido(mensagem) {
  if (mensagem?.tipo === 'pedido') {
    if (pedidoVencido(mensagem.pedido)) {
      ui.ponte
        .responder({ id: mensagem.pedido.id, ok: false, erro: 'o pedido expirou antes de ser aprovado no painel' })
        .catch(() => undefined);
      registrarStatus(`pedido antigo ignorado: ${descreverAcao(mensagem.pedido)}`);
      return;
    }
    if (mensagem.pedido?.tipo === 'ler') {
      // Leitura nao pede aprovacao: e a aba que o painel ja mostra, ou a que o
      // agente apontou pelo parametro `aba`.
      atenderLeitura(mensagem.pedido);
      return;
    }
    if (mensagem.pedido?.tipo === 'abas') {
      atenderAbas(mensagem.pedido);
      return;
    }
    if (mensagem.pedido?.tipo === 'print') {
      atenderPrint(mensagem.pedido);
      return;
    }
    if (mensagem.pedido?.tipo === 'cookies') {
      /*
       * Cookies tambem nao pedem aprovacao, porque nao agem na pagina: a lista
       * de hosts permitidos vive no service worker, e o resultado vira
       * arquivo local, nunca texto na conversa.
       */
      atenderCookies(mensagem.pedido);
      return;
    }
    if (mensagem.pedido?.tipo === 'copiar') {
      /*
       * Copiar tambem nao pede aprovacao: nao mexe na pagina, so escreve na area
       * de transferencia o texto que o agente ja leu. Clicar num cartao para
       * "copiar" seria atrito sem ganho de seguranca.
       */
      atenderCopiar(mensagem.pedido);
      return;
    }
    // Autoaprovação ligada: executa direto, sem cartão. Só vale para `agir`.
    if (ui.autoAprovar && mensagem.pedido?.tipo === 'agir') {
      executarPedido(mensagem.pedido, { automatica: true }).catch(() => undefined);
      return;
    }
    desenharPedido(mensagem.pedido);
    return;
  }
  if (mensagem?.tipo === 'resolvido') {
    const registro = ui.pedidos.get(mensagem.id);
    if (registro !== undefined) {
      registro.no.remove();
      ui.pedidos.delete(mensagem.id);
    }
    return;
  }
  if (mensagem?.tipo === 'expirado') {
    // A ponte desistiu: o cartão tem de sair da tela junto, senão ele fica
    // "Executando..." para sempre.
    const registro = ui.pedidos.get(mensagem.id);
    if (registro !== undefined) {
      registro.no.remove();
      ui.pedidos.delete(mensagem.id);
      registrarStatus('o pedido ao navegador expirou sem resposta; nada foi executado');
    }
    return;
  }
}

/** Executa uma leitura pedida pelo agente e devolve o resultado. */
async function atenderLeitura(pedido) {
  try {
    const aba = await abaAlvoDoPedido(pedido);
    if (aba === null || aba.id === null) throw new Error('a aba alvo nao tem id');
    const leitura = await servico({
      tipo: 'ler',
      oQue: pedido.oQue ?? 'texto',
      seletor: pedido.seletor,
      limite: pedido.limite,
      abaId: aba.id,
    });
    registrarLeituraDoAgente(pedido, leitura, aba);
    await ui.ponte.responder({ id: pedido.id, ok: true, valor: { ...leitura, aba } });
  } catch (erro) {
    await ui.ponte.responder({ id: pedido.id, ok: false, erro: erro.message });
  }
}

/** Atende o pedido de listar as abas abertas. */
async function atenderAbas(pedido) {
  try {
    const abas = await listarAbas();
    await ui.ponte.responder({
      id: pedido.id,
      ok: true,
      valor: {
        abas,
        fixada: ui.aba === null ? null : ui.aba.id,
        resumo: `${abas.length} aba(s) aberta(s) no navegador`,
      },
    });
  } catch (erro) {
    await ui.ponte.responder({ id: pedido.id, ok: false, erro: erro.message });
  }
}

/**
 * Atende o pedido de print da aba.
 *
 * A área visível vem pronta do service worker. A página inteira vem em fatias, e
 * quem empilha é este lado, porque montar imagem exige canvas e o service worker
 * não tem documento.
 */
async function atenderPrint(pedido) {
  try {
    const aba = await abaAlvoDoPedido(pedido);
    if (aba === null || aba.id === null) throw new Error('a aba alvo nao tem id');
    const bruto = await servico({ tipo: 'print', abaId: aba.id, inteira: pedido.inteira === true });
    const dataUrl = bruto?.inteira === true ? await montarPaginaInteira(bruto) : bruto?.dataUrl;
    if (typeof dataUrl !== 'string' || dataUrl.startsWith('data:image/') === false) {
      throw new Error('o navegador nao devolveu imagem');
    }
    // A captura ativa a aba, então ela é a ativa ao fim do print.
    const usada = decorarAba({ ...aba, ativa: true });
    await ui.ponte.responder({ id: pedido.id, ok: true, valor: { dataUrl, aba: usada, inteira: bruto?.inteira === true } });
    registrarStatus(`o agente tirou print da aba${bruto?.inteira === true ? ' (pagina inteira)' : ''}: ${aba.url}`);
  } catch (erro) {
    await ui.ponte.responder({ id: pedido.id, ok: false, erro: erro.message });
  }
}

/** Decodifica um data URL de PNG em bitmap sem depender de `fetch`. */
async function bitmapDeDataUrl(dataUrl) {
  const corte = dataUrl.indexOf(',');
  const binario = atob(dataUrl.slice(corte + 1));
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

/**
 * Empilha as fatias do print de página inteira num PNG só.
 *
 * Cada fatia sabe a posição CSS em que foi capturada. A costura tira o pedaço que
 * a fatia anterior já mostrou (a última rolagem encosta no fim da página) e corta
 * o que passa do documento.
 * @param bruto - `{fatias: [{dataUrl, y, visivel, altura}], ...}` do service worker.
 * @returns o data URL PNG da página inteira.
 */
async function montarPaginaInteira(bruto) {
  const fatias = Array.isArray(bruto?.fatias) ? bruto.fatias : [];
  if (fatias.length === 0) throw new Error('o navegador nao devolveu nenhuma fatia da pagina');
  if (fatias.length === 1) return fatias[0].dataUrl;

  const pecas = [];
  let largura = 0;
  let alturaTotal = 0;
  let fimAnterior = null;
  for (const fatia of fatias) {
    const bitmap = await bitmapDeDataUrl(String(fatia.dataUrl ?? ''));
    const visivel = Math.max(1, Number(fatia.visivel) || bitmap.height);
    const escala = bitmap.height / visivel;
    const y = Number(fatia.y) || 0;
    const alturaPagina = Number(fatia.altura) || 0;
    let corteTopo = 0;
    if (fimAnterior !== null && y < fimAnterior) corteTopo = Math.round((fimAnterior - y) * escala);
    corteTopo = Math.min(Math.max(corteTopo, 0), bitmap.height);
    let corteBase = 0;
    const fimCss = y + bitmap.height / escala;
    if (alturaPagina > 0 && fimCss > alturaPagina) corteBase = Math.round((fimCss - alturaPagina) * escala);
    const altura = Math.max(0, bitmap.height - corteTopo - corteBase);
    pecas.push({ bitmap, corteTopo, altura });
    largura = Math.max(largura, bitmap.width);
    alturaTotal += altura;
    fimAnterior = fimCss;
  }
  if (alturaTotal < 1) throw new Error('a costura do print ficou vazia');

  const lona = document.createElement('canvas');
  lona.width = largura;
  lona.height = alturaTotal;
  const contexto = lona.getContext('2d');
  if (contexto === null) throw new Error('o painel nao conseguiu criar a tela do print');
  let y = 0;
  for (const peca of pecas) {
    if (peca.altura < 1) continue;
    contexto.drawImage(peca.bitmap, 0, peca.corteTopo, peca.bitmap.width, peca.altura, 0, y, peca.bitmap.width, peca.altura);
    y += peca.altura;
    peca.bitmap.close?.();
  }
  return lona.toDataURL('image/png');
}

/** Escreve uma linha de status no transcrito. */
function registrarStatus(texto) {
  ui.estado.itens.push({ chave: `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tipo: 'status', versao: 0, hora: Date.now(), texto });
  agendarRender(['itens']);
}

/**
 * Executa uma leitura de cookies pedida pelo agente.
 *
 * Não depende de `ui.aba`: o alvo é o domínio, e o service worker aplica a
 * lista branca `DOMINIOS_DE_COOKIE`. O valor dos cookies vai do painel direto
 * para a ponte, que grava arquivo; eles não passam pelo transcrito da conversa.
 */
async function atenderCookies(pedido) {
  try {
    const leitura = await servico({ tipo: 'cookies', host: pedido.host });
    await ui.ponte.responder({ id: pedido.id, ok: true, valor: leitura });
  } catch (erro) {
    await ui.ponte.responder({ id: pedido.id, ok: false, erro: erro.message });
  }
}

function registrarLeituraDoAgente(pedido, leitura, aba) {
  const onde = aba === undefined || aba === null ? '' : ` em ${aba.titulo === '' ? aba.url : aba.titulo}`;
  const marcas = [];
  if (aba?.ativa === true) marcas.push('aba ativa');
  if (aba?.fixada === true) marcas.push('fixada no painel');
  ui.estado.itens.push({
    chave: `leitura-${pedido.id}`,
    tipo: 'status',
    versao: 0,
    hora: Date.now(),
    texto: `o agente leu a aba (${pedido.oQue}${pedido.seletor ? ` em ${pedido.seletor}` : ''})${onde}${
      marcas.length === 0 ? '' : ` [${marcas.join(', ')}]`
    }${leitura?.resumo ? `: ${leitura.resumo}` : ''}`,
  });
  agendarRender(['itens']);
}

/** Descreve em portugues o que a acao vai fazer. */
function descreverAcao(pedido) {
  switch (pedido.acao) {
    case 'clicar':
      return `clicar no elemento ${pedido.seletor}`;
    case 'digitar':
      return `escrever ${JSON.stringify(String(pedido.texto ?? '').slice(0, 400))} em ${pedido.seletor}`;
    case 'teclar':
      return `pressionar ${pedido.tecla}${pedido.seletor ? ` em ${pedido.seletor}` : ''}`;
    case 'rolar':
      return `rolar ${Math.abs(Number(pedido.pixels ?? 600))}px para ${pedido.direcao === 'cima' ? 'cima' : 'baixo'}`;
    case 'navegar':
      return pedido.novaAba === true ? `abrir ${pedido.url} numa aba nova` : `navegar para ${pedido.url}`;
    case 'voltar':
      return 'voltar uma página no histórico';
    case 'avancar':
      return 'avançar uma página no histórico';
    case 'recarregar':
      return 'recarregar a página';
    case 'esperar':
      return `esperar ${pedido.segundos ?? 2}s`;
    case 'copiar':
      return `copiar para a area de transferencia${pedido.seletor === undefined ? '' : ` o texto de ${pedido.seletor}`}`;
    default:
      return `executar ${pedido.acao}`;
  }
}

/** Desenha o cartao de aprovacao de uma acao do agente. */
function desenharPedido(pedido) {
  if (ui.pedidos.has(pedido.id)) return;
  const cartao = document.createElement('div');
  cartao.className = 'pedido';

  const titulo = document.createElement('div');
  titulo.className = 'rotulo';
  titulo.textContent = 'O agente quer agir na aba';
  cartao.append(titulo);

  const descricao = document.createElement('div');
  descricao.textContent = descreverAcao(pedido);
  cartao.append(descricao);

  const alvo = document.createElement('div');
  alvo.className = 'alvo';
  const daPonte = pedido.aba === null || pedido.aba === undefined ? null : pedido.aba;
  const alvoPedido = pedido.alvo === undefined || pedido.alvo === null ? '' : String(pedido.alvo).trim();
  alvo.textContent = alvoPedido === '' && daPonte !== null ? `${daPonte.titulo || '(sem título)'}\n${daPonte.url}` : 'resolvendo a aba alvo...';
  cartao.append(alvo);

  const aviso = document.createElement('div');
  aviso.className = 'erro-texto';
  aviso.hidden = true;
  cartao.append(aviso);

  /*
   * A aba alvo é resolvida NA HORA do pedido, e o cartão nasce antes disso: uma
   * resolução pode custar uma ida ao service worker. Quando ela volta, o cartão
   * já está na tela com o nome certo (ou com o motivo de não ter dado).
   */
  abaAlvoDoPedido(pedido)
    .then((aba) => {
      if (aba === null) return;
      const marcas = [];
      if (aba.ativa === true) marcas.push('aba ativa agora');
      if (aba.fixada === true) marcas.push('fixada no painel');
      alvo.textContent = `${aba.titulo || '(sem título)'}\n${aba.url}${marcas.length === 0 ? '' : `\n[${marcas.join(', ')}]`}`;
      if (aba.ativa !== true) {
        aviso.hidden = false;
        aviso.textContent = 'A aba alvo não é a aba ativa agora; confira antes de aprovar';
      }
    })
    .catch((erro) => {
      alvo.textContent = `aba alvo desconhecida: ${erro.message}`;
      aviso.hidden = false;
      aviso.textContent = 'Sem aba alvo esta acao nao roda; recuse e peca a lista com navegador_abas';
    });

  // "Não perguntar de novo": vale desta ação em diante, enquanto esta conversa
  // estiver aberta no painel.
  const lembrar = document.createElement('label');
  lembrar.className = 'lembrar';
  const caixa = document.createElement('input');
  caixa.type = 'checkbox';
  const textoLembrar = document.createElement('span');
  textoLembrar.textContent = 'não perguntar de novo nesta conversa (autoaprovar as próximas ações)';
  lembrar.append(caixa, textoLembrar);
  cartao.append(lembrar);

  const acoes = document.createElement('div');
  acoes.className = 'acoes';
  const recusar = document.createElement('button');
  recusar.textContent = 'Recusar';
  recusar.className = 'perigo';
  const aprovar = document.createElement('button');
  aprovar.textContent = 'Aprovar e executar';
  aprovar.className = 'primario';
  acoes.append(recusar, aprovar);
  cartao.append(acoes);

  recusar.addEventListener('click', () => {
    aprovar.disabled = true;
    recusar.disabled = true;
    ui.ponte.responder({ id: pedido.id, ok: false, erro: 'o usuário recusou esta ação no painel' }).catch(() => undefined);
    registrarAcaoRecusada(pedido);
  });

  aprovar.addEventListener('click', async () => {
    aprovar.disabled = true;
    recusar.disabled = true;
    caixa.disabled = true;
    aprovar.textContent = 'Executando...';
    // Liga antes de executar: a ação que o usuário está aprovando já entra no modo.
    if (caixa.checked && !ui.autoAprovar) await aplicarAutoAprovar(true);
    const resultado = await comPrazo(executarPedido(pedido), TETO_EXECUCAO_MS);
    if (resultado !== null && resultado !== PRAZO_VENCIDO) return;
    /*
     * Execução que não voltou (ou que falhou) NÃO pode deixar o cartão em
     * "Executando..." para sempre: era o sintoma das ações do dia anterior
     * paradas na tela.
     */
    aprovar.disabled = false;
    recusar.disabled = false;
    aprovar.textContent = 'Tentar de novo';
    if (resultado === PRAZO_VENCIDO) {
      registrarStatus(`a execucao de "${descreverAcao(pedido)}" passou de ${Math.round(TETO_EXECUCAO_MS / 1000)}s sem voltar`);
    }
  });

  tela.pendencias.append(cartao);
  ui.pedidos.set(pedido.id, { pedido, no: cartao });
  cartao.scrollIntoView({ block: 'nearest' });
  desenharPerguntas();
}

/**
 * Executa um pedido de ação já aprovado e responde a ponte.
 *
 * Serve aos dois caminhos: o botão do cartão e a autoaprovação. No caminho
 * automático ninguém viu a ação, então o transcrito diz isso e o pedido volta com
 * `autoaprovada: true` para o modelo não contar ao usuário uma aprovação que não
 * houve.
 *
 * O selo vai no ENVELOPE da resposta, não dentro de `valor`: um host antigo
 * (plugin 0.2.0) ignora o campo e segue funcionando, enquanto o host novo
 * acrescenta ele ao resultado da ferramenta. Se fosse dentro de `valor`, o schema
 * fechado do host antigo recusaria a saída e a ação se perderia até reiniciar o
 * DSH (medido: `"value.aba.janelaId" is not a declared property`, HANDOFF 3.11).
 *
 * @param pedido - pedido vindo da ponte.
 * @param opcoes - `automatica: true` quando rodou pela autoaprovação.
 */
async function executarPedido(pedido, { automatica = false } = {}) {
  try {
    const aba = await abaAlvoDoPedido(pedido);
    if (aba === null || aba.id === null) throw new Error('sem aba alvo');
    let resultado =
      pedido.acao === 'navegar' && pedido.novaAba === true
        ? await navegarEmAbaNova(pedido, aba)
        : await servico({
            tipo: 'agir',
            abaId: aba.id,
            pedido,
            ...(typeof pedido.quadro === 'string' && pedido.quadro !== '' ? { quadro: pedido.quadro } : {}),
          });
    /*
     * Copiar termina AQUI, no painel: o service worker só lê o texto do DOM, e
     * quem consegue gravar a área de transferência é a página da extensão (ou,
     * no limites dela, o host). O texto sai do resultado antes de voltar para a
     * conversa: o valor útil é o "copiei N caracteres", não o conteúdo de novo.
     */
    if (pedido.acao === 'copiar') resultado = await concluirCopia(resultado);
    // A aba do resultado é a que foi usada de verdade: `navegar` em aba nova
    // devolve a aba criada, e as outras ações devolvem a própria aba alvo.
    const usada = resultado?.aba === undefined || resultado?.aba === null ? aba : resultado.aba;
    const valor = { ...resultado, aba: decorarAba(usada) };
    delete valor.texto;
    await ui.ponte.responder({
      id: pedido.id,
      ok: true,
      valor,
      aprovada: true,
      ...(automatica ? { autoaprovada: true } : {}),
    });
    registrarAcao(pedido, valor, { automatica });
    return valor;
  } catch (erro) {
    await ui.ponte.responder({ id: pedido.id, ok: false, erro: erro.message });
    registrarAcao(pedido, { resumo: `falhou: ${erro.message}` }, { automatica });
    return null;
  }
}

/**
 * Abre a URL numa aba nova, fixa o painel nela e devolve o resultado.
 *
 * Não passa pela injeção (é `chrome.tabs.create` no service worker) porque
 * `location.assign` só troca a página da aba em que roda.
 * @param pedido - pedido de ação com `acao: 'navegar'` e `novaAba: true`.
 * @param aba - aba atual, de onde vem a janela.
 * @returns o valor da ação, com a aba nova.
 */
async function navegarEmAbaNova(pedido, aba) {
  const url = String(pedido.url ?? '');
  const janelaId = Number.isSafeInteger(aba?.janelaId) ? aba.janelaId : null;
  const nova = await servico({
    tipo: 'navegar-nova',
    url,
    ...(janelaId === null ? {} : { janelaId }),
  });
  const fixada = await fixarAba({ ...nova, ativa: true });
  registrarStatus(`o painel passou a fixar a aba ${fixada.id} (${url}) porque o agente abriu uma aba nova`);
  return {
    ok: true,
    resumo: `abri ${url} numa aba nova (id ${fixada.id}) e fixei o painel nela`,
    aba: { ...fixada, ativa: true, fixada: true },
  };
}

/** Sentinela devolvida quando o prazo de uma execução estoura. */
const PRAZO_VENCIDO = Symbol('prazo-vencido');

/** Resolve com `PRAZO_VENCIDO` quando a promessa passa do prazo. */
function comPrazo(promessa, ms) {
  return Promise.race([promessa, espera(ms).then(() => PRAZO_VENCIDO)]);
}

function registrarAcao(pedido, resultado, { automatica = false } = {}) {
  const como = automatica ? 'ação executada automaticamente (autoaprovação ligada)' : 'ação aprovada e executada';
  ui.estado.itens.push({
    chave: `acao-${pedido.id}`,
    tipo: 'status',
    versao: 0,
    hora: Date.now(),
    texto: `${como}: ${descreverAcao(pedido)}${resultado?.resumo ? ` (${resultado.resumo})` : ''}`,
  });
  agendarRender(['itens']);
}

function registrarAcaoRecusada(pedido) {
  ui.estado.itens.push({
    chave: `recusa-${pedido.id}`,
    tipo: 'status',
    versao: 0,
    hora: Date.now(),
    texto: `ação recusada por você: ${descreverAcao(pedido)}`,
  });
  agendarRender(['itens']);
}

// ---------------------------------------------------------------------------
// Perguntas do agente
// ---------------------------------------------------------------------------

/**
 * Desenha o que esta esperando o usuario: pergunta do agente e pedido de acao.
 *
 * Sobre responder pergunta, medido em 17/10/2026 com a ponte 0.1.1 e o DSH
 * reiniciado: com `tool-ask-user` em `mode: timed` a pergunta entra em
 * `userQuestions.active` com `state: 'open'`, e `userQuestions/answer` com esse
 * `callId` **fecha a pergunta e o turno segue** (o teste respondeu "Azul" e o
 * modelo respondeu "Azul."). O cartao com opcoes e texto livre vale, portanto,
 * para `open`, e nao para `continued` como dizia o comentario anterior.
 *
 * Em `mode: legacy` (o padrao do pacote, sem config) a pergunta NAO entra em
 * `userQuestions.active`: nesse caso so existe o `perguntaPendente` que vem do
 * quadro da ferramenta, e o cartao e informativo, dizendo onde responder. Os dois
 * casos convivem, e o informativo so aparece quando nao ha pergunta respondivel.
 */
function desenharPerguntas() {
  const vistos = new Set();

  // Perguntas que o painel consegue responder: precisam de `callId` na projecao.
  const abertas = (Array.isArray(ui.estado.perguntas) ? ui.estado.perguntas : []).filter(
    (p) => p?.state === 'open' && typeof p?.callId === 'string',
  );

  const pendente = ui.estado.perguntaPendente;
  if (pendente !== null && pendente !== undefined && abertas.length === 0) {
    vistos.add(pendente.callId);
    if (!ui.perguntasNos.has(pendente.callId)) {
      const cartao = montarCartaoPendente(pendente);
      ui.perguntasNos.set(pendente.callId, cartao);
      tela.pendencias.append(cartao);
    }
  }

  for (const pergunta of abertas) {
    const callId = pergunta.callId;
    if (vistos.has(callId)) continue;
    vistos.add(callId);
    if (ui.perguntasNos.has(callId)) continue;
    const cartao = montarCartaoDePergunta(pergunta);
    ui.perguntasNos.set(callId, cartao);
    tela.pendencias.append(cartao);
  }

  for (const [callId, no] of ui.perguntasNos) {
    if (vistos.has(callId)) continue;
    no.remove();
    ui.perguntasNos.delete(callId);
  }
  const temPendencia = ui.perguntasNos.size > 0 || ui.pedidos.size > 0;
  chrome.action.setBadgeText({ text: temPendencia ? String(ui.pedidos.size + ui.perguntasNos.size) : '' }).catch(() => undefined);
  if (temPendencia) chrome.action.setBadgeBackgroundColor({ color: '#92400e' }).catch(() => undefined);
}

/** Cartao somente-leitura da pergunta que o agente esta esperando responder. */
function montarCartaoPendente(pendente) {
  const cartao = document.createElement('div');
  cartao.className = 'pergunta';

  const titulo = document.createElement('div');
  titulo.className = 'rotulo';
  titulo.textContent = 'O agente está esperando uma resposta';
  cartao.append(titulo);

  for (const item of pendente.perguntas) {
    if (item.header) {
      const cabecalho = document.createElement('div');
      cabecalho.className = 'rotulo';
      cabecalho.textContent = item.header;
      cartao.append(cabecalho);
    }
    const enunciado = document.createElement('div');
    enunciado.className = 'enunciado';
    enunciado.textContent = item.question ?? '(pergunta sem texto)';
    cartao.append(enunciado);

    const opcoes = Array.isArray(item.options) ? item.options : [];
    if (opcoes.length > 0) {
      const lista = document.createElement('div');
      lista.className = 'opcoes';
      for (const opcao of opcoes) {
        const linha = document.createElement('div');
        linha.className = 'descricao';
        linha.textContent = opcao.description === undefined ? `- ${opcao.label}` : `- ${opcao.label}: ${opcao.description}`;
        lista.append(linha);
      }
      cartao.append(lista);
    }
  }

  const instrucao = document.createElement('div');
  instrucao.className = 'ajuda';
  instrucao.textContent =
    'Responda na janela do DSH Desktop: esta pergunta chegou sem identificador de resposta (o tool-ask-user está em mode legacy). Com o preset de perguntas respondíveis, as opções aparecem aqui mesmo.';
  cartao.append(instrucao);
  cartao.scrollIntoView({ block: 'nearest' });
  return cartao;
}

function montarCartaoDePergunta(pergunta) {
  const cartao = document.createElement('div');
  cartao.className = 'pergunta';
  const lista = Array.isArray(pergunta.questions) ? pergunta.questions : [];
  const escolhas = new Map();
  const camposLivres = new Map();

  for (const item of lista) {
    if (item.header) {
      const cabecalho = document.createElement('div');
      cabecalho.className = 'rotulo';
      cabecalho.textContent = item.header;
      cartao.append(cabecalho);
    }
    const enunciado = document.createElement('div');
    enunciado.className = 'enunciado';
    enunciado.textContent = item.question ?? '(pergunta sem texto)';
    cartao.append(enunciado);

    const opcoes = Array.isArray(item.options) ? item.options : [];
    if (opcoes.length > 0) {
      const grupo = document.createElement('div');
      grupo.className = 'opcoes';
      for (const opcao of opcoes) {
        const rotulo = document.createElement('label');
        const entrada = document.createElement('input');
        entrada.type = item.multiSelect === true ? 'checkbox' : 'radio';
        entrada.name = `pergunta-${item.id}`;
        entrada.addEventListener('change', () => {
          const atual = escolhas.get(item.id) ?? new Set();
          if (item.multiSelect === true) {
            if (entrada.checked) atual.add(opcao.label);
            else atual.delete(opcao.label);
          } else {
            atual.clear();
            atual.add(opcao.label);
          }
          escolhas.set(item.id, atual);
        });
        const corpo = document.createElement('span');
        const titulo = document.createElement('span');
        titulo.textContent = opcao.label;
        corpo.append(titulo);
        if (opcao.description) {
          const descricao = document.createElement('div');
          descricao.className = 'descricao';
          descricao.textContent = opcao.description;
          corpo.append(descricao);
        }
        rotulo.append(entrada, corpo);
        grupo.append(rotulo);
      }
      cartao.append(grupo);
    }

    const livre = document.createElement('textarea');
    livre.placeholder = opcoes.length > 0 ? 'ou escreva outra resposta' : 'escreva a resposta';
    livre.addEventListener('input', () => camposLivres.set(item.id, livre.value));
    cartao.append(livre);
  }

  const acoes = document.createElement('div');
  acoes.className = 'acoes';
  const enviarResposta = document.createElement('button');
  enviarResposta.className = 'primario';
  enviarResposta.textContent = 'Responder';
  enviarResposta.addEventListener('click', async () => {
    enviarResposta.disabled = true;
    const respostas = lista.map((item) => {
      const selecionadas = [...(escolhas.get(item.id) ?? new Set())];
      const livre = (camposLivres.get(item.id) ?? '').trim();
      return { id: item.id, selected: selecionadas, ...(livre === '' ? {} : { custom: livre }) };
    });
    try {
      await ui.ponte.valor('userQuestions/answer', {
        agentId: ui.sessaoAtual,
        callId: pergunta.callId,
        answer: { answers: respostas },
      });
      cartao.remove();
      ui.perguntasNos.delete(pergunta.callId);
      atualizarProjecoes();
    } catch (erro) {
      const falha = document.createElement('div');
      falha.className = 'erro-texto';
      falha.textContent = `não consegui responder: ${erro.message}`;
      cartao.append(falha);
      enviarResposta.disabled = false;
    }
  });
  acoes.append(enviarResposta);
  cartao.append(acoes);
  cartao.scrollIntoView({ block: 'nearest' });
  return cartao;
}

// ---------------------------------------------------------------------------
// Render do transcrito
// ---------------------------------------------------------------------------

function agendarRender(marcas) {
  for (const marca of marcas) ui.marcas.add(marca);
  if (ui.renderAgendado) return;
  ui.renderAgendado = true;
  requestAnimationFrame(() => {
    ui.renderAgendado = false;
    const pendentes = new Set(ui.marcas);
    ui.marcas.clear();
    if (pendentes.has('sessao')) desenharCabecalho();
    if (pendentes.has('titulo')) desenharCabecalho();
    if (pendentes.has('itens')) sincronizarItens();
    if (pendentes.has('vivo')) desenharVivo();
    if (pendentes.has('pendencias')) desenharPerguntas();
    ajustarBotoes();
  });
}

function desenharCabecalho() {
  const sessao = ui.estado.sessao;
  const titulo = tituloLegivel(sessao.titulo);
  tela.titulo.textContent = titulo === '' ? 'Conversa sem título' : titulo;
  const medidores = [];
  if (sessao.modelo !== '') medidores.push(sessao.modelo);
  if (sessao.permissoes !== '') medidores.push(sessao.permissoes);
  const pressao = ui.estado.transbordo;
  if (pressao !== null && pressao !== undefined) {
    const porcento = Math.round((pressao.pressureTokens / pressao.contextWindow) * 100);
    medidores.push(`contexto ${porcento}% (${tokens(pressao.pressureTokens)}/${tokens(pressao.contextWindow)})`);
  }
  if (ui.estado.todos !== null && ui.estado.todos !== undefined) {
    const lista = Array.isArray(ui.estado.todos) ? ui.estado.todos : (ui.estado.todos.items ?? []);
    const feitos = lista.filter((t) => t?.status === 'completed').length;
    if (lista.length > 0) medidores.push(`tarefas ${feitos}/${lista.length}`);
  }
  if (ui.estado.objetivo?.texto) medidores.push(`objetivo: ${String(ui.estado.objetivo.texto).slice(0, 40)}`);
  tela.medidores.replaceChildren(
    ...medidores.map((texto) => {
      const span = document.createElement('span');
      span.className = 'medidor';
      span.textContent = texto;
      return span;
    }),
  );
}

function ajustarBotoes() {
  const trabalhando = ui.turnoAtivo || ui.estado.vivo !== null;
  tela.parar.hidden = !trabalhando;
  tela.parar.disabled = ui.sessaoAtual === null;
}

/** Sincroniza os itens do estado com os nos do DOM, sem redesenhar tudo. */
function sincronizarItens() {
  // O item local (a mensagem que voce acabou de mandar) sai quando o evento
  // duravel equivalente chega, para nao aparecer duas vezes.
  if (ui.localPendente !== null) {
    const eco = ui.estado.itens.find((item) => item.tipo === 'usuario' && item.local !== true && item.texto === ui.localPendente);
    if (eco !== undefined) {
      ui.localPendente = null;
      const local = ui.estado.itens.findIndex((item) => item.local === true);
      if (local >= 0) {
        const [item] = ui.estado.itens.splice(local, 1);
        ui.nos.get(item.chave)?.remove();
        ui.nos.delete(item.chave);
      }
    }
  }

  const vistos = new Set();
  for (const item of ui.estado.itens) {
    vistos.add(item.chave);
    const atual = ui.nos.get(item.chave);
    if (atual !== undefined && atual.dataset.versao === String(item.versao)) continue;
    const novo = desenharItem(item);
    if (atual === undefined) tela.transcrito.append(novo);
    else atual.replaceWith(novo);
    ui.nos.set(item.chave, novo);
  }
  for (const [chave, no] of ui.nos) {
    if (vistos.has(chave)) continue;
    no.remove();
    ui.nos.delete(chave);
  }
  tela.vazio.hidden = ui.estado.itens.length > 0;
  // O bloco ao vivo e sempre o ultimo: itens novos entram antes dele.
  if (ui.noVivo !== null) tela.transcrito.append(ui.noVivo);
  if (ui.preferencias.rolarSozinho !== false) rolarParaBaixo();
}

function desenharItem(item) {
  const no = document.createElement('div');
  no.className = `item ${item.tipo}`;
  no.dataset.versao = String(item.versao);

  if (item.tipo === 'status') {
    no.className = 'status';
    no.textContent = `${item.texto}${item.hora ? ` · ${horaCurta(item.hora)}` : ''}`;
    return no;
  }

  const rotulo = document.createElement('div');
  rotulo.className = 'rotulo';
  const quem = item.tipo === 'usuario' ? 'você' : item.tipo === 'assistente' ? 'DSH' : 'sistema';
  const partes = [quem];
  if (item.hora) partes.push(horaCurta(item.hora));
  if (item.tipo === 'assistente' && item.passo !== undefined) partes.push(`passo ${item.passo}`);
  if (item.local === true) partes.push('a caminho');
  rotulo.textContent = partes.join(' · ');
  no.append(rotulo);

  if (item.tipo === 'sistema') {
    no.append(detalheRecolhido('prompt de sistema', item.texto ?? '', 'texto'));
    return no;
  }

  if (item.tipo === 'assistente' && item.raciocinio) {
    no.append(detalheRecolhido(`raciocínio (${larguraDe(item.raciocinio.length)})`, item.raciocinio, 'texto'));
  }

  /*
   * O bloco de contexto da aba nao pode aparecer cru na conversa: sao milhares
   * de caracteres da pagina, e ele enterra a pergunta do usuario (foi o que o
   * Ramses apontou em 17/10/2026, com razao). A mensagem mostra a pergunta, e o
   * contexto vira um detalhe recolhido com o tamanho no rotulo.
   */
  let texto = item.texto ?? '';
  let contexto = null;
  if (item.tipo === 'usuario' && texto.includes('<contexto-da-aba>')) {
    const achado = /<contexto-da-aba>([\s\S]*?)<\/contexto-da-aba>/.exec(texto);
    if (achado !== null) {
      contexto = achado[1].trim();
      texto = `${texto.slice(0, achado.index)}${texto.slice(achado.index + achado[0].length)}`.trim();
    } else {
      contexto = texto.slice(texto.indexOf('<contexto-da-aba>'));
      texto = texto.slice(0, texto.indexOf('<contexto-da-aba>')).trim();
    }
  }

  if (texto !== '') {
    const fala = document.createElement('div');
    fala.className = 'fala';
    fala.innerHTML = markdown(texto);
    no.append(fala);
  }

  if (contexto !== null) {
    no.append(detalheRecolhido(legendaDoContexto(contexto), contexto, 'texto'));
  }

  if (Array.isArray(item.ferramentas)) {
    for (const ferramenta of item.ferramentas) no.append(desenharFerramenta(ferramenta));
  }

  if (item.imagens > 0) {
    const anexo = document.createElement('div');
    anexo.className = 'anexo';
    anexo.textContent = `${item.imagens} imagem(ns) anexada(s)`;
    no.append(anexo);
  }

  return no;
}

function desenharFerramenta(ferramenta) {
  const estado = ferramenta.estado === 'rodando' ? 'rodando' : ferramenta.erro ? 'erro' : 'ok';
  const resumo = document.createElement('summary');
  const nome = document.createElement('span');
  nome.className = 'nome';
  nome.textContent = ferramenta.nome;
  const selo = document.createElement('span');
  selo.className = `estado ${estado}`;
  selo.textContent = estado;
  resumo.append(nome, selo);

  const conteudo = document.createElement('div');
  conteudo.className = 'conteudo';
  if (ferramenta.argumentos) conteudo.append(blocoCodigo(ferramenta.argumentos));
  if (ferramenta.resultado) conteudo.append(blocoCodigo(ferramenta.resultado));

  const detalhe = document.createElement('details');
  detalhe.className = 'detalhe ferramenta';
  detalhe.append(resumo, conteudo);
  return detalhe;
}

function detalheRecolhido(titulo, texto, formato) {
  const resumo = document.createElement('summary');
  resumo.textContent = titulo;
  const conteudo = document.createElement('div');
  conteudo.className = 'conteudo';
  if (formato === 'texto') {
    const fala = document.createElement('div');
    fala.className = 'fala';
    fala.innerHTML = markdown(texto);
    conteudo.append(fala);
  } else {
    conteudo.append(blocoCodigo(texto));
  }
  const detalhe = document.createElement('details');
  detalhe.className = 'detalhe';
  detalhe.append(resumo, conteudo);
  return detalhe;
}

function blocoCodigo(texto) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = texto;
  pre.append(code);
  return pre;
}

/** Desenha (ou atualiza) o bloco ao vivo: raciocinio, texto e ferramentas. */
function desenharVivo() {
  const vivo = ui.estado.vivo;
  if (vivo === null) {
    ui.noVivo?.remove();
    ui.noVivo = null;
    return;
  }
  const raciocinio = vivo.raciocinio ?? '';
  const texto = [...vivo.blocos.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bloco]) => bloco)
    .filter((bloco) => bloco.tipo === 'text')
    .map((bloco) => bloco.texto)
    .join('')
    .trim();
  const ferramentas = [...vivo.blocos.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bloco]) => bloco)
    .filter((bloco) => bloco.tipo === 'tool-call' && bloco.nome !== '');

  if (ui.noVivo === null) {
    ui.noVivo = document.createElement('div');
    ui.noVivo.className = 'item assistente';
    tela.transcrito.append(ui.noVivo);
  }
  const no = ui.noVivo;
  no.replaceChildren();

  const rotulo = document.createElement('div');
  rotulo.className = 'rotulo';
  rotulo.textContent = `DSH · escrevendo (passo ${vivo.passo})`;
  no.append(rotulo);

  if (raciocinio !== '') no.append(detalheRecolhido(`raciocínio (${larguraDe(raciocinio.length)})`, raciocinio, 'texto'));

  for (const ferramenta of ferramentas) {
    const resumo = document.createElement('summary');
    const nome = document.createElement('span');
    nome.className = 'nome';
    nome.textContent = ferramenta.nome;
    const selo = document.createElement('span');
    selo.className = 'estado';
    selo.textContent = 'Chamando';
    resumo.append(nome, selo);
    const conteudo = document.createElement('div');
    conteudo.className = 'conteudo';
    if (ferramenta.argumentos) conteudo.append(blocoCodigo(ferramenta.argumentos));
    const detalhe = document.createElement('details');
    detalhe.className = 'detalhe ferramenta';
    detalhe.append(resumo, conteudo);
    no.append(detalhe);
  }

  if (texto !== '') {
    const fala = document.createElement('div');
    fala.className = 'fala';
    fala.innerHTML = markdown(texto);
    no.append(fala);
  }

  if (ui.preferencias.rolarSozinho !== false) rolarParaBaixo();
}

function rolarParaBaixo() {
  tela.transcrito.scrollTop = tela.transcrito.scrollHeight;
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

function preencherAjustes() {
  tela.cfgBase.value = ui.config.baseUrl;
  tela.cfgToken.value = ui.config.token === '' ? '' : `${ui.config.token.slice(0, 6)}...${ui.config.token.slice(-4)}`;
  tela.cfgCwd.value = ui.preferencias.cwd ?? '';
  // O campo vazio segue a pasta do add-on; mostrar o caminho no placeholder
  // evita a duvida "afinal, onde esta conversa vai nascer?".
  tela.cfgCwd.placeholder = ui.config.cwdConversas || 'C:\\Users\\<você>\\Documents\\DSH';
  tela.cfgRolar.checked = ui.preferencias.rolarSozinho !== false;
}

async function carregarPresets() {
  if (!ui.autorizado) return;
  try {
    const valor = await ui.ponte.valor('agentPresets/list', {});
    const presets = valor?.presets ?? [];
    tela.cfgPreset.replaceChildren(opcaoDe('', '(padrão do DSH)'));
    for (const preset of presets) {
      const rotulo = preset.name ?? preset.id;
      tela.cfgPreset.append(opcaoDe(preset.id, preset.broken ? `${rotulo} (quebrado)` : rotulo));
    }
    tela.cfgPreset.value = ui.preferencias.preset ?? '';
  } catch {
    tela.cfgPreset.replaceChildren(opcaoDe('', '(não consegui listar)'));
  }
}

function opcaoDe(valor, texto) {
  const opcao = document.createElement('option');
  opcao.value = valor;
  opcao.textContent = texto;
  return opcao;
}

async function abrirListaDeSessoes() {
  tela.listaSessoes.replaceChildren();
  tela.sessoes.showModal();
  await recarregarSessoes();
}

async function recarregarSessoes() {
  if (!ui.autorizado) {
    tela.listaSessoes.replaceChildren(textoSimples('sem conexão com a ponte'));
    return;
  }
  tela.listaSessoes.replaceChildren(textoSimples('carregando...'));
  try {
    const termo = tela.buscaSessao.value.trim().toLowerCase();
    let lista = await listarSessoes();
    if (termo !== '') lista = lista.filter((s) => s.titulo.toLowerCase().includes(termo));
    lista.sort((a, b) => b.atualizadoEm - a.atualizadoEm);
    const nos = lista.slice(0, 60).map((sessao) => {
      const botao = document.createElement('button');
      botao.className = 'linha-sessao';
      const titulo = document.createElement('span');
      titulo.className = 'titulo';
      titulo.textContent = sessao.titulo;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const pedacos = [];
      if (sessao.rodando) pedacos.push('rodando agora');
      if (sessao.cwd) pedacos.push(sessao.cwd.split('\\').at(-1));
      if (sessao.atualizadoEm) pedacos.push(new Date(sessao.atualizadoEm).toLocaleString('pt-BR'));
      meta.textContent = pedacos.join(' · ');
      botao.append(titulo, meta);
      if (sessao.id === ui.sessaoAtual) botao.classList.add('atual');
      botao.addEventListener('click', async () => {
        tela.sessoes.close();
        await abrirSessao(sessao.id);
      });
      return botao;
    });
    tela.listaSessoes.replaceChildren(...(nos.length > 0 ? nos : [textoSimples('nenhuma conversa encontrada')]));
  } catch (erro) {
    tela.listaSessoes.replaceChildren(textoSimples(`não consegui listar: ${erro.message}`));
  }
}

function textoSimples(texto) {
  const div = document.createElement('div');
  div.className = 'ajuda';
  div.textContent = texto;
  return div;
}

function avisoAjustes(texto, classe = 'ok-texto') {
  tela.cfgEstado.className = classe;
  tela.cfgEstado.textContent = texto;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

function instalarEventos() {
  tela.enviar.addEventListener('click', () => enviar());
  tela.parar.addEventListener('click', () => cancelar());

  tela.texto.addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter' && evento.shiftKey === false) {
      evento.preventDefault();
      enviar();
    }
  });

  for (const botao of [tela.btnAba, tela.btnPrint]) {
    botao.addEventListener('click', () => {
      botao.classList.toggle('ativo');
      salvarPreferencias({ [botao === tela.btnAba ? 'anexarAba' : 'anexarPrint']: botao.classList.contains('ativo') }).catch(() => undefined);
    });
  }

  tela.btnSelecao.addEventListener('click', async () => {
    try {
      const leitura = await servico({ tipo: 'ler', oQue: 'selecao', abaId: ui.aba?.id });
      const selecao = String(leitura?.selecao ?? '').trim();
      if (selecao === '') {
        dica('não há nada selecionado na aba');
        return;
      }
      const citado = selecao
        .split('\n')
        .map((linha) => `> ${linha}`)
        .join('\n');
      tela.texto.value = `${tela.texto.value}${tela.texto.value === '' ? '' : '\n\n'}${citado}\n\n`;
      tela.texto.focus();
    } catch (erro) {
      dica(`não consegui ler a seleção: ${erro.message}`);
    }
  });

  tela.btnLimpar.addEventListener('click', () => {
    limparTela();
    ui.estado.itens = [];
    dica('transcrito limpo só aqui; a conversa no DSH continua inteira');
  });

  tela.usarAba.addEventListener('click', () => usarAbaAtual(true));

  // Diálogo de abas: a lista completa, de todas as janelas do navegador.
  tela.btnAbas.addEventListener('click', () => abrirListaDeAbas().catch(() => undefined));
  el('btn-fechar-abas').addEventListener('click', () => tela.abas.close());
  el('btn-atualizar-abas').addEventListener('click', () => recarregarAbas().catch(() => undefined));
  tela.buscaAba.addEventListener('input', () => recarregarAbas().catch(() => undefined));
  tela.usarAbaDialogo.addEventListener('click', async () => {
    await usarAbaAtual(true);
    tela.abas.close();
  });

  tela.btnAuto.addEventListener('click', () => {
    aplicarAutoAprovar(!ui.autoAprovar).catch(() => undefined);
  });
  tela.btnAutoDesligar.addEventListener('click', () => {
    aplicarAutoAprovar(false).catch(() => undefined);
  });

  /*
   * Duas janelas do painel (barra lateral e janela destacada) compartilham o
   * armazenamento: se uma desliga a autoaprovacao, a outra tem de acompanhar,
   * senao ela seguiria aprovando por conta propria.
   */
  chrome.storage.onChanged.addListener((mudancas) => {
    if (mudancas === undefined || mudancas[CHAVE_AUTO_APROVAR] === undefined) return;
    carregarAutoAprovar().catch(() => undefined);
  });

  tela.btnSessao.addEventListener('click', () => abrirListaDeSessoes().catch(() => undefined));
  el('btn-fechar-sessoes').addEventListener('click', () => tela.sessoes.close());
  el('btn-atualizar-sessoes').addEventListener('click', () => recarregarSessoes().catch(() => undefined));
  tela.buscaSessao.addEventListener('input', () => recarregarSessoes().catch(() => undefined));
  el('btn-nova-conversa').addEventListener('click', async () => {
    tela.sessoes.close();
    try {
      const sessionId = await criarSessao();
      await abrirSessao(sessionId);
    } catch (erro) {
      dica(`não consegui criar a conversa: ${erro.message}`);
    }
  });

  tela.btnAjustes.addEventListener('click', () => {
    tela.ajustes.showModal();
    carregarPresets().catch(() => undefined);
  });
  el('btn-fechar-ajustes').addEventListener('click', async () => {
    const base = normalizarBase(tela.cfgBase.value);
    const preferencias = {
      cwd: tela.cfgCwd.value.trim(),
      rolarSozinho: tela.cfgRolar.checked,
      preset: tela.cfgPreset.value,
    };
    ui.preferencias = await salvarPreferencias(preferencias);
    ui.presetEscolhido = preferencias.preset;
    if (base !== ui.config.baseUrl) {
      ui.config.baseUrl = base;
      await salvarPonte({ baseUrl: base });
      tela.ajustes.close();
      await conectar();
      return;
    }
    tela.ajustes.close();
  });

  el('btn-parear').addEventListener('click', async () => {
    avisoAjustes('pareando...', 'ajuda');
    try {
      const alvo = tela.cfgBase.value.trim() === '' ? ui.config.baseUrl : normalizarBase(tela.cfgBase.value);
      const ponte = new Ponte(alvo, '');
      const dado = await ponte.parear();
      ui.config = { baseUrl: alvo, token: dado.token };
      await salvarPonte(ui.config);
      preencherAjustes();
      avisoAjustes(`token novo recebido de ${dado.autoridade ?? alvo}`);
      await conectar(true);
    } catch (erro) {
      avisoAjustes(`não consegui parear: ${erro.message}`, 'erro-texto');
    }
  });

  el('btn-testar').addEventListener('click', async () => {
    avisoAjustes('testando...', 'ajuda');
    try {
      const estado = await ui.ponte.ola();
      await ui.ponte.sinal();
      avisoAjustes(
        `ok: ${estado.ponte?.nome} ${estado.ponte?.versao} na porta ${ui.config.baseUrl.split(':').at(-1)}, painel ${estado.painel?.assinantes ?? 0} assinante(s)`,
      );
    } catch (erro) {
      avisoAjustes(`falhou: ${erro.message}`, 'erro-texto');
    }
  });

  // A lista de abas muda por fora do painel: o cabecalho tem de acompanhar.
  chrome.tabs.onActivated.addListener(() => atualizarAbaAtiva());
  chrome.tabs.onUpdated.addListener((_id, mudanca, aba) => {
    if (aba.active === true && (mudanca.status === 'complete' || mudanca.url !== undefined)) atualizarAbaAtiva();
  });
  chrome.tabs.onRemoved.addListener((id) => {
    if (ui.aba?.id === id) {
      ui.aba = null;
      desenharFaixaAba();
      salvarAbaFixada(null).catch(() => undefined);
    }
  });
  /*
   * Com mais de uma janela do Chrome, trocar de janela é o momento em que "a aba
   * ativa" muda de verdade sem `tabs.onActivated` disparar na aba antiga: sem
   * este listener o cabeçalho continuava dizendo que a aba fixada não era a
   * ativa, mesmo com ela na frente.
   */
  chrome.windows?.onFocusChanged?.addListener(() => {
    atualizarAbaAtiva().catch(() => undefined);
  });

  // Pedidos vindos do menu de contexto ou do atalho.
  servico({ tipo: 'pedido-do-menu' })
    .then((pedido) => {
      if (pedido === null || pedido === undefined) return;
      usarAbaAtual(true).then(() => {
        if (typeof pedido.pergunta === 'string' && pedido.pergunta.trim() !== '') {
          tela.texto.value = `${pedido.pergunta.trim()}\n\n`;
          tela.texto.focus();
        } else {
          tela.texto.focus();
        }
      });
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function iniciar() {
  ui.config = await lerPonte();
  ui.preferencias = await lerPreferencias();
  ui.presetEscolhido = ui.preferencias.preset ?? '';
  tela.btnAba.classList.toggle('ativo', ui.preferencias.anexarAba !== false);
  tela.btnPrint.classList.toggle('ativo', ui.preferencias.anexarPrint === true);
  tela.cfgCwd.value = ui.preferencias.cwd ?? '';

  instalarEventos();
  await atualizarAbaAtiva();

  const ok = await conectar();
  /*
   * Retoma a aba fixada da última vez, quando ela ainda existe. Sem isso, cada
   * abertura de barra lateral re-fixava a aba ativa, e o agente perdia o alvo
   * combinado no meio de uma tarefa (foi o caso do painel que voltava para o
   * DrozChat depois de o Ramses ter apontado a aba do simulador).
   */
  let abaRestaurada = false;
  const guardada = await lerAbaFixada();
  if (guardada !== null) {
    try {
      const achada = (await listarAbas()).find((aba) => aba.id === guardada.id);
      if (achada !== undefined) {
        await fixarAba(achada);
        abaRestaurada = true;
      }
    } catch {
      /* lista indisponível agora: cai na aba ativa */
    }
  }
  if (!abaRestaurada && ok) await usarAbaAtual(true);

  const conversa = await lerConversa();
  if (ok && conversa.sessionId) {
    // A conversa guardada pode não existir mais (apagada no DSH, limpeza das
    // sobras, troca de perfil). Conferir antes de assinar evita o laço de
    // "session ... not found" no primeiro `session/follow`.
    if (await sessaoExiste(conversa.sessionId)) {
      await abrirSessao(conversa.sessionId);
    } else {
      situacao('a conversa guardada não existe mais neste DSH; abrindo uma nova', 'erro');
      try {
        await abrirSessao(await criarSessao());
      } catch (erro) {
        situacao(`não consegui abrir uma conversa nova: ${erro.message}`, 'erro');
      }
    }
  } else {
    situacao(ok ? 'Conectado, sem conversa' : 'Sem conexão', ok ? '' : 'erro');
  }

  // Projecoes em intervalos: titulo, tokens, tarefas e perguntas.
  setInterval(() => {
    if (ui.sessaoAtual !== null && ui.autorizado) atualizarProjecoes();
  }, 4000);

  setInterval(() => {
    if (!ui.conectado) conectar(true).catch(() => undefined);
  }, 20000);
}

iniciar().catch((erro) => {
  situacao(`falha ao iniciar: ${erro.message}`, 'erro');
});
