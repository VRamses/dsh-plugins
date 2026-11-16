/*
 * Funções PURAS de quadro (iframe): compor o que cada quadro devolveu e escolher
 * em qual deles agir.
 *
 * Elas moram num módulo separado por dois motivos:
 *
 *   1. o service worker não tem DOM e precisa só disto: juntar resultados que
 *      vieram de `chrome.scripting.executeScript({allFrames: true})`;
 *   2. o Node consegue importar este arquivo, então a regra de composição e a
 *      escolha do quadro são testadas por `ferramentas/testar-quadros.mjs` sem
 *      abrir navegador nenhum. O que depende do DOM (medir, rolar, digitar) fica
 *      em `injecao.js` e continua autossuficiente.
 *
 * Formato de entrada, sempre: uma lista de quadros lidos, cada um
 * `{ frameId, resultado }`, onde `resultado` é o que a função injetada devolveu
 * naquele quadro (`lerNaPagina`, `localizarNaPagina` ou `rolarNaPagina`), com o
 * campo `quadro: {id, url, titulo, principal}` dentro.
 */

/** Quadro reduzido ao que a ferramenta pode declarar no schema de saída. */
export function descreverQuadro(quadro) {
  if (quadro === null || typeof quadro !== 'object') return null;
  const id = typeof quadro.id === 'string' && quadro.id !== '' ? quadro.id : '';
  const url = typeof quadro.url === 'string' ? quadro.url : '';
  return {
    ...(id === '' ? {} : { id }),
    url,
    principal: quadro.principal === true,
  };
}

/** Rótulo curto e estável de um quadro: "Quadro 1 (principal)". */
export function rotuloDoQuadro(quadro, indice) {
  const numero = Number.isFinite(indice) ? indice + 1 : 1;
  return quadro?.principal === true ? `Quadro ${numero} (principal)` : `Quadro ${numero}`;
}

/**
 * Filtra a lista bruta do `executeScript` para o que dá para usar.
 *
 * Resultado de quadro que falhou na injeção vem `undefined`, `null` ou com
 * `erro`; nenhum deles serve para compor texto, e todos são descartados em
 * silêncio (o quadro pode ser um anúncio bloqueado, ou já ter sumido).
 * @param brutos - `[{frameId, result}]` do `chrome.scripting`.
 * @returns `[{frameId, resultado}]`, principal primeiro e depois por frameId.
 */
export function quadrosValidos(brutos) {
  const lista = [];
  for (const bruto of Array.isArray(brutos) ? brutos : []) {
    const resultado = bruto?.result ?? bruto?.resultado ?? null;
    if (resultado === null || typeof resultado !== 'object') continue;
    if (typeof resultado.erro === 'string' && resultado.erro !== '') continue;
    const frameId = Number.isSafeInteger(bruto?.frameId) ? bruto.frameId : 0;
    lista.push({ frameId, resultado });
  }
  lista.sort((a, b) => {
    const aPrincipal = a.resultado?.quadro?.principal === true ? 0 : 1;
    const bPrincipal = b.resultado?.quadro?.principal === true ? 0 : 1;
    if (aPrincipal !== bPrincipal) return aPrincipal - bPrincipal;
    return a.frameId - b.frameId;
  });
  return lista;
}

/** Lista dos quadros para o agente, na ordem em que foram lidos. */
export function descreverQuadros(itens) {
  const lista = [];
  for (const item of Array.isArray(itens) ? itens : []) {
    const quadro = descreverQuadro(item?.resultado?.quadro);
    if (quadro === null) continue;
    lista.push(quadro);
  }
  return lista;
}

/**
 * Junta o texto dos quadros num texto só.
 *
 * Com um quadro só (o caso normal), o texto sai como sempre saiu, sem cabeçalho:
 * mudar o formato de toda leitura de página por causa de iframe não se paga. Com
 * mais de um, cada seção ganha cabeçalho com o rótulo, o título e a URL, porque
 * sem isso o agente não sabe de onde veio cada pedaço.
 * @param itens - `quadrosValidos` de uma leitura de texto.
 * @param limite - teto de caracteres do texto final.
 * @returns `{texto, truncado}`.
 */
