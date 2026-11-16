/*
 * Teste de bancada dos quadros (iframe) e da escolha do alvo de rolagem.
 *
 * `extensao/quadros.js` é puro de propósito: ele junta o que cada quadro
 * devolveu e decide em qual deles agir, sem tocar no DOM. Por isso roda aqui no
 * Node, sem navegador e sem espera, e cobre justamente a parte que erro nenhum de
 * sintaxe pega: um único quadro que devolve texto não pode ganhar cabeçalho, dois
 * quadros precisam dos rótulos, e seletor que casa em dois iframes não pode
 * escolher um em silêncio.
 *
 * Uso: node testar-quadros.mjs
 */

import {
  comporElementosDosQuadros,
  comporRolagemDosQuadros,
  comporSelecaoDosQuadros,
  comporTextoDosQuadros,
  descreverQuadro,
  descreverQuadros,
  escolherQuadroDeRolagem,
  escolherQuadroDeTexto,
  escolherQuadroParaAcao,
  quadrosValidos,
  resumoDaRolagem,
  rotuloDoQuadro,
} from '../extensao/quadros.js';

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

/** Quadro de mentira, no formato que `lerNaPagina` devolve. */
function quadro(id, extra = {}) {
  return { id, url: extra.url ?? `https://exemplo.test/${id}`, titulo: extra.titulo ?? `Quadro ${id}`, principal: extra.principal === true };
}

function leitura(id, payload, principal = false) {
  return { resultado: { quadro: quadro(id, { principal }), ...payload } };
}

/** Item de `localizarNaPagina`. */
function localizacao(frameId, id, casam, principal = false) {
  return { frameId, resultado: { quadro: quadro(id, { principal }), casam, resumo: `${casam} elemento(s)` } };
}

/** Item de `rolarNaPagina({modo:'procurar'})`. */
function rolagem(frameId, id, rolavel, restante, principal = false) {
  return {
    frameId,
    resultado: { quadro: quadro(id, { principal }), rolavel, restante, alvo: principal ? 'a pagina' : '<div.scroller>' },
  };
}

// ---------------------------------------------------------------------------
// 1. formato e rótulos
// ---------------------------------------------------------------------------

console.log('\n1. formato e rótulos');

const descrito = descreverQuadro({ id: 'qab12', url: 'https://a.test/', titulo: 'T', principal: true, moldura: 'iframe#x' });
conferir('descreverQuadro mantém id, url e principal', descrito.id === 'qab12' && descrito.url === 'https://a.test/' && descrito.principal === true);
conferir('descreverQuadro não vaza campos do DOM', descrito.titulo === undefined && descrito.moldura === undefined);
conferir('descreverQuadro aceita lixo', descreverQuadro(null) === null && descreverQuadro('x') === null);
conferir('descreverQuadros pula item sem quadro', descreverQuadros([leitura('a', { texto: 'x' }, true), { resultado: {} }, null]).length === 1);
conferir('rótulo do principal', rotuloDoQuadro(quadro('a', { principal: true }), 0) === 'Quadro 1 (principal)');
conferir('rótulo de iframe', rotuloDoQuadro(quadro('b'), 2) === 'Quadro 3');

// ---------------------------------------------------------------------------
// 2. quadrosValidos
// ---------------------------------------------------------------------------

console.log('\n2. quadrosValidos');

const brutos = [
  { frameId: 7, result: { quadro: quadro('b', { principal: false }), texto: 'dentro' } },
  { frameId: 0, result: { quadro: quadro('a', { principal: true }), texto: 'fora' } },
  { frameId: 9, result: undefined },
  { frameId: 11, result: { erro: 'sem acesso' } },
  null,
];
const validos = quadrosValidos(brutos);
conferir('descarta resultado nulo', validos.length === 2, `${validos.length} válidos`);
conferir('descarta quadro com erro', validos.every((item) => item.resultado.erro === undefined));
conferir('principal vem primeiro', validos[0].frameId === 0 && validos[1].frameId === 7);
conferir('lista vazia não explode', quadrosValidos(undefined).length === 0 && quadrosValidos([]).length === 0);

// ---------------------------------------------------------------------------
// 3. composição do texto
// ---------------------------------------------------------------------------

console.log('\n3. composição do texto');

const soPrincipal = comporTextoDosQuadros([leitura('a', { texto: 'conteudo da pagina' }, true)], 1000);
conferir('um quadro só não ganha cabeçalho', soPrincipal.texto === 'conteudo da pagina' && soPrincipal.truncado === false);

