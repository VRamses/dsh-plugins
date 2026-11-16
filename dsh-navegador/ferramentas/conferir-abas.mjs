/*
 * Confere a escolha da aba alvo (`casarAba`) e a decoracao da aba no painel.
 *
 * O painel nao roda no Node (e extensao de navegador, com DOM e `chrome`), mas
 * estas duas funcoes sao puras. O teste extrai o texto delas do proprio
 * painel.js, como faz o `conferir-projecao-aba.mjs`, e roda de verdade: o que
 * interessa aqui e a regra, nao a fiacao.
 *
 * Por que a regra importa: o parametro `aba` aceita id ou trecho de titulo, e o
 * modo de falha perigoso e escolher a aba errada em silencio. Aba errada com o
 * agente digitando dentro e pior do que recusar e pedir o id.
 *
 * Uso: node conferir-abas.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAINEL = join(import.meta.dirname, '..', 'extensao', 'painel', 'painel.js');
const fonte = readFileSync(PAINEL, 'utf8');

/** Copia o texto de um trecho balanceado que comeca em `inicio`. */
function trecho(inicio) {
  const i = fonte.indexOf(inicio);
  if (i < 0) throw new Error(`nao achei "${inicio}"`);
  let profundidade = 0;
  for (let p = i; p < fonte.length; p += 1) {
    if (fonte[p] === '{') profundidade += 1;
    else if (fonte[p] === '}') {
      profundidade -= 1;
      if (profundidade === 0) return fonte.slice(i, p + 1);
    }
  }
  throw new Error('trecho nao fechou');
}

const fabrica = new Function(`
let ui = { aba: null };
${trecho('function decorarAba(aba) {')}
${trecho('function normalizarTexto(texto) {')}
${trecho('function etiquetaDaAba(aba) {')}
${trecho('function casarAba(abas, alvo) {')}
return {
  decorarAba,
  normalizarTexto,
  etiquetaDaAba,
  casarAba,
  fixarNoPainel: (aba) => { ui.aba = aba; },
  verFixada: () => ui.aba,
};
`);
const { decorarAba, normalizarTexto, etiquetaDaAba, casarAba, fixarNoPainel } = fabrica();

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

/** Lista de abas no formato que o painel entrega ao casador. */
function abas() {
  return [
    decorarAba({ id: 101, titulo: 'Miro | Quadro do fluxo', url: 'https://miro.com/app/board/1', ativa: false, janelaId: 7 }),
    decorarAba({ id: 102, titulo: 'Zendesk - Ticket 4321', url: 'https://neilpatel.zendesk.com/agent/tickets/4321', ativa: false, janelaId: 7 }),
    decorarAba({ id: 103, titulo: 'Documentação interna', url: 'https://exemplo.com/docs', ativa: true, janelaId: 7 }),
    decorarAba({ id: 104, titulo: 'Slack', url: 'https://app.slack.com/client/T1', ativa: false, janelaId: 8 }),
  ];
}

function erroDe(acao) {
  try {
    acao();
    return null;
  } catch (erro) {
    return erro.message;
  }
}

console.log('escolha da aba alvo');

// -------------------------------------------------------------------------
// 1. decoracao
// -------------------------------------------------------------------------

console.log('\n1. decoracao da aba');
fixarNoPainel(null);
const semFixada = decorarAba({ id: 101, titulo: 'x', url: 'u', ativa: true, janelaId: 7 });
conferir('sem aba fixada, nenhuma e fixada', semFixada.fixada === false);
conferir('a janela vem do janelaId', semFixada.janela === 7 && semFixada.janelaId === 7, JSON.stringify({ janela: semFixada.janela }));
conferir('ativa e preservada', semFixada.ativa === true);
conferir('aba nula nao vira objeto', decorarAba(null) === null && decorarAba(undefined) === null);

fixarNoPainel({ id: 101, url: 'u', titulo: 'x' });
const fixada = decorarAba({ id: 101, titulo: 'x', url: 'u', ativa: true });
conferir('a aba fixada no painel e marcada', fixada.fixada === true);
conferir('outra aba nao e marcada como fixada', decorarAba({ id: 102, titulo: 'y', url: 'u2' }).fixada === false);
conferir('janela da lista (`janela`) e entendida', decorarAba({ id: 9, url: 'u', janela: 3 }).janela === 3);
fixarNoPainel(null);

// -------------------------------------------------------------------------
// 2. normalizacao e etiqueta
// -------------------------------------------------------------------------

console.log('\n2. normalizacao e etiqueta');
conferir('sem acento, sem caixa e sem espaco sobrando', normalizarTexto('  Documentação  ') === 'documentacao');
conferir('negrito de nada quebra', normalizarTexto('MIRÓ') === 'miro');