export function comporTextoDosQuadros(itens, limite) {
  const comTexto = (Array.isArray(itens) ? itens : []).filter(
    (item) => typeof item?.resultado?.texto === 'string' && item.resultado.texto.trim() !== '',
  );
  if (comTexto.length === 0) return { texto: '', truncado: false };
  if (comTexto.length === 1) {
    const bruto = comTexto[0].resultado.texto;
    const teto = Number.isFinite(limite) ? limite : bruto.length;
    if (bruto.length <= teto) return { texto: bruto, truncado: false };
    return { texto: `${bruto.slice(0, teto)}\n[... texto cortado em ${teto} caracteres]`, truncado: true };
  }
  const secoes = [];
  comTexto.forEach((item, indice) => {
    const quadro = item.resultado.quadro ?? {};
    const tituloBruto = typeof quadro.titulo === 'string' && quadro.titulo !== '' ? quadro.titulo : item.resultado.titulo;
    const titulo = typeof tituloBruto === 'string' && tituloBruto !== '' ? `: ${tituloBruto}` : '';
    const url = typeof quadro.url === 'string' && quadro.url !== '' ? ` (${quadro.url})` : '';
    secoes.push(`## ${rotuloDoQuadro(quadro, indice)}${titulo}${url}\n\n${item.resultado.texto}`);
  });
  const junto = secoes.join('\n\n');
  const teto = Number.isFinite(limite) ? limite : junto.length;
  if (junto.length <= teto) return { texto: junto, truncado: false };
  return { texto: `${junto.slice(0, teto)}\n[... texto cortado em ${teto} caracteres]`, truncado: true };
}

/**
 * Junta os elementos acionáveis de todos os quadros.
 *
 * O seletor devolvido já carrega o id do quadro (`data-dsh-nav="qab12:3"`), então
 * ele é único no navegador inteiro. O rótulo na frente é só para o agente
 * escolher a olho quando quiser passar `quadro` explicitamente.
 * @param itens - `quadrosValidos` de uma leitura de elementos.
 * @returns `{itens, resumo}`.
 */
export function comporElementosDosQuadros(itens) {
  const lista = (Array.isArray(itens) ? itens : []).filter(
    (item) => Array.isArray(item?.resultado?.itens) && item.resultado.itens.length > 0,
  );
  const total = lista.reduce((soma, item) => soma + item.resultado.itens.length, 0);
  if (total === 0) {
    return { itens: [], resumo: 'nenhum elemento acionavel visivel casou com o seletor' };
  }
  const comRotulo = lista.length > 1;
  const saida = [];
  for (const item of lista) {
    const quadro = item.resultado.quadro ?? {};
    const indice = itens.indexOf(item);
    for (const linha of item.resultado.itens) {
      saida.push(comRotulo ? `[${rotuloDoQuadro(quadro, indice)}] ${linha}` : linha);
    }
  }
  const quadros = lista.length;
  return {
    itens: saida,
    resumo: `${saida.length} elemento(s) acionavel(is)${quadros > 1 ? ` em ${quadros} quadros` : ''}; use o seletor [data-dsh-nav="..."] em navegador_agir`,
  };
}

/**
 * Junta a seleção do usuário dos quadros.
 *
 * A seleção do navegador vive em um quadro por vez, então o normal é vir de um
 * só. Quando vem de mais de um (seleção preservada em quadro de fundo), cada
 * trecho ganha o rótulo do quadro.
 * @param itens - `quadrosValidos` de uma leitura de seleção.
 * @returns `{selecao}`.
 */
