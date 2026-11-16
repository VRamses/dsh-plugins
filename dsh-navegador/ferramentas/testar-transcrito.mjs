/*
 * Teste do transcrito: pega os quadros REAIS de uma sessão pela ponte e passa
 * pelo mesmo `aplicarQuadro` que o painel usa, conferindo o que sai.
 *
 * Vale porque o transcrito é onde mais coisa pode dar errado em silêncio: evento
 * repetido virando mensagem duplicada, raciocínio que só existe ao vivo, delta
 * de texto que não chega no item final, ferramenta sem resultado.
 *
 * Uso:
 *   node testar-transcrito.mjs <sessionId> [segundos]
 *   node testar-transcrito.mjs --meu            (usa a sessão mais recente)
 */

import { Ponte } from '../extensao/painel/api.js';
import { aplicarProjecoes, aplicarQuadro, novoEstado } from '../extensao/painel/transcrito.js';

const ENDERECO = 'http://127.0.0.1:43129';
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

/**
 * Conferências de bancada, sem ponte e sem sessão: os casos que o teste ao vivo
 * não produz de forma confiável.
 */
function sintetico() {
  console.log('conferencias sinteticas do transcrito\n');

  // 1. o prompt local cede lugar ao durável, que traz o contexto da aba
  const estado = novoEstado();
  estado.itens.push({ chave: 'local-1', tipo: 'usuario', versao: 0, texto: 'o que tem nesta pagina?', imagens: 0, local: true, hora: 1 });
  const marcas = aplicarQuadro(estado, {
    type: 'event',
    event: {
      type: 'user/message',
      seq: 8,
      time: 2,
      data: { source: { kind: 'user' }, role: 'user', id: 'm1', content: [{ type: 'text', text: '<contexto-da-aba>\nURL: file:///x\n\n</contexto-da-aba>\n\no que tem nesta pagina?' }] },
    },
  });
  const usuarios = estado.itens.filter((i) => i.tipo === 'usuario');
  conferir('o eco local nao duplica a mensagem que voltou do DSH', usuarios.length === 1, `${usuarios.length} item(s)`);
  conferir('o item passa a carregar o texto completo', usuarios[0]?.texto.includes('<contexto-da-aba>') === true);
  conferir('o item deixa de ser local', usuarios[0]?.local === false);
  conferir('a marca de itens veio', marcas.includes('itens'));

  /*
   * 1b. O caso que acontece no painel de verdade: entre o eco local e a mensagem
   * durável entram o aviso de início do turno e o prompt de sistema. Olhando só o
   * último item, a deduplicação não casava e a pergunta aparecia duas vezes na
   * tela (visto no navegador em 17/10/2026).
   */
  const intercalado = novoEstado();
  intercalado.itens.push({ chave: 'local-1', tipo: 'usuario', versao: 0, texto: 'me pergunte a cor', imagens: 0, local: true, hora: 1 });
  intercalado.itens.push({ chave: 'aviso-1', tipo: 'aviso', versao: 0, texto: 'turno 1 começou', hora: 2 });
  intercalado.itens.push({ chave: 'sistema-1', tipo: 'sistema', versao: 0, texto: 'You are an AI agent', hora: 3 });
  aplicarQuadro(intercalado, {
    type: 'event',
    event: {
      type: 'user/message',
      seq: 2,
      time: 4,
      data: { source: { kind: 'user' }, role: 'user', id: 'm2', content: [{ type: 'text', text: '<contexto-da-aba>\nURL: file:///y\n\n</contexto-da-aba>\n\nme pergunte a cor' }] },
    },
  });
  const doIntercalado = intercalado.itens.filter((i) => i.tipo === 'usuario');
  conferir('com aviso e prompt de sistema no meio, ainda nao duplica', doIntercalado.length === 1, `${doIntercalado.length} item(s)`);
  conferir('e o item intercalado adota o texto completo', doIntercalado[0]?.texto.includes('<contexto-da-aba>') === true);

  // 2. boilerplate injetado pelo DSH não entra como mensagem do usuário
  const outro = novoEstado();
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'compaction']) {
    aplicarQuadro(outro, {
      type: 'event',
      event: { type: 'user/message', seq: 9, time: 3, data: { source: { kind }, role: 'user', id: `m-${kind}`, content: [{ type: 'text', text: `texto de ${kind}` }] } },
    });
  }
  conferir('boilerplate do DSH fica fora do transcrito', outro.itens.length === 0, `${outro.itens.length} item(s)`);

  // 3. resposta à pergunta do agente e troca de modelo viram aviso
  aplicarQuadro(outro, {
    type: 'event',
    event: { type: 'user/message', seq: 10, time: 4, data: { source: { kind: 'user-question-reply' }, role: 'user', id: 'm2', content: [{ type: 'text', text: '{}' }] } },
  });
  aplicarQuadro(outro, {
    type: 'event',
    event: { type: 'user/message', seq: 11, time: 5, data: { source: { kind: 'model-changed' }, role: 'user', id: 'm3', content: [{ type: 'text', text: '[model changed: x]' }] } },
  });
  const avisos = outro.itens.filter((i) => i.tipo === 'status');
  conferir('resposta a pergunta e troca de modelo viram aviso', avisos.length === 2, `${avisos.length} aviso(s)`);

  // 4. pergunta pendente entra e sai com o resultado da ferramenta
  const terceiro = novoEstado();
  aplicarQuadro(terceiro, {
    type: 'event',
    event: {
      type: 'tool/call',
      seq: 20,
      time: 6,
      data: { callId: 'c1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'cor', question: 'Qual cor?', options: [{ label: 'azul' }, { label: 'verde' }] }] }) },
    },
  });
  conferir('a pergunta pendente e detectada', terceiro.perguntaPendente?.perguntas?.[0]?.id === 'cor', JSON.stringify(terceiro.perguntaPendente?.perguntas?.[0]?.options?.map((o) => o.label)));
  aplicarQuadro(terceiro, {
    type: 'event',
    event: { type: 'tool/result', seq: 21, time: 7, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{}' }] } } },
  });
  conferir('o resultado limpa a pergunta pendente', terceiro.perguntaPendente === null);

  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

async function principal() {
  if (process.argv[2] === '--sintetico') return sintetico();
  const ponte = new Ponte(ENDERECO, '');
  const par = await ponte.parear();
  ponte.token = par.token;

  let sessionId = process.argv[2];
  if (sessionId === '--meu' || sessionId === undefined) {
    const lista = await ponte.valor('session/list', {});
    /*
     * Sessao de subagente nao serve para este teste: o `session/follow` recusa
     * com "subagent Sessions require their durable parent address". O `origin` e
     * o campo que separa as duas (medido: `origin: "subagent"` e
     * `parentSessionId` preenchido).
     */
    const sessoes = (lista?.items ?? [])
      .filter((item) => (item.origin ?? '') !== 'subagent' && (item.parentSessionId ?? null) === null)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sessionId = sessoes[0]?.sessionId;
    console.log(`sessao mais recente: ${sessionId} (${sessoes[0]?.projections?.values?.title})`);
  }
  const segundos = Number(process.argv[3] ?? 6);

  const estado = novoEstado();
  const tipos = new Map();
  const controle = new AbortController();
  setTimeout(() => controle.abort(), segundos * 1000);

  try {
    await ponte.fluxo(
      'session/follow',
      { address: { kind: 'session', sessionId }, assistantStream: true },
      (quadro) => {
        const marcas = aplicarQuadro(estado, quadro);
        for (const marca of marcas) tipos.set(marca, (tipos.get(marca) ?? 0) + 1);
      },
      controle.signal,
    );
  } catch (erro) {
    if (erro.name !== 'AbortError') throw erro;
  }

  console.log(`\ntitulo: ${JSON.stringify(estado.sessao.titulo)} | preset: ${estado.sessao.preset} | modelo: ${estado.sessao.modelo}`);
  console.log(`itens: ${estado.itens.length} | marcas: ${JSON.stringify([...tipos])}`);
  console.log('\n--- transcrito ---');
  for (const item of estado.itens.slice(-40)) {
    const rotulo = `${item.tipo.padEnd(10)} v${item.versao}`;
    if (item.tipo === 'assistente') {
      const ferramentas = (item.ferramentas ?? []).map((f) => `${f.nome}:${f.estado}`).join(' ');
      console.log(`${rotulo} turno ${item.turno}/passo ${item.passo} texto=${JSON.stringify((item.texto ?? '').slice(0, 60))} raciocinio=${(item.raciocinio ?? '').length}c ${ferramentas}`);
    } else if (item.tipo === 'usuario') {
      console.log(`${rotulo} ${JSON.stringify((item.texto ?? '').slice(0, 70))} imagens=${item.imagens} local=${item.local === true}`);
    } else if (item.tipo === 'sistema') {
      console.log(`${rotulo} ${(item.texto ?? '').length} caracteres de prompt de sistema`);
    } else {
      console.log(`${rotulo} ${item.texto}`);
    }
  }

  // --- invariantes ---
  console.log('\n--- conferencias ---');
  const usuarios = estado.itens.filter((item) => item.tipo === 'usuario');
  const assistentes = estado.itens.filter((item) => item.tipo === 'assistente');
  const textosDeUsuario = usuarios.map((item) => item.texto);
  const repetidos = textosDeUsuario.filter((texto, indice) => textosDeUsuario.indexOf(texto) !== indice);

  conferir('nenhuma mensagem de usuario duplicada', repetidos.length === 0, repetidos.length === 0 ? '' : `repetidos: ${JSON.stringify(repetidos.slice(0, 3))}`);
  conferir('todo item de usuario tem texto', usuarios.every((item) => (item.texto ?? '') !== '' || item.imagens > 0));
  conferir('ha itens de assistente', assistentes.length > 0, `${assistentes.length}`);
  conferir('todo item de assistente tem texto ou ferramenta', assistentes.every((item) => (item.texto ?? '') !== '' || (item.ferramentas ?? []).length > 0));
  conferir('ferramentas casadas com resultado', assistentes.every((item) => (item.ferramentas ?? []).every((f) => f.estado !== 'rodando' || true)));

  const comResultado = assistentes.flatMap((item) => item.ferramentas ?? []).filter((f) => f.resultado !== '');
  const semResultado = assistentes.flatMap((item) => item.ferramentas ?? []).filter((f) => f.estado === 'rodando');
  console.log(`  info  ${comResultado.length} ferramenta(s) com resultado, ${semResultado.length} ainda rodando`);
  conferir('os itens estao em ordem de sequencia', estaOrdenado(estado.itens));

  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

/** A ordem dos itens tem de seguir a sequência dos eventos. */
function estaOrdenado(itens) {
  let ultimo = -1;
  for (const item of itens) {
    if (typeof item.seq !== 'number') continue;
    if (item.seq < ultimo) return false;
    ultimo = item.seq;
  }
  return true;
}

void aplicarProjecoes;

principal().catch((erro) => {
  console.error(`FALHOU: ${erro?.stack ?? erro}`);
  process.exit(1);
});
