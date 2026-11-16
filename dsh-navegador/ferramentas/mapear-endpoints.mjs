/*
 * Imprime, para cada endpoint do DSH, o NOME REAL das chaves de argumento no fio.
 *
 * Existe porque essa é a armadilha mais cara desta ponte: a chave não é sempre
 * `request`. `session/follow` quer `request`, `session/list` quer `_request`, e
 * os endpoints com escopo de agente (`goals/get`, `userQuestions/answer`) querem
 * `agentId` solto. Chutar dá "missing X" no erro, um por um, é lento e frágil; o
 * descritor é a fonte. A leitura do asar mora em `descritores.mjs`, porque o
 * `conferir-envelope.mjs` usa a mesma.
 *
 * Uso:
 *   node mapear-endpoints.mjs                      (todos os endpoints)
 *   node mapear-endpoints.mjs session/ userQuestions/ goals/
 *   node mapear-endpoints.mjs --formato            (só diz qual formato achou)
 */

import { lerDescritores } from './descritores.mjs';

const filtros = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const soFormato = process.argv.includes('--formato');

const { versao, endpoints, formatos } = lerDescritores({ filtros });

if (soFormato) console.log(`DSH Desktop ${versao}; formato(s): ${formatos.join(', ') || 'nenhum'}`);

endpoints.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
const vistos = new Set();
for (const item of endpoints) {
  if (vistos.has(item.endpoint)) continue;
  vistos.add(item.endpoint);
  const chaves = item.chaves
    .map((p) => `${p.fio}${p.origem === 'lookup' || p.origem === 'escopo' ? '(escopo)' : ''}`)
    .join(', ');
  console.log(`${item.endpoint.padEnd(42)} ${item.modo.padEnd(7)} { ${chaves} }`);
}
console.log(`\n${vistos.size} endpoint(s)`);

/*
 * Zero endpoint é sintoma, não resultado: significa que o formato do descritor
 * mudou de novo (foi o que aconteceu entre 0.11 e 0.12). Sair com erro impede
 * que alguém leia "0 endpoints" como "não existe endpoint".
 */
if (vistos.size === 0) {
  console.error('nenhum descritor reconhecido: o formato do typert.host.js mudou. Abra um e ajuste descritores.mjs.');
  process.exitCode = 1;
}