export function comporSelecaoDosQuadros(itens) {
  const partes = (Array.isArray(itens) ? itens : []).filter(
    (item) => typeof item?.resultado?.selecao === 'string' && item.resultado.selecao.trim() !== '',
  );
  if (partes.length === 0) return { selecao: '' };
  if (partes.length === 1) return { selecao: partes[0].resultado.selecao };
  return {
    selecao: partes
      .map((item) => `[${rotuloDoQuadro(item.resultado.quadro ?? {}, itens.indexOf(item))}]\n${item.resultado.selecao}`)
      .join('\n\n'),
  };
}

/**
 * Junta o estado de rolagem dos quadros.
 * @param itens - `quadrosValidos` de uma leitura de rolagem.
 * @returns `{rolagem}` com uma linha por quadro.
 */
export function comporRolagemDosQuadros(itens) {
  const comEstado = (Array.isArray(itens) ? itens : []).filter(
    (item) => Array.isArray(item?.resultado?.rolagem) && item.resultado.rolagem.length > 0,
  );
  if (comEstado.length === 0) return { rolagem: [] };
  const linhas = [];
  for (const item of comEstado) {
    const prefixo = comEstado.length > 1 ? `[${rotuloDoQuadro(item.resultado.quadro ?? {}, itens.indexOf(item))}] ` : '';
    for (const linha of item.resultado.rolagem) linhas.push(`${prefixo}${linha}`);
  }
  return { rolagem: linhas };
}

/**
 * Escolhe em qual quadro executar uma ação com seletor.
 *
 * Ordem: o quadro pedido explicitamente pelo agente, senão o principal quando ele
 * casa, senão o único quadro que casou. Dois quadros que não o principal casando
 * ao mesmo tempo é ambiguidade: escolher o primeiro em silêncio é como o agente
 * acaba clicando no anúncio em vez do botão.
 * @param itens - `quadrosValidos` de `localizarNaPagina`.
 * @param quadroId - id do quadro pedido (opcional).
 * @returns `{escolhido}`, ou `{erro}` com a lista de quadros para o agente.
 */
export function escolherQuadroParaAcao(itens, quadroId) {
  const lista = Array.isArray(itens) ? itens : [];
  const pedido = typeof quadroId === 'string' ? quadroId.trim() : '';
  const etiquetar = (item, indice) => {
    const quadro = item?.resultado?.quadro ?? {};
    const titulo = typeof quadro.titulo === 'string' && quadro.titulo !== '' ? ` ${JSON.stringify(quadro.titulo)}` : '';
    const url = typeof quadro.url === 'string' && quadro.url !== '' ? ` (${quadro.url})` : '';
    return `${rotuloDoQuadro(quadro, indice)}${titulo}${url}`;
  };
  if (pedido !== '') {
    const alvo = lista.find((item) => String(item?.resultado?.quadro?.id ?? '') === pedido);
    if (alvo === undefined) {
      return { erro: `o quadro ${pedido} nao existe mais nesta aba; leia de novo para pegar o id atual. Quadros: ${lista.map(etiquetar).join(' ; ')}` };
    }
    const casam = Number(alvo?.resultado?.casam ?? 0);
    if (casam === 0) {
      return { erro: `o seletor nao casou no quadro ${pedido}. Quadros: ${lista.map(etiquetar).join(' ; ')}` };
    }
    return { escolhido: alvo };
  }
  const candidatos = lista.filter((item) => Number(item?.resultado?.casam ?? 0) > 0);
  if (candidatos.length === 0) {
    const quadros = lista.map(etiquetar).join(' ; ');
    return { erro: `nao achei nenhum elemento visivel com esse seletor${quadros === '' ? '' : `. Quadros lidos: ${quadros}`}` };
  }
  if (candidatos.length === 1) return { escolhido: candidatos[0] };
  const principal = candidatos.find((item) => item?.resultado?.quadro?.principal === true || item?.frameId === 0);
  if (principal !== undefined) return { escolhido: principal, motivo: 'varios quadros casaram; usei o principal' };
  const quadros = candidatos.map(etiquetar).join(' ; ');
  return { erro: `o seletor casou em ${candidatos.length} quadros: ${quadros}. Leia os elementos e passe "quadro" com o id do quadro certo.` };
}

