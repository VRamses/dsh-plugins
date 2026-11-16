// Confere a projecao da aba sem precisar do DSH no ar.
//
// Extrai `projetarAba` e `ABA_SCHEMA` do proprio plugin/ferramentas.js (o arquivo
// importa @deepseek-ai/dsh-tools, entao nao da para importar aqui) e verifica que a
// saida da projecao tem exatamente as chaves declaradas.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ARQUIVO = join(import.meta.dirname, '..', 'plugin', 'ferramentas.js');
const fonte = readFileSync(ARQUIVO, 'utf8');

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

const codigoSchema = `const ABA_SCHEMA = ${trecho('const ABA_SCHEMA = {').replace('const ABA_SCHEMA = ', '')};`;
const codigoProjecao = `${trecho('function projetarAba(aba) {')}`;
const fabrica = new Function(`${codigoSchema}\n${codigoProjecao}\nreturn { ABA_SCHEMA, projetarAba };`);
const { ABA_SCHEMA, projetarAba } = fabrica();

const declaradas = new Set(Object.keys(ABA_SCHEMA.properties));
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

// como a ponte guarda hoje (definirAba em ponte.js)
const daPonte = {
  url: 'file:///C:/x/pagina.html',
  titulo: 'Pagina de teste',
  id: 42,
  janelaId: 7,
  atualizadoEm: '2026-10-17T11:40:00.000Z',
};
const projetada = projetarAba(daPonte);
console.log('entrada:', JSON.stringify(daPonte));
console.log('saida  :', JSON.stringify(projetada), '\n');

conferir('a projecao nao deixa chave fora do schema', Object.keys(projetada).every((k) => declaradas.has(k)), [...new Set(Object.keys(projetada).filter((k) => !declaradas.has(k)))].join(', ') || 'nenhuma');
// A entrada da ponte e o que o DSH recusava: deixar isso explicito na saida do teste
// e o que mostra que a projecao tem funcao, e nao que ela e decorativa.
const sobrando = Object.keys(daPonte).filter((k) => !declaradas.has(k));
conferir('e a entrada da ponte tinha chave fora do schema', sobrando.length === 2, sobrando.join(', '));
conferir('janelaId saiu', projetada.janelaId === undefined);
conferir('atualizadoEm saiu', projetada.atualizadoEm === undefined);
conferir('url preservada', projetada.url === daPonte.url);
conferir('titulo preservado', projetada.titulo === daPonte.titulo);
conferir('id preservado', projetada.id === daPonte.id);
conferir('url e obrigatoria e veio', typeof projetada.url === 'string' && projetada.url !== '');

// casos de borda
conferir('sem aba devolve undefined', projetarAba(null) === undefined && projetarAba(undefined) === undefined);
conferir('aba sem url devolve undefined', projetarAba({ titulo: 'x' }) === undefined);
conferir('titulo vazio nao entra', projetarAba({ url: 'u', titulo: '' })?.titulo === undefined);
conferir('id invalido nao entra', projetarAba({ url: 'u', id: null })?.id === undefined);
conferir('so url continua valido', Object.keys(projetarAba({ url: 'u' })).join(',') === 'url');

console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
process.exit(placar.falhou === 0 ? 0 : 1);
