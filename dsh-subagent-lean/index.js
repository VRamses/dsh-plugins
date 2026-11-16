/*
 * dsh-subagent-lean
 *
 * PROBLEMA: os clientes MCP do perfil ficam no Host, entao TODO agente os herda.
 * Um subagente carrega ~295k tokens de schema de tools e passa de 200 tools, o que
 * estoura o contexto do OpenRouter Free, o teto de 128 tools do Groq e faz o Google
 * responder 400 INVALID_ARGUMENT. Medido em 24/10/2026.
 *
 * SOLUCAO: no `agent/created`, se o agente e um subagente (header.origin === 'subagent'),
 * aplica ctx.tools.restrict({ allow }) no contexto DAQUELE agente. O mask so remove
 * tools herdados do Host/ancestrais; tools registradas no proprio escopo do agente
 * continuam visiveis. A conversa principal nao e tocada.
 */

const PADRAO = [
  'read',
  'read_image',
  'write',
  'edit',
  'glob',
  'grep',
  'pwsh',
  'web_search',
  'web_fetch',
  'skill',
  'todo_write',
  'present',
];

export const inject = ['tools'];

function ehSubagente(agent) {
  // O header da sessao carrega origin/parentSession/delegationDepth.
  const header = agent?.session?.header;
  if (header === undefined || header === null) return false;
  if (header.origin === 'subagent') return true;
  if (header.parentSession !== undefined && header.parentSession !== null) return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

export function apply(ctx, config) {
  const allow = Array.isArray(config?.allow) && config.allow.length > 0 ? config.allow : PADRAO;

  ctx.on('agent/created', ({ agent }) => {
    if (!ehSubagente(agent)) return;
    try {
      agent.ctx.tools.restrict({ allow });
    } catch (erro) {
      // Nunca derrubar a criacao do subagente por causa do filtro.
      console.warn(`[dsh-subagent-lean] filtro nao aplicado: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  });
}