/**
 * Escolhe em qual quadro rolar.
 *
 * O principal ganha quando ele tem área rolável, porque é o que o usuário está
 * olhando. Quando o aplicativo não rola a janela (Slack, Gmail e afins), o
 * `rolarNaPagina` já descobre o container interno e devolve `rolavel: true` no
 * principal, então o caso comum nem chega nos iframes.
 * @param itens - `quadrosValidos` de `rolarNaPagina({modo:'procurar'})`.
 * @param quadroId - id do quadro pedido (opcional).
 * @returns `{escolhido}`, ou `{erro}`.
 */
export function escolherQuadroDeRolagem(itens, quadroId) {
  const lista = Array.isArray(itens) ? itens : [];
  const pedido = typeof quadroId === 'string' ? quadroId.trim() : '';
  if (pedido !== '') {
    const alvo = lista.find((item) => String(item?.resultado?.quadro?.id ?? '') === pedido);
    if (alvo === undefined) return { erro: `o quadro ${pedido} nao existe mais nesta aba; leia de novo para pegar o id atual` };
    return { escolhido: alvo };
  }
  const rolaveis = lista.filter((item) => item?.resultado?.rolavel === true);
  if (rolaveis.length === 0) {
    return { erro: 'a pagina e os quadros dela nao tem area rolavel: nada para rolar' };
  }
  const principal = rolaveis.find((item) => item?.resultado?.quadro?.principal === true || item?.frameId === 0);
  if (principal !== undefined) return { escolhido: principal };
  const ordenados = [...rolaveis].sort((a, b) => Number(b?.resultado?.restante ?? 0) - Number(a?.resultado?.restante ?? 0));
  return { escolhido: ordenados[0] };
}

/**
 * Escolhe de qual quadro vem o texto a copiar.
 *
 * O agente pode apontar o quadro, mas o caso comum é não apontar: vale o quadro
 * que tem texto de verdade, começando pelo principal. Copiar o texto de um iframe
 * de anúncio porque ele veio primeiro na lista seria pior que não copiar nada.
 * @param itens - `quadrosValidos` de `lerParaCopiar`.
 * @param quadroId - id do quadro pedido (opcional).
 * @returns `{escolhido}`, ou `{erro}`.
 */
export function escolherQuadroDeTexto(itens, quadroId) {
  const lista = Array.isArray(itens) ? itens : [];
  const comTexto = lista.filter(
    (item) => typeof item?.resultado?.texto === 'string' && item.resultado.texto.trim() !== '',
  );
  const pedido = typeof quadroId === 'string' ? quadroId.trim() : '';
  if (pedido !== '') {
    const alvo = lista.find((item) => String(item?.resultado?.quadro?.id ?? '') === pedido);
    if (alvo === undefined) return { erro: `o quadro ${pedido} nao existe mais nesta aba; leia de novo para pegar o id atual` };
    return { escolhido: alvo };
  }
  if (comTexto.length === 0) return { erro: 'nao achei texto para copiar nesta aba: selecione um trecho ou passe um seletor' };
  const principal = comTexto.find((item) => item?.resultado?.quadro?.principal === true || item?.frameId === 0);
  if (principal !== undefined) return { escolhido: principal };
  return { escolhido: comTexto[0] };
}

/** Resumo para o agente depois de rolar. */
export function resumoDaRolagem(quadro, resultado) {
  const alvo = typeof resultado?.alvo === 'string' && resultado.alvo !== '' ? resultado.alvo : 'a pagina';
  const posicao = Number.isFinite(resultado?.posicao) ? `, agora em ${resultado.posicao}px` : '';
  const restante = Number.isFinite(resultado?.restante) ? `, faltam ${resultado.restante}px` : '';
  const titulo = typeof quadro?.titulo === 'string' && quadro.titulo !== '' ? ` (${quadro.titulo})` : '';
  return `rolei ${alvo}${titulo}${posicao}${restante}`;
}