const comIframe = comporTextoDosQuadros(
  [
    { frameId: 0, resultado: { quadro: { id: 'a', url: 'https://exemplo.test/a', titulo: 'Pagina', principal: true }, texto: 'moldura' } },
    { frameId: 4, resultado: { quadro: { id: 'b', url: 'https://exemplo.test/b', titulo: 'Chat', principal: false }, texto: 'conversa do chat' } },
  ],
  1000,
);
conferir('dois quadros têm cabeçalho de cada um', comIframe.texto.includes('## Quadro 1 (principal)') && comIframe.texto.includes('## Quadro 2'));
conferir('cabeçalho leva título e url', comIframe.texto.includes('Chat') && comIframe.texto.includes('https://exemplo.test/b'));
conferir('texto dos dois quadros entra', comIframe.texto.includes('moldura') && comIframe.texto.includes('conversa do chat'));

const vazio = comporTextoDosQuadros([leitura('a', {}), leitura('b', { texto: '   ' })], 100);
conferir('quadros sem texto devolvem vazio', vazio.texto === '' && vazio.truncado === false);

const cortado = comporTextoDosQuadros([leitura('a', { texto: 'x'.repeat(500) }, true)], 100);
conferir('texto cortado avisa', cortado.truncado === true && cortado.texto.includes('texto cortado em 100 caracteres'));
conferir('corte não passa do limite + aviso', cortado.texto.length < 500);

const multiCortado = comporTextoDosQuadros(
  [leitura('a', { texto: 'a'.repeat(60) }, true), leitura('b', { texto: 'b'.repeat(60) })],
  80,
);
conferir('corte vale para o texto composto', multiCortado.truncado === true && multiCortado.texto.includes('texto cortado'));

// ---------------------------------------------------------------------------
// 4. elementos, seleção e rolagem
// ---------------------------------------------------------------------------

console.log('\n4. elementos, seleção e rolagem');

const elementos = comporElementosDosQuadros([
  leitura('a', { itens: ['[data-dsh-nav="qa:1"] <button> "Entrar"'] }, true),
  leitura('b', { itens: ['[data-dsh-nav="qb:1"] <textarea> "Oi"'] }),
]);
conferir('elementos dos dois quadros entram', elementos.itens.length === 2);
conferir('cada elemento leva o rótulo do quadro', elementos.itens[1].startsWith('[Quadro 2]') && elementos.itens[0].startsWith('[Quadro 1 (principal)]'));
conferir('resumo cita os quadros', elementos.resumo.includes('2 quadros'));
conferir('seletor do elemento continua único', elementos.itens[1].includes('data-dsh-nav="qb:1"'));

const semElementos = comporElementosDosQuadros([leitura('a', { itens: [] }, true)]);
conferir('nenhum elemento devolve resumo claro', semElementos.itens.length === 0 && semElementos.resumo.includes('nenhum elemento'));

const selecao = comporSelecaoDosQuadros([leitura('a', { selecao: 'texto escolhido' }, true)]);
conferir('seleção de um quadro sai crua', selecao.selecao === 'texto escolhido');
const semSelecao = comporSelecaoDosQuadros([leitura('a', { selecao: '  ' }, true)]);
conferir('seleção vazia sai vazia', semSelecao.selecao === '');
const selecaoDupla = comporSelecaoDosQuadros([leitura('a', { selecao: 'um' }, true), leitura('b', { selecao: 'dois' })]);
conferir('seleção de dois quadros ganha rótulo', selecaoDupla.selecao.includes('Quadro 2') && selecaoDupla.selecao.includes('dois'));

const rolagemComposta = comporRolagemDosQuadros([
  leitura('a', { rolagem: ['a pagina: 0px de 1200px rolaveis'] }, true),
  leitura('b', { rolagem: ['<div.list> 12: 0px de 900px rolaveis'] }),
]);
conferir('rolagem dos dois quadros entra', rolagemComposta.rolagem.length === 2);
conferir('rolagem de iframe ganha rótulo', rolagemComposta.rolagem[1].startsWith('[Quadro 2]'));
conferir('sem rolagem devolve lista vazia', comporRolagemDosQuadros([leitura('a', { rolagem: [] }, true)]).rolagem.length === 0);

// ---------------------------------------------------------------------------
// 5. escolha do quadro para a ação
// ---------------------------------------------------------------------------

console.log('\n5. escolha do quadro para a ação');

const umCandidato = escolherQuadroParaAcao([localizacao(0, 'qa', 1, true), localizacao(4, 'qb', 0)], '');
conferir('um candidato é escolhido', umCandidato.escolhido?.frameId === 0);

