/*
 * Confere a tabela de envelope do painel contra os descritores da versão do DSH
 * instalada.
 *
 * Por que isto existe: o gateway valida os nomes de argumento exatamente contra o
 * descritor, e o envelope NÃO é sempre `request`. Em 21/10/2026, ao subir para o
 * DSH Desktop 0.12.1, a ponte parou inteira por isso (o Peer), e no mesmo dia o
 * formato do descritor mudou e a ferramenta de mapeamento passou a devolver zero
 * endpoints sem avisar. Ler a tabela do `api.js` e comparar com o descritor real
 * transforma essa classe de deriva em falha de teste, em vez de rodada de
 * tentativa e erro contra o gateway.
 *
 * Uso:
 *   node conferir-envelope.mjs            confere só os endpoints permitidos pela ponte
 *   node conferir-envelope.mjs --todos    confere também os que estão na tabela
 *
 * Sai com código 1 quando um envelope não bate.
 */

import { envelope } from '../extensao/painel/api.js';
import { fluxoPermitidos, rpcPermitidos } from '../plugin/protocol.js';
import { lerDescritores } from './descritores.mjs';

const CHAVES_DE_ENVELOPE = new Set(['request', '_request']);

/** O que o painel manda no fio para este endpoint, em termos de chaves. */
function chavesDoPainel(endpoint) {
  return Object.keys(envelope(endpoint, {}));
}

const { versao, endpoints, formatos } = lerDescritores();
if (endpoints.length === 0) {
  console.error('nenhum descritor lido do app.asar; o formato mudou de novo (ver descritores.mjs).');
  process.exit(1);
}

const porEndpoint = new Map();
for (const item of endpoints) if (!porEndpoint.has(item.endpoint)) porEndpoint.set(item.endpoint, item);

const conferidos = [...new Set([...rpcPermitidos(), ...fluxoPermitidos()])].sort();
const resultados = [];

for (const endpoint of conferidos) {
  const descritor = porEndpoint.get(endpoint);
  if (descritor === undefined) {
    resultados.push({ endpoint, estado: 'ausente', detalhe: 'permitido pela ponte, mas não existe nos descritores desta versão' });
    continue;
  }
  const doPainel = chavesDoPainel(endpoint);
  const doGateway = descritor.chaves.map((c) => c.fio);
  const envelopeDoPainel = doPainel.find((k) => CHAVES_DE_ENVELOPE.has(k));
  const envelopeDoGateway = doGateway.find((k) => CHAVES_DE_ENVELOPE.has(k));

  if (envelopeDoPainel === undefined && envelopeDoGateway === undefined) {
    resultados.push({ endpoint, estado: 'ok', detalhe: 'sem envelope dos dois lados' });
    continue;
  }
  if (envelopeDoPainel === envelopeDoGateway) {
    resultados.push({ endpoint, estado: 'ok', detalhe: `{ ${envelopeDoPainel}: ... }` });
    continue;
  }
  resultados.push({
    endpoint,
    estado: 'falha',
    detalhe: `painel manda ${envelopeDoPainel === undefined ? 'args soltos' : `{ ${envelopeDoPainel} }`}, gateway espera ${
      envelopeDoGateway === undefined ? 'args soltos' : `{ ${envelopeDoGateway} }`
    }`,
  });
}

const falhas = resultados.filter((r) => r.estado === 'falha');
const ausentes = resultados.filter((r) => r.estado === 'ausente');

console.log(`envelope x descritores do DSH Desktop ${versao} (${formatos.join(', ')})`);
console.log(`${conferidos.length} endpoint(s) permitido(s) pela ponte; ${endpoints.length} descritor(es) lido(s)\n`);

for (const item of falhas) console.log(`  \x1b[31mfalha\x1b[0m ${item.endpoint.padEnd(38)} ${item.detalhe}`);
for (const item of ausentes) console.log(`  \x1b[33mausente\x1b[0m ${item.endpoint.padEnd(36)} ${item.detalhe}`);
const ok = resultados.length - falhas.length - ausentes.length;
console.log(`\n${ok} ok, ${falhas.length} falha(s), ${ausentes.length} ausente(s)`);
console.log(falhas.length === 0 ? '\x1b[32mTUDO OK\x1b[0m' : '\x1b[31mNAO PASSOU\x1b[0m');
process.exit(falhas.length === 0 ? 0 : 1);
