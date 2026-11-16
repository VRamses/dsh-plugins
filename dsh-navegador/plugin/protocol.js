/**
 * Contrato da ponte `dsh-navegador`: constantes, versionamento e a lista de
 * endpoints que o add-on do navegador pode alcançar.
 *
 * Este arquivo é a FONTE DA VERDADE do que a ponte aceita. O add-on repete a
 * lista apenas para rotular a interface; quem decide é o `permitido()` daqui.
 *
 * @module dsh-navegador/plugin/protocol
 */

/** Prefixo HTTP de todas as rotas da ponte (irmão do `/api` do DSH). */
export const BASE = '/dsh-navegador';

/**
 * Versão do protocolo da ponte. O add-on recusa um `hello` com número
 * diferente: campo trocado em silêncio é pior que erro na cara.
 */
export const PROTOCOL = 1;

/** Rotas exatas da ponte. */
export const ROTAS = {
  /** Identidade da ponte. Sem token: é o que o add-on usa para achar o DSH. */
  ola: `${BASE}/ola`,
  /** Entrega o token. Sem Bearer, mas só de loopback e nunca com CORS. */
  parear: `${BASE}/parear`,
  /** Diz se o token informado vale. */
  sinal: `${BASE}/sinal`,
  /** Chamada unária: corpo = envelope do DSH, resposta = resultado cru. */
  rpc: `${BASE}/rpc/`,
  /** Stream de eventos: uma linha JSON por quadro (NDJSON). */
  fluxo: `${BASE}/fluxo/`,
  /** Assinatura do add-on para receber pedidos do agente (NDJSON). */
  pedidos: `${BASE}/pedidos`,
  /** Resposta do add-on a um pedido do agente. */
  resposta: `${BASE}/resposta`,
  /** Contexto da aba que o painel está mostrando (o agente cita no tool). */
  aba: `${BASE}/aba`,
};

/** Cabeçalho de autenticação da ponte. */
export const CABECALHO_TOKEN = 'authorization';

/**
 * Endpoints do RPC do DSH que a ponte aceita.
 *
 * O corte não é uma fronteira de segurança contra o AGENTE (ele roda com
 * `danger-full-access` e alcança terminal e arquivos por conta própria). O corte
 * existe pelo outro lado: limita o que uma PÁGINA ou uma extensão comprometida
 * consegue disparar contra o harness pela ponte. Ficam de fora, de propósito:
 * `terminal/*`, `settings/*`, `credentials/*`, `pluginManager/*`,
 * `dynamicCordisRunner/*`, `speech/*` e `fileUploads/*`.
 */
const RPC_PERMITIDOS = new Set([
  // Sessões: é o núcleo do add-on.
  'session/list',
  'session/search',
  'session/page',
  'session/projections',
  'session/create',
  'session/prompt',
  'session/cancel',
  'session/rename',
  'session/fork',
  'session/delete',
  'session/modelCatalog',
  'session/selectModel',
  'session/canOpenWorkspacePath',
  // Perguntas e aprovações: sem isto o agente trava esperando resposta.
  'userQuestions/answer',
  // Objetivo, comandos e skills: leitura barata que melhora a interface.
  'goals/get',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'goals/complete',
  'goals/clear',
  'commands/list',
  'skills/list',
  'fileReferences/list',
  // Conta e modelo: o painel mostra em que conta e com que modelo está falando.
  'account/getProfile',
  'account/getState',
  'account/getBalance',
  'llm/listProviders',
  'llm/discoverModels',
  // Diagnóstico e feedback.
  'pluginInventory/list',
  'messageFeedback/list',
  'messageFeedback/put',
  'messageFeedback/delete',
  'sessionFeedback/record',
  'sessionReferenceResolver/candidates',
  // Trabalho em segundo plano e arquivos do workspace (leitura).
  'job/kill',
  'workspaceFiles/list',
  'workspaceFiles/read',
  'workspaceFiles/stat',
  'agentPresets/list',
  'agentPresets/read',
]);

/** Endpoints de FLUXO (`mode: 'stream'`) que a ponte aceita. */
const FLUXO_PERMITIDOS = new Set([
  'session/follow',
  'session/control',
  'job/list',
  'job/follow',
  'workspace/follow',
  'workspaceFiles/changes',
  'userQuestions/attachWait',
  'account/watch',
  'account/watchExpiry',
]);

/**
 * Diz se um endpoint pode ser chamado pela ponte.
 * @param endpoint - endpoint no formato `namespace/metodo`.
 * @param tipo - `rpc` para unário, `fluxo` para stream.
 * @returns true quando o endpoint está na lista daquele tipo.
 */
export function permitido(endpoint, tipo) {
  if (typeof endpoint !== 'string') return false;
  const tabela = tipo === 'fluxo' ? FLUXO_PERMITIDOS : RPC_PERMITIDOS;
  return tabela.has(endpoint);
}

/** Lista ordenada dos endpoints unários permitidos (para o `/ola`). */
export function rpcPermitidos() {
  return [...RPC_PERMITIDOS].sort();
}

/** Lista ordenada dos endpoints de fluxo permitidos (para o `/ola`). */
export function fluxoPermitidos() {
  return [...FLUXO_PERMITIDOS].sort();
}

/** Versão do formato de linha do NDJSON da ponte. */
export const LINHA_PROTOCOL = 1;

/**
 * Serializa um valor para uma linha NDJSON segura.
 *
 * `Uint8Array` (o gateway entrega bytes crus em alguns resultados) vira base64
 * marcado, porque `JSON.stringify` transformaria o buffer num objeto de índices.
 * @param objeto - valor a serializar.
 * @returns a linha terminada em `\n`.
 */
export function linha(objeto) {
  return `${JSON.stringify(objeto, trocarBinario)}\n`;
}

function trocarBinario(_chave, valor) {
  if (valor instanceof Uint8Array) return { $binario: 'base64', dados: Buffer.from(valor).toString('base64') };
  if (typeof valor === 'bigint') return { $grande: valor.toString() };
  return valor;
}
