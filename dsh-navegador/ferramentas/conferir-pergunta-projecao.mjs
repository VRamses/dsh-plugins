/**
 * Confere que a projeção de uma pergunta `open` chega no estado do painel como
 * pergunta respondível.
 *
 * Por que este teste existe: até 17/10/2026 o painel desenhava o cartão de
 * resposta só para perguntas em `state: 'continued'`, por acreditar que o método
 * `userQuestions/answer` recusava pergunta aberta. A medição daquele dia mostrou
 * o contrário (resposta "Azul" com a pergunta `open` fechou a pergunta e o turno
 * seguiu), e o filtro passou a ser `open`. Sem este teste, uma mudança futura
 * pode reintroduzir o filtro errado sem ninguém notar, porque o defeito é mudo:
 * a pergunta aparece, mas sem botão.
 *
 * Não precisa da ponte nem de navegador: alimenta o mesmo `aplicarProjecoes` que o
 * painel usa, com um payload recortado de uma resposta real de
 * `session/projections`.
 *
 *   node conferir-pergunta-projecao.mjs
 */

import { aplicarProjecoes, novoEstado } from '../extensao/painel/transcrito.js';

const valores = {
  title: 'Pergunta unica sobre cor',
  agentPreset: 'standard',
  tokenUsage: { uncachedInputTokens: 373048, outputTokens: 80, cacheReadTokens: 2176, cacheWriteTokens: 0 },
  userQuestions: {
    active: [
      {
        callId: 'call_00_ET_YwlLMMMtgUhuxv5SD2Cl8831',
        questions: [
          {
            id: 'cor',
            question: 'Qual cor?',
            header: 'Qual cor?',
            options: [{ label: 'Azul' }, { label: 'Verde' }],
          },
        ],
        state: 'open',
      },
    ],
    settled: [],
  },
};

const estado = novoEstado();
aplicarProjecoes(estado, valores);

const perguntas = Array.isArray(estado.perguntas) ? estado.perguntas : [];
const abertas = perguntas.filter((p) => p?.state === 'open' && typeof p?.callId === 'string');

const checagens = [
  ['a projecao chegou no estado do painel', perguntas.length === 1],
  ['a pergunta tem callId', abertas.length === 1 && abertas[0].callId === 'call_00_ET_YwlLMMMtgUhuxv5SD2Cl8831'],
  ['a pergunta traz as duas opcoes', (abertas[0]?.questions?.[0]?.options ?? []).length === 2],
  ['o id do item e o que a resposta usa', abertas[0]?.questions?.[0]?.id === 'cor'],
  ['sem cartao informativo por cima da respondivel', estado.perguntaPendente === null],
  ['o filtro do painel (state open + callId) encontra a pergunta', abertas.length > 0],
];

let falhas = 0;
for (const [nome, ok] of checagens) {
  console.log(`  ${ok ? 'ok  ' : 'FALHA'}  ${nome}`);
  if (!ok) falhas += 1;
}
console.log(`\n${checagens.length - falhas} ok, ${falhas} falha(s)`);
process.exitCode = falhas === 0 ? 0 : 1;
