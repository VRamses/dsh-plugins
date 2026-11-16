/*
 * Testes da ponte `dsh-navegador`.
 *
 * O cliente usado aqui é o MESMO arquivo que a extensão usa
 * (`extensao/painel/api.js`), importado direto: `comum.js` só toca `chrome.*`
 * dentro de funções, então o módulo carrega no Node e o que passa aqui é o
 * código que vai rodar no painel, não uma reimplementação parecida.
 *
 * Uso:
 *   node testar-ponte.mjs diagnóstico [endereço]
 *   node testar-ponte.mjs fluxo <sessionId> [segundos]
 *   node testar-ponte.mjs segurança [endereço]
 *   node testar-ponte.mjs painel-falso [endereço]
 */

import http from 'node:http';
import { Ponte } from '../extensao/painel/api.js';
import { aplicarProjecoes, aplicarQuadro, novoEstado } from '../extensao/painel/transcrito.js';

const ENDERECO_PADRAO = 'http://127.0.0.1:43129';
const modo = process.argv[2] ?? 'diagnostico';
const argumento = process.argv[3] ?? '';
const endereco = modo === 'fluxo' ? ENDERECO_PADRAO : (argumento === '' ? ENDERECO_PADRAO : argumento);

/** Contador simples de aprovações e reprovações. */
const placar = { ok: 0, falhou: 0 };

function conferir(rotulo, condicao, detalhe = '') {
  if (condicao) {
    placar.ok += 1;
    console.log(`  ok   ${rotulo}${detalhe === '' ? '' : ` (${detalhe})`}`);
  } else {
    placar.falhou += 1;
    console.log(`  FALHA ${rotulo}${detalhe === '' ? '' : ` (${detalhe})`}`);
  }
}

async function comToken() {
  const ponte = new Ponte(endereco, '');
  const ola = await ponte.ola();
  const par = await ponte.parear();
  return { ponte, ola, par };
}

// ---------------------------------------------------------------------------