const preferindoPrincipal = escolherQuadroParaAcao([localizacao(9, 'qb', 2), localizacao(0, 'qa', 1, true)], '');
conferir('com dois candidatos, o principal ganha', preferindoPrincipal.escolhido?.frameId === 0);

const ambiguo = escolherQuadroParaAcao([localizacao(5, 'qb', 1), localizacao(7, 'qc', 1)], '');
conferir('dois iframes casando é ambiguidade, não escolha', ambiguo.erro !== undefined && ambiguo.erro.includes('casou em 2 quadros'));
conferir('mensagem de ambiguidade lista os quadros', ambiguo.erro.includes('Quadro 1') && ambiguo.erro.includes('Quadro 2'));

const semCandidato = escolherQuadroParaAcao([localizacao(0, 'qa', 0, true)], '');
conferir('sem candidato explica e lista quadros', semCandidato.erro.includes('nao achei nenhum elemento') && semCandidato.erro.includes('https://exemplo.test/qa'));

const porId = escolherQuadroParaAcao([localizacao(0, 'qa', 3, true), localizacao(6, 'qb', 1)], 'qb');
conferir('quadro pedido explicitamente ganha do principal', porId.escolhido?.frameId === 6);

const idSumiu = escolherQuadroParaAcao([localizacao(0, 'qa', 1, true)], 'qz');
conferir('quadro que não existe mais falha claro', idSumiu.erro !== undefined && idSumiu.erro.includes('nao existe mais'));

const idSemElemento = escolherQuadroParaAcao([localizacao(0, 'qa', 1, true), localizacao(6, 'qb', 0)], 'qb');
conferir('quadro certo sem o elemento falha', idSemElemento.erro !== undefined && idSemElemento.erro.includes('nao casou no quadro'));

// ---------------------------------------------------------------------------
// 6. escolha do quadro para a rolagem e da origem do texto
// ---------------------------------------------------------------------------

console.log('\n6. rolagem e origem do texto');

const paginaRola = escolherQuadroDeRolagem([rolagem(0, 'qa', true, 800, true), rolagem(5, 'qb', true, 3000)], '');
conferir('principal rolável ganha', paginaRola.escolhido?.frameId === 0);

const soIframeRola = escolherQuadroDeRolagem([rolagem(0, 'qa', false, 0, true), rolagem(3, 'qb', true, 400), rolagem(8, 'qc', true, 1200)], '');
conferir('sem principal, o quadro com mais rolagem ganha', soIframeRola.escolhido?.frameId === 8);

const nadaRola = escolherQuadroDeRolagem([rolagem(0, 'qa', false, 0, true)], '');
conferir('nada rolável falha com explicação', nadaRola.erro !== undefined && nadaRola.erro.includes('nao tem area rolavel'));

const rolagemPorId = escolherQuadroDeRolagem([rolagem(0, 'qa', true, 800, true), rolagem(3, 'qb', true, 400)], 'qb');
conferir('rolagem aceita o quadro pedido', rolagemPorId.escolhido?.frameId === 3);

const textoPrincipal = escolherQuadroDeTexto([leitura('qa', { texto: 'principal' }, true), leitura('qb', { texto: 'iframe' })], '');
conferir('texto prefere o principal', textoPrincipal.escolhido?.resultado?.texto === 'principal');
const textoNoIframe = escolherQuadroDeTexto([leitura('qa', { texto: '' }, true), leitura('qb', { texto: 'so no iframe' })], '');
conferir('sem texto no principal, copia do iframe', textoNoIframe.escolhido?.resultado?.texto === 'so no iframe');
const textoVazio = escolherQuadroDeTexto([leitura('qa', { texto: '   ' }, true)], '');
conferir('sem texto nenhum explica', textoVazio.erro !== undefined && textoVazio.erro.includes('nao achei texto'));
const textoPorId = escolherQuadroDeTexto([leitura('qa', { texto: 'principal' }, true), leitura('qb', { texto: 'iframe' })], 'qb');
conferir('texto aceita o quadro pedido', textoPorId.escolhido?.resultado?.texto === 'iframe');

const resumo = resumoDaRolagem(quadro('a', { principal: true }), { alvo: '<div.lista>', posicao: 600, restante: 400 });
conferir('resumo da rolagem cita alvo, posição e resto', resumo.includes('<div.lista>') && resumo.includes('600px') && resumo.includes('400px'));

console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
process.exit(placar.falhou === 0 ? 0 : 1);