const etiqueta = etiquetaDaAba(decorarAba({ id: 102, titulo: 'Ticket', url: 'https://z/1', ativa: true }));
conferir('a etiqueta traz id, titulo, url e marcas', etiqueta.includes('102') && etiqueta.includes('Ticket') && etiqueta.includes('https://z/1') && etiqueta.includes('ativa'));
conferir('a marca de fixada aparece na etiqueta', (() => {
  // `decorarAba` e quem decide `fixada` (compara com a aba fixada no painel),
  // entao o teste fixa a aba antes de decorar: passar `fixada: true` na mao
  // seria testar o contrario do que o painel faz.
  fixarNoPainel({ id: 1, url: 'https://z/2' });
  const marcada = etiquetaDaAba(decorarAba({ id: 1, url: 'https://z/2' }));
  fixarNoPainel(null);
  return marcada.includes('fixada no painel');
})());

// -------------------------------------------------------------------------
// 3. por id
// -------------------------------------------------------------------------

console.log('\n3. por id');
conferir('id em texto acha a aba', casarAba(abas(), '101').id === 101);
conferir('id com espaco em volta acha a aba', casarAba(abas(), ' 104 ').id === 104);
const erroId = erroDe(() => casarAba(abas(), '999'));
conferir('id inexistente falha', erroId !== null && erroId.includes('999'));
conferir('id inexistente lista as abas abertas', erroId !== null && erroId.includes('Miro'));

// -------------------------------------------------------------------------
// 4. por trecho de titulo e de url
// -------------------------------------------------------------------------

console.log('\n4. por trecho');
conferir('trecho do titulo acha a aba', casarAba(abas(), 'miro').id === 101);
conferir('trecho do titulo ignora caixa', casarAba(abas(), 'MIRO').id === 101);
conferir('trecho sem acento acha titulo com acento', casarAba(abas(), 'documentacao').id === 103);
conferir('trecho da url acha a aba', casarAba(abas(), 'zendesk.com/agent').id === 102);
const erroVazio = erroDe(() => casarAba(abas(), 'zzz'));
conferir('trecho que nao casa falha com a lista', erroVazio !== null && erroVazio.includes('nenhuma aba casa') && erroVazio.includes('Slack'));

// -------------------------------------------------------------------------
// 5. ambiguidade
// -------------------------------------------------------------------------

console.log('\n5. ambiguidade');
const duasIguais = [
  decorarAba({ id: 1, titulo: 'Ticket 10', url: 'https://a/1' }),
  decorarAba({ id: 2, titulo: 'Ticket 11', url: 'https://a/2' }),
];
const erroAmbiguo = erroDe(() => casarAba(duasIguais, 'ticket'));
conferir('ambiguo sem fixada nem ativa falha em vez de chutar', erroAmbiguo !== null && erroAmbiguo.includes('casa com 2 abas'));
conferir('a falha manda passar o id', erroAmbiguo !== null && erroAmbiguo.includes('Passe o id'));

const comFixada = [
  decorarAba({ id: 1, titulo: 'Ticket 10', url: 'https://a/1' }),
  decorarAba({ id: 2, titulo: 'Ticket 11', url: 'https://a/2' }),
];
fixarNoPainel({ id: 2, url: 'https://a/2' });
const escolhidaFixada = casarAba(comFixada.map((a) => decorarAba({ id: a.id, url: a.url, titulo: a.titulo })), 'ticket');
conferir('ambiguo com uma fixada escolhe a fixada', escolhidaFixada.id === 2, `id ${escolhidaFixada.id}`);
fixarNoPainel(null);

const comAtiva = [
  decorarAba({ id: 1, titulo: 'Ticket 10', url: 'https://a/1', ativa: true }),
  decorarAba({ id: 2, titulo: 'Ticket 11', url: 'https://a/2', ativa: false }),
];
conferir('ambiguo com uma ativa escolhe a ativa', casarAba(comAtiva, 'ticket').id === 1);

// -------------------------------------------------------------------------
// 6. bordas
// -------------------------------------------------------------------------

console.log('\n6. bordas');
const erroListaVazia = erroDe(() => casarAba([], 'miro'));
conferir('lista vazia falha explicando', erroListaVazia !== null && erroListaVazia.includes('nenhuma aba'));
const erroAlvoVazio = erroDe(() => casarAba(abas(), '   '));
conferir('alvo vazio falha explicando', erroAlvoVazio !== null && erroAlvoVazio.includes('vazio'));
const erroSemTitulo = erroDe(() => casarAba([decorarAba({ id: 5, url: 'https://exemplo.com/sem-titulo' })], 'exemplo'));
conferir('aba sem titulo ainda casa pela url', erroSemTitulo === null);

console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
process.exit(placar.falhou === 0 ? 0 : 1);