async function diagnostico() {
  console.log(`ponte: ${endereco}\n`);
  const ponte = new Ponte(endereco, '');
  const ola = await ponte.ola();
  conferir('ola responde o protocolo 1', ola.protocolo === 1, `ponte ${ola.ponte?.versao} pid ${ola.ponte?.pid}`);
  conferir('ola lista endpoints unarios', Array.isArray(ola.rpc) && ola.rpc.length > 20, `${ola.rpc?.length} unarios, ${ola.fluxo?.length} fluxos`);

  const par = await ponte.parear();
  conferir('parear devolve token', typeof par.token === 'string' && par.token.length === 43, `autoridade ${par.autoridade}`);
  conferir('parear nao repete token novo', par.novo === false, `novo=${par.novo}`);

  const segunda = await new Ponte(endereco, '').parear();
  conferir('parear e estavel entre chamadas', segunda.token === par.token);

  await ponte.sinal();
  conferir('sinal aceita o token', true);

  const lista = await ponte.valor('session/list', {});
  const sessoes = lista?.items ?? lista?.sessions ?? [];
  conferir('session/list responde (envelope _request)', Array.isArray(sessoes), `${sessoes.length} sessoes`);

  const presets = await ponte.valor('agentPresets/list', {});
  conferir('agentPresets/list responde (sem envelope)', Array.isArray(presets?.presets), `${presets?.presets?.length ?? 0} presets`);

  const catalogo = await ponte.valor('session/modelCatalog', {});
  conferir('session/modelCatalog responde (sem envelope)', catalogo !== null && catalogo !== undefined, Object.keys(catalogo ?? {}).slice(0, 4).join(','));

  const inventario = await ponte.valor('pluginInventory/list', {});
  conferir('pluginInventory/list responde', inventario !== null && inventario !== undefined, Object.keys(inventario ?? {}).slice(0, 4).join(','));

  const provedores = await ponte.valor('llm/listProviders', {});
  conferir('llm/listProviders responde', provedores !== null && provedores !== undefined, Array.isArray(provedores) ? `${provedores.length} provedores` : typeof provedores);

  const conta = await ponte.valor('account/getState', {});
  conferir('account/getState responde', conta !== null && conta !== undefined, JSON.stringify(conta).slice(0, 70));

  const primeira = sessoes.find((s) => s.projections?.values?.title === 'Teste') ?? sessoes[0];
  if (primeira !== undefined) {
    const projecoes = await ponte.valor('session/projections', { sessionId: primeira.sessionId });
    const valores = projecoes?.values ?? projecoes?.projections?.values;
    conferir('session/projections responde (envelope request)', valores !== null && valores !== undefined, `titulo ${JSON.stringify(valores?.title)}`);
  }

  // Endpoints com envelope solto viram AVISO: o formato INTERNO do pedido não
  // interessa aqui, o que se prova é o caminho do envelope.
  //
  // `skills/list` e `messageFeedback/list` levam `request: { sessionId }` desde o
  // DSH Desktop 0.12; com o miolo vazio o gateway recusa por boundary validation
  // ("wire field request failed boundary validation", medido em 21/10/2026). O
  // envelope continua sendo `request`, montado pelo `envelope()` do painel, entao
  // aqui se passa o miolo: `{ sessionId }`.
  await talvez('commands/list (agentId solto)', () => ponte.valor('commands/list', { agentId: primeira?.sessionId }));
  await talvez('skills/list (request.sessionId)', () => ponte.valor('skills/list', { sessionId: primeira?.sessionId }));
  await talvez('fileReferences/list (agentId solto)', () => ponte.valor('fileReferences/list', { agentId: primeira?.sessionId, query: '' }));
  await talvez('messageFeedback/list (request.sessionId)', () =>
    ponte.valor('messageFeedback/list', { sessionId: primeira?.sessionId }),
  );
  await talvez('goals/get (agentId solto)', () => ponte.valor('goals/get', { agentId: primeira?.sessionId }));

  await ponte.anunciarAba({ id: 1, url: 'https://exemplo.test/pagina', titulo: 'Exemplo' });
  const estado = await ponte.ola();
  conferir('anunciarAba guarda a aba', estado.painel?.aba?.url === 'https://exemplo.test/pagina');
  await ponte.anunciarAba(null);

  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

/** Roda um endpoint cuja forma interna não importa aqui: falha é aviso. */
/**
 * Resume um valor para o log sem quebrar com `undefined`.
 *
 * `JSON.stringify(undefined)` devolve `undefined`, e o `.slice` em cima disso
 * estourava `Cannot read properties of undefined (reading 'slice')` num endpoint
 * que tinha respondido **certo** com valor vazio (`goals/get` sem meta na
 * sessao). Medido em 21/10/2026: o "erro" era do proprio diagnostico.
 */
function resumoDoValor(valor) {
  if (valor === undefined) return 'vazio (undefined)';
  const texto = JSON.stringify(valor);
  return texto === undefined ? String(valor) : texto.slice(0, 60);
}

async function talvez(rotulo, acao) {
  try {
    const valor = await acao();
    console.log(`  ok    ${rotulo} (${resumoDoValor(valor)})`);
  } catch (erro) {
    console.log(`  aviso ${rotulo}: ${erro.message}`);
  }
}

/**
 * Pedido HTTP cru.
 *
 * O `fetch` do Node é uma implementação da especificação: ele DESCARTA o
 * cabeçalho `Host` que você mandar e usa o da URL. Então um teste de cerca de
 * `Host` feito com `fetch` sempre passa, e o teste mente. Aqui o `node:http`
 * manda o cabeçalho como está.
 */
function pedidoCru(base, caminho, opcoes = {}) {
  const alvo = new URL(base);
  return new Promise((resolve, reject) => {
    const requisicao = http.request(
      {
        host: alvo.hostname,
        port: alvo.port,
        path: caminho,
        method: opcoes.method ?? 'GET',
        headers: opcoes.headers ?? {},
      },
      (resposta) => {
        let corpo = '';
        resposta.on('data', (pedaco) => {
          corpo += pedaco;
        });
        resposta.on('end', () => resolve({ status: resposta.statusCode, headers: resposta.headers, corpo }));
      },
    );
    requisicao.on('error', reject);
    if (opcoes.body !== undefined) requisicao.write(opcoes.body);
    requisicao.end();
  });
}

// ---------------------------------------------------------------------------

async function seguranca() {
  console.log(`cercas da ponte em ${endereco}\n`);
  const base = endereco;
  const ponte = new Ponte(base, '');
  const par = await ponte.parear();

  const semToken = await fetch(`${base}/dsh-navegador/sinal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  conferir('/sinal sem token devolve 401', semToken.status === 401, `HTTP ${semToken.status}`);

  const tokenErrado = await fetch(`${base}/dsh-navegador/sinal`, {
    method: 'POST',
    headers: { authorization: `Bearer ${'x'.repeat(43)}`, 'content-type': 'application/json' },
    body: '{}',
  });
  conferir('/sinal com token errado devolve 401', tokenErrado.status === 401, `HTTP ${tokenErrado.status}`);

  const proibido = await fetch(`${base}/dsh-navegador/rpc/terminal/list`, {
    method: 'POST',
    headers: { authorization: `Bearer ${par.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  });
  conferir('/rpc/terminal/list fora da lista devolve 403', proibido.status === 403, `HTTP ${proibido.status}`);

  const proibido2 = await fetch(`${base}/dsh-navegador/rpc/settings/read`, {
    method: 'POST',
    headers: { authorization: `Bearer ${par.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  });
  conferir('/rpc/settings/read fora da lista devolve 403', proibido2.status === 403, `HTTP ${proibido2.status}`);

  const fluxoProibido = await fetch(`${base}/dsh-navegador/fluxo/terminal/follow`, {
    method: 'POST',
    headers: { authorization: `Bearer ${par.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  });
  conferir('/fluxo/terminal/follow fora da lista devolve 403', fluxoProibido.status === 403, `HTTP ${fluxoProibido.status}`);

  const dePagina = await fetch(`${base}/dsh-navegador/parear`, { headers: { origin: 'https://pagina-maliciosa.test' } });
  conferir('/parear recusa Origin de pagina', dePagina.status === 403, `HTTP ${dePagina.status}`);

  const hostErrado = await pedidoCru(base, '/dsh-navegador/ola', { headers: { host: 'evil.example' } });
  conferir('/ola recusa Host que nao e local (HTTP cru)', hostErrado.status === 403, `HTTP ${hostErrado.status}`);

  const hostErradoRpc = await pedidoCru(base, '/dsh-navegador/rpc/session/list', {
    method: 'POST',
    headers: { host: '127.0.0.1.nip.io', authorization: `Bearer ${par.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ args: { _request: {} } }),
  });
  conferir('/rpc recusa Host que resolve para fora (HTTP cru)', hostErradoRpc.status === 403, `HTTP ${hostErradoRpc.status}`);

  const origemCruzada = await pedidoCru(base, '/dsh-navegador/rpc/session/list', {
    method: 'POST',
    headers: { origin: 'https://pagina-maliciosa.test', authorization: `Bearer ${par.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ args: { _request: {} } }),
  });
  conferir('Host local com Origin de pagina nao e barrado no rpc (o token e a cerca)', origemCruzada.status === 200, `HTTP ${origemCruzada.status}`);

  const semCors = await fetch(`${base}/dsh-navegador/parear`);
  conferir('/parear nunca devolve cabecalho CORS', semCors.headers.get('access-control-allow-origin') === null);

  const rotaInexistente = await fetch(`${base}/dsh-navegador/nao-existe`, {
    method: 'POST',
    headers: { authorization: `Bearer ${par.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  conferir('rota desconhecida devolve 404', rotaInexistente.status === 404, `HTTP ${rotaInexistente.status}`);

  const argsErrados = await fetch(`${base}/dsh-navegador/rpc/session/list`, {
    method: 'POST',
    headers: { authorization: `Bearer ${par.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ errado: true }),
  });
  conferir('corpo fora do envelope devolve 400', argsErrados.status === 400, `HTTP ${argsErrados.status}`);

  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

async function fluxo() {
  const sessionId = argumento;
  if (sessionId === '') throw new Error('informe o sessionId');
  const segundos = Number(process.argv[4] ?? 12);
  const { ponte } = await comToken();
  const tipos = new Map();
  let quadros = 0;
  const controle = new AbortController();
  setTimeout(() => controle.abort(), segundos * 1000);
  console.log(`seguindo ${sessionId} por ${segundos}s...`);
  try {
    await ponte.fluxo(
      'session/follow',
      { address: { kind: 'session', sessionId }, assistantStream: true },
      (quadro) => {
        quadros += 1;
        const chave =
          quadro.type === 'assistant-stream'
            ? `assistant-stream/${quadro.frame?.type}/${quadro.frame?.chunk?.type ?? '-'}`
            : quadro.type === 'event'
              ? `event/${quadro.event?.type}`
              : quadro.type;
        tipos.set(chave, (tipos.get(chave) ?? 0) + 1);
        if (quadros === 1 && quadro.type === 'snapshot') {
          console.log(`retrato: cursor=${quadro.cursor} registros=${quadro.records?.length} hasMore=${quadro.hasMore}`);
          console.log(`titulo=${JSON.stringify(quadro.projections?.values?.title)} preset=${quadro.header?.agentPreset}`);
        }
      },
      controle.signal,
    );
  } catch (erro) {
    if (erro.name !== 'AbortError') throw erro;
  }
  const ordenado = [...tipos.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n${quadros} quadros:`);
  for (const [tipo, n] of ordenado) console.log(`  ${String(n).padStart(6)}  ${tipo}`);
  conferir('fluxo entregou o retrato', quadros > 0 && ordenado.some(([t]) => t === 'snapshot'));
}

// ---------------------------------------------------------------------------

/**
 * Faz o papel do painel: assina o canal de pedidos e responde como o add-on
 * responderia. Serve para exercitar `navegador_ler`/`navegador_agir` de ponta a
 * ponta sem abrir o navegador.
 *
 * `resposta` controla o que fazer com cada ação:
 *   aprovar (padrão) | recusar | falhar
 */
async function painelFalso() {
  const resposta = process.env.DSH_TESTE_RESPOSTA ?? 'aprovar';
  const { ponte } = await comToken();
  await ponte.anunciarAba({ id: 7, url: 'https://exemplo.test/formulario', titulo: 'Formulario de teste' });
  console.log(`painel falso ligado em ${endereco} (acoes: ${resposta}). Ctrl+C para sair.`);

  const controle = new AbortController();
  process.on('SIGINT', () => controle.abort());

  try {
    await ponte.pedidos(async (mensagem) => {
      if (mensagem.tipo === 'aberto') {
        console.log(`[pedidos] canal aberto as ${mensagem.desde}`);
        return;
      }
      if (mensagem.tipo === 'aba') {
        console.log(`[pedidos] aba agora: ${mensagem.aba?.url ?? 'nenhuma'}`);
        return;
      }
      if (mensagem.tipo === 'resolvido') {
        console.log(`[pedidos] resolvido ${mensagem.id}`);
        return;
      }
      if (mensagem.tipo !== 'pedido') return;
      const pedido = mensagem.pedido;
      console.log(`[pedido] ${pedido.tipo} ${JSON.stringify(pedido)}`);

      if (pedido.tipo === 'ler') {
        const valor = {
          url: 'https://exemplo.test/formulario',
          titulo: 'Formulario de teste',
          resumo: `leitura falsa de ${pedido.oQue}`,
          ...(pedido.oQue === 'texto' ? { texto: 'Pagina falsa com um botao "Enviar" e um campo "Nome".' } : {}),
          ...(pedido.oQue === 'selecao' ? { selecao: 'trecho selecionado de teste' } : {}),
          ...(pedido.oQue === 'elementos' ? { itens: ['[data-dsh-nav="1"] <button> "Enviar"'] } : {}),
        };
        await ponte.responder({ id: pedido.id, ok: true, valor });
        return;
      }

      // Ação: demora um pouco para parecer com a aprovação humana.
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (resposta === 'recusar') {
        await ponte.responder({ id: pedido.id, ok: false, erro: 'o usuario recusou esta acao no painel' });
        return;
      }
      if (resposta === 'falhar') {
        await ponte.responder({ id: pedido.id, ok: false, erro: 'nao achei nenhum elemento para o seletor "#nao-existe"' });
        return;
      }
      await ponte.responder({
        id: pedido.id,
        ok: true,
        valor: { ok: true, resumo: `acao "${pedido.acao}" executada pelo painel falso`, aba: { url: 'https://exemplo.test/formulario', titulo: 'Formulario de teste', id: 7 }, aprovada: true },
      });
    }, controle.signal);
  } catch (erro) {
    if (erro.name !== 'AbortError') {
      console.error(`canal de pedidos caiu: ${erro.message}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Teste de ponta a ponta pela ponte: cria uma sessão descartável, segue o fluxo,
 * manda um prompt, espera o fim do turno e apaga a sessão. É o mesmo caminho que
 * o painel usa, sem navegador no meio.
 */
async function pontaAPonta() {
  const { ponte } = await comToken();
  const tipos = new Map();
  const textos = [];
  let terminou = false;

  const criada = await ponte.valor('session/create', { cwd: process.env.DSH_TESTE_CWD ?? 'C:\\Users\\victo\\Documents\\DSH' });
  const sessionId = criada.sessionId;
  console.log(`sessao descartavel: ${sessionId}`);
  conferir('session/create devolve id', typeof sessionId === 'string' && sessionId.startsWith('session-'), sessionId);

  const ac = new AbortController();
  const seguir = ponte.fluxo(
    'session/follow',
    { address: { kind: 'session', sessionId }, assistantStream: true },
    (quadro) => {
      const chave =
        quadro.type === 'assistant-stream'
          ? `assistant-stream/${quadro.frame?.type}/${quadro.frame?.chunk?.type ?? '-'}`
          : quadro.type === 'event'
            ? `event/${quadro.event?.type}`
            : quadro.type;
      tipos.set(chave, (tipos.get(chave) ?? 0) + 1);
      if (quadro.type === 'assistant-stream' && quadro.frame?.chunk?.type === 'text-delta') textos.push(quadro.frame.chunk.text);
      if (quadro.type === 'event' && quadro.event?.type === 'turn/end') terminou = true;
    },
    ac.signal,
  ).catch((erro) => {
    if (erro.name !== 'AbortError') console.error(`fluxo: ${erro.message}`);
  });

  // O follow precisa de um instante para ativar a sessão no host.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const envio = await ponte.valor('session/prompt', {
    requestId: crypto.randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: 'Teste automatico da ponte dsh-navegador. Responda apenas: OK.' }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  conferir('session/prompt aceito', envio?.accepted === true);

  const limite = Date.now() + 90_000;
  while (!terminou && Date.now() < limite) await new Promise((resolve) => setTimeout(resolve, 500));
  conferir('o turno terminou', terminou, `${Math.round((90_000 - (limite - Date.now())) / 1000)}s`);
  ac.abort();
  await seguir;

  const texto = textos.join('');
  conferir('chegaram deltas de texto', tipos.get('assistant-stream/chunk/text-delta') > 0, `${tipos.get('assistant-stream/chunk/text-delta') ?? 0} deltas`);
  conferir('chegou a mensagem duravel', (tipos.get('event/assistant/message') ?? 0) > 0);
  conferir('chegou tool/call ou texto na resposta', texto.length > 0 || (tipos.get('event/tool/call') ?? 0) > 0, JSON.stringify(texto.slice(0, 40)));

  console.log(`\nquadros por tipo:`);
  for (const [tipo, n] of [...tipos.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${tipo}`);

  try {
    await ponte.valor('session/delete', { sessionId });
    conferir('session/delete apagou a sessao descartavel', true);
  } catch (erro) {
    console.log(`  aviso nao consegui apagar ${sessionId}: ${erro.message}`);
    console.log(`  APAGUE A MAO: ${sessionId}`);
  }

  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

/**
 * Teste da detecção de pergunta pendente.
 *
 * O que se prova aqui: o painel ENXERGA a pergunta do agente e sabe o que ela
 * pede, mesmo na variante `legacy` do `tool-ask-user` (o padrão deste DSH), em
 * que ela não entra em `userQuestions.active`. Responder pelo painel não é
 * possível hoje, e o teste também REGISTRA isso em vez de fingir que sim.
 */
async function perguntas() {
  const { ponte } = await comToken();
  const estado = novoEstado();

  const criada = await ponte.valor('session/create', { cwd: 'C:\\Users\\victo\\Documents\\DSH' });
  const sessionId = criada.sessionId;
  console.log(`sessao descartavel: ${sessionId}`);

  const ac = new AbortController();
  const seguir = ponte
    .fluxo(
      'session/follow',
      { address: { kind: 'session', sessionId }, assistantStream: true },
      (quadro) => {
        aplicarQuadro(estado, quadro);
      },
      ac.signal,
    )
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 800));

  await ponte.valor('session/prompt', {
    requestId: crypto.randomUUID(),
    sessionId,
    mode: 'queue',
    content: [
      {
        type: 'text',
        text: 'Chame a ferramenta ask_user_question UMA vez, sem passar o parametro timeout, com uma pergunta de id "cor" e duas opcoes: "azul" e "verde". Depois responda apenas a opcao escolhida.',
      },
    ],
  });

  let pendente = null;
  const limite = Date.now() + 75_000;
  while (Date.now() < limite && pendente === null) {
    pendente = estado.perguntaPendente;
    if (pendente === null) await new Promise((resolve) => setTimeout(resolve, 700));
  }

  conferir('o painel detecta a pergunta pendente', pendente !== null, pendente === null ? 'nada em 75s' : `callId ${pendente.callId}`);
  if (pendente !== null) {
    const pergunta = pendente.perguntas[0];
    console.log(`  info  pergunta: ${JSON.stringify(pergunta?.question)}`);
    console.log(`  info  opcoes: ${JSON.stringify((pergunta?.options ?? []).map((o) => o.label))}`);
    conferir('leu o id da pergunta', pergunta.id === 'cor', pergunta.id);
    conferir('leu as duas opcoes', (pergunta?.options ?? []).length === 2);
  }

  const projecoes = await ponte.valor('session/projections', { sessionId });
  const valores = projecoes?.values ?? projecoes?.projections?.values;
  const ativas = valores?.userQuestions?.active ?? [];
  console.log(`  info  userQuestions.active (variante legacy): ${JSON.stringify(ativas).slice(0, 120)}`);
  conferir('fica registrado que a projecao NAO lista a pergunta nesta variante', Array.isArray(ativas) && ativas.length === 0);

  // Não dá para responder pelo painel nesta variante: então cancela e apaga.
  await ponte.valor('session/cancel', { sessionId }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  ac.abort();
  await seguir;
  try {
    await ponte.valor('session/delete', { sessionId });
    console.log('  info  sessao descartavel apagada');
  } catch (erro) {
    console.log(`  APAGUE A MAO ${sessionId}: ${erro.message}`);
  }

  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

const modos = { diagnostico, seguranca, fluxo, 'painel-falso': painelFalso, 'ponta-a-ponta': pontaAPonta, perguntas };
const escolhido = modos[modo];
if (escolhido === undefined) {
  console.error(`modo desconhecido: ${modo}. Use: ${Object.keys(modos).join(', ')}`);
  process.exit(2);
}
escolhido().catch((erro) => {
  console.error(`FALHOU: ${erro?.stack ?? erro}`);
  process.exit(1);
});
