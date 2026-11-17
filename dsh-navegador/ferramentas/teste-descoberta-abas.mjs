/*
 * Prova que a descoberta da ponte acha a porta viva do DSH pela aba aberta,
 * sem ninguem digitar endereco. Rodar da pasta do add-on:
 *   node ferramentas\teste-descoberta-abas.mjs
 */
import { candidatosDasAbas, candidatosBase, descobrirPonte } from '../extensao/comum.js';

const ABAS = [
  { url: 'http://127.0.0.1:59293/?token=NAO_IMPRIMIR' },
  { url: 'chrome://extensions/' },
  { url: 'https://servidor.tail056d02.ts.net:9090/' },
  { url: 'http://127.0.0.1:8799/v1/models' },
];

globalThis.chrome = { tabs: { query: async () => ABAS } };

console.log('candidatosBase("")   ->', candidatosBase('').join(' '));
console.log('candidatosDasAbas()  ->', (await candidatosDasAbas()).join(' '));

const comAbas = await descobrirPonte('');
console.log('com abas             ->', comAbas === null ? 'NADA' : `${comAbas.baseUrl} protocolo=${comAbas.protocolo} cwd=${comAbas.addon?.cwd ?? '-'}`);

delete globalThis.chrome;
const semAbas = await descobrirPonte('');
console.log('sem abas (so a lista fixa) ->', semAbas === null ? 'NADA (era o defeito)' : semAbas.baseUrl);
