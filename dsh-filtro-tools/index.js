/*
 * dsh-filtro-tools
 *
 * PROBLEMA: `dsh-ppt-composer` e `dsh-desktop-office` nascem em
 * `C:\Program Files\DSH Desktop\resources\dsh-desktop.patch.yml`, a camada do app,
 * aplicada DEPOIS do patch do perfil e do `harness\cordis.patch.yml`. O `- insert:`
 * dela recria os rows ligados, entao `disabled: true` na secao do
 * `ferramentas\nativos-liga.mjs` nao tem efeito neles (medido em 16/11/2026: 61
 * tools antes e 61 depois, office com 3 e ppt com 11).
 *
 * SOLUCAO: no `agent/created`, aplica `ctx.tools.restrict({ deny })` no contexto
 * DAQUELE agente, antes do primeiro request. O mask vale para o schema enviado em
 * todo passo, e o que sai do schema nao volta ate o processo reiniciar. Mesma
 * ideia do `dsh-subagent-lean`, que usa `allow` para os subagentes.
 *
 * O deny e calculado a partir das tools VISIVEIS naquele escopo, por prefixo, e
 * nao de uma lista fixa: se a atualizacao do DSH renomear ou acrescentar tool de
 * ppt, ela sai do schema sem editar este arquivo.
 *
 * Custo medido em 16/11/2026: ppt (11 tools, 1.390 tokens) + office (3 tools, 759
 * tokens) = 14 tools e 2.149 tokens por pedido, 16,6% do schema de 12.952.
 * Ferramenta e de mao continua nao entra aqui: nada de pwsh, fs, read, write.
 */

export const inject = ['tools'];

// Prefixos das tools da camada do app, mais o nome exato que nao segue prefixo.
const PADRAO = ['ppt_', 'pptd_', 'office_', 'load_workspace_dependencies'];

function ehSubagente(agent) {
  const header = agent?.session?.header;
  if (header === undefined || header === null) return false;
  if (header.origin === 'subagent') return true;
  if (header.parentSession !== undefined && header.parentSession !== null) return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

function normalizar(lista, padrao) {
  const bruto = Array.isArray(lista) && lista.length > 0 ? lista : padrao;
  return bruto.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function nomesVisiveis(ctx, agent) {
  // view() e o mesmo mapa que o restrict usa para validar os nomes: se estiver
  // ali, o restrict aceita. Sem ele, cai na lista explicita do config.
  try {
    const visao = ctx?.tools?.view?.(agent?.ctx);
    const mapa = visao?.visible;
    if (mapa instanceof Map) return [...mapa.keys()];
  } catch {
    // segue para o caminho sem view
  }
  return undefined;
}

function casamCom(nome, prefixos, exatos) {
  if (exatos.includes(nome)) return true;
  return prefixos.some((p) => nome.startsWith(p));
}

export function apply(ctx, config) {
  const prefixos = normalizar(config?.prefixos, PADRAO);
  const exatos = normalizar(config?.nomes, []);
  const incluirSubagentes = config?.incluirSubagentes === 'true' || config?.incluirSubagentes === true;
  const simular = config?.simular === 'true' || config?.simular === true;
  let avisouSemLista = false;

  ctx.on('agent/created', ({ agent }) => {
    try {
      if (!incluirSubagentes && ehSubagente(agent)) return;

      const visiveis = nomesVisiveis(ctx, agent);
      let deny;
      if (visiveis !== undefined) {
        deny = visiveis.filter((nome) => casamCom(nome, prefixos, exatos));
      } else if (exatos.length > 0) {
        deny = exatos;
      } else {
        if (!avisouSemLista) {
          avisouSemLista = true;
          console.warn('[dsh-filtro-tools] tools.view() indisponivel e sem "nomes" no config: filtro nao aplicado');
        }
        return;
      }

      deny = [...new Set(deny)].sort();
      if (deny.length === 0) {
        console.warn(`[dsh-filtro-tools] nenhuma tool casou com ${prefixos.join(', ')}; schema intacto`);
        return;
      }
      if (simular) {
        console.log(`[dsh-filtro-tools] simulacao: ${deny.length} tools sairiam do schema: ${deny.join(', ')}`);
        return;
      }

      agent.ctx.tools.restrict({ deny });
      console.log(`[dsh-filtro-tools] ${deny.length} tools fora do schema do agente: ${deny.join(', ')}`);
    } catch (erro) {
      // Nunca derrubar a criacao do agente por causa do filtro.
      console.warn(`[dsh-filtro-tools] filtro nao aplicado: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  });
}
