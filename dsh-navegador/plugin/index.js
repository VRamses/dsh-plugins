/**
 * `dsh-navegador` - ponte entre o DSH e o add-on de navegador.
 *
 * Metade host. Ela existe por dois motivos:
 *
 * 1. dar ao add-on um caminho autenticado para o RPC do DSH, porque o `/api` do
 *    `dsh web` é fechado por cookie `HttpOnly` + `SameSite=Strict` e nenhuma
 *    extensão de navegador alcança esse cookie;
 * 2. dar ao AGENTE duas ferramentas para a aba atual (`navegador_ler` e
 *    `navegador_agir`), que é o que faz o add-on ser um add-on de verdade e não
 *    só um chat numa barra lateral.
 *
 * Nada aqui abre porta nova: a ponte mora no mesmo servidor web do DSH, em
 * caminhos irmãos do `/api`, e só responde em loopback.
 *
 * @module dsh-navegador
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { avaliar, carregarToken } from './auth.js';
import { registrarFerramentas } from './ferramentas.js';
import { criarPonte, extrairArgs, lerCorpoJson, responderJson, responderTexto, TETO_CORPO_BYTES } from './ponte.js';
import { BASE, PROTOCOL, ROTAS, linha, permitido, rpcPermitidos, fluxoPermitidos } from './protocol.js';

/** Identidade estável no Loader. */
export const name = 'dsh-navegador';

/** Serviços que precisam existir antes de a ponte montar. */
// `connection` entrou em 21/10/2026: o gateway do DSH Desktop 0.12 exige um Peer
// (dono da chamada) em `invokeRpc` e `stream`, e quem cria Peer em processo e
// esse servico. Sem ele a ponte sobe mas toda chamada volta
// `Cannot read properties of undefined (reading 'signal')`.
export const inject = ['webServer', 'tools', 'credentials', 'connection'];

/**
 * Versão lida do próprio manifesto.
 *
 * Ler em vez de repetir um literal aqui evita a divergência que ninguém percebe:
 * o `/ola` dizendo uma versão e o pacote instalado sendo outra.
 * @returns a versão declarada em package.json, ou `desconhecida`.
 */
function lerVersao() {
  try {
    const caminho = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(caminho, 'utf8')).version ?? 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

/** Versão do pacote instalado. */
const VERSAO = lerVersao();

/**
 * Pasta das conversas do add-on, que é também o caminho do Workspace delas.
 *
 * Não basta apontar o `cwd` da conversa para cá: o DSH agrupa a conversa pelo
 * Workspace que a **contabiliza** (`sessionIds` do registro em
 * `storages/workspace.json`), e o grupo da barra lateral mostra o `title` desse
 * Workspace. `session/create` só com `cwd` grava o diretório da sessão e não
 * contabiliza nada: medido em 22/10/2026, a conversa do add-on nasce em
 * "Ungrouped". Quem contabiliza é `session/create` com `workspaceId`, então o
 * caminho daqui alimenta o `workspace/create` de `garantirWorkspace`.
 *
 * O nome da pasta é "DSH Opera" de propósito: é ele que vira o `title` inicial
 * do Workspace (e portanto o nome do grupo na barra lateral).
 *
 * Resolução: `pasta` do patch, quando configurada (é o que vale nas duas
 * máquinas); senão `Documents\DSH\DSH Opera` para o pacote instalado pelo
 * perfil, que mora em `node_modules` e não tem pasta vizinha de conversas;
 * senão ao lado do pacote, que é o layout do clone em `Documents\DSH`.
 *
 * @param config - configuração do patch (`pasta`).
 * @returns caminho absoluto da pasta, ou `null`.
 */
function pastaDasConversas(config) {
  const preferida = typeof config?.pasta === 'string' ? config.pasta.trim() : '';
  if (preferida !== '') return resolve(preferida);
  try {
    const aqui = dirname(fileURLToPath(import.meta.url));
    const documentosDsh = join(homedir(), 'Documents', 'DSH');
    const instaladoPeloPerfil = aqui.includes(`${sep}node_modules${sep}`);
    const raiz = instaladoPeloPerfil && existsSync(documentosDsh) ? documentosDsh : dirname(dirname(aqui));
    return join(raiz, 'DSH Opera');
  } catch (erro) {
    return null;
  }
}

/**
 * Garante o Workspace que recebe as conversas do add-on.
 *
 * `workspace/create` é idempotente por caminho canônico (`realpath`): repetir em
 * todo boot devolve o mesmo Workspace, sem mexer no título já existente. Ele
 * exige que o diretório exista, e quem cria é o próprio host quando a conversa
 * nasce ali, então a pasta é criada antes.
 *
 * Devolver `null` não derruba nada: a conversa nasce com o `cwd` do painel e
 * fica em "Ungrouped", como era antes desta correção.
 *
 * @param ctx - contexto do host (log).
 * @param ponte - ponte montada, por onde o RPC passa.
 * @param pasta - caminho absoluto da pasta das conversas.
 * @returns o id do Workspace, ou `null` quando não deu para garantir.
 */
async function garantirWorkspace(ctx, ponte, pasta) {
  if (typeof pasta !== 'string' || pasta === '') return null;
  try {
    await mkdir(pasta, { recursive: true });
    const resposta = await ponte.rpc('workspace/create', { request: { path: pasta } });
    if (resposta?.ok === false) {
      throw new Error(`${resposta?.error?.code ?? 'erro'}: ${resposta?.error?.message ?? 'recusado'}`);
    }
    const workspace = resposta?.value?.workspace ?? resposta?.workspace ?? null;
    const id = typeof workspace?.workspaceId === 'string' ? workspace.workspaceId : null;
    if (id === null) throw new Error('workspace/create nao devolveu workspaceId');
    const criado = (resposta?.value ?? resposta)?.created === true;
    ctx.logger?.info?.(
      `dsh-navegador: conversas do add-on no Workspace "${workspace?.title ?? ''}" (${id}) em ${workspace?.path ?? pasta}${criado ? '; criado agora' : ''}`,
    );
    return id;
  } catch (erro) {
    ctx.logger?.warn?.(`dsh-navegador: sem Workspace para as conversas em ${pasta}: ${erro?.message ?? erro}`);
    return null;
  }
}

/**
 * Troca o `cwd` do painel pelo `workspaceId` do Workspace do add-on.
 *
 * O painel pede `session/create` com o `cwd` da pasta dele, e `cwd` sozinho não
 * agrupa. O Host recusa `workspaceId` e `cwd` juntos, e o path do Workspace
 * manda, então o `cwd` sai do pedido. Os demais campos (`sessionId`,
 * `agentPreset`) passam intactos.
 *
 * @param endpoint - endpoint do RPC.
 * @param args - argumentos já no envelope do endpoint.
 * @param opcoes - opções da rota, com `workspaceId()`.
 * @returns os argumentos do pedido, com `workspaceId` no lugar de `cwd`.
 */
export async function emWorkspaceDoAddon(endpoint, args, opcoes) {
  if (endpoint !== 'session/create') return args;
  const pedido = args?.request;
  if (typeof pedido !== 'object' || pedido === null) return args;
  const workspaceId = await opcoes.workspaceId();
  if (workspaceId === null) return args;
  const { cwd: _descartado, ...resto } = pedido;
  return { ...args, request: { ...resto, workspaceId } };
}

/**
 * Monta a ponte.
 * @param ctx - contexto do host.
 * @param config - configuração do patch (`pareamento` para desligar o `/parear`).
 */
export function apply(ctx, config) {
  const permitirPareamento = config?.pareamento !== false;
  const cwdConversas = pastaDasConversas(config);

  /** Workspace das conversas: id resolvido e a resolução em curso, se houver. */
  const workspace = { id: null, emCurso: null };

  /**
   * Id do Workspace das conversas, resolvendo-o no primeiro uso quando o boot
   * não conseguiu. A ativação do plugin pode acontecer antes de o gateway
   * aceitar RPC, e aí a criação da conversa tenta de novo em vez de ficar sem
   * grupo até o próximo boot.
   * @returns o id do Workspace, ou `null` quando nem agora deu.
   */
  async function workspaceId() {
    if (workspace.id !== null) return workspace.id;
    if (ponte === undefined) return null;
    if (workspace.emCurso === null) {
      workspace.emCurso = garantirWorkspace(ctx, ponte, cwdConversas).then((id) => {
        workspace.id = id;
        workspace.emCurso = null;
        return id;
      });
    }
    return await workspace.emCurso;
  }

  // A carga do token é assíncrona e a rota precisa dela em toda requisição:
  // a promessa fica guardada e cada requisição aguarda uma vez só.
  const tokenPromessa = carregarToken(ctx).catch((erro) => {
    ctx.logger?.error?.(`dsh-navegador: nao consegui carregar o token da ponte: ${erro?.message ?? erro}`);
    throw erro;
  });

  let ponte;
  const pronto = tokenPromessa.then(async ({ token, criado }) => {
    // O `dshHomePath` é um valor provido pelo boot do harness, não um serviço.
    const dshHomePath = ctx.get('dshHomePath');
    const home = typeof dshHomePath === 'function' ? dshHomePath() : null;
    ponte = criarPonte(ctx, { token, versao: VERSAO, home });
    registrarFerramentas(ctx, ponte);
    // Antes de servir: o Workspace tem de existir para as conversas seguintes.
    await workspaceId();
    await registrarRota(ctx, ponte, {
      permitirPareamento,
      tokenPromessa: Promise.resolve({ token, criado }),
      home,
      cwdConversas,
      workspaceId,
    });
    ctx.logger?.info?.(
      `dsh-navegador: ponte montada em ${BASE} (protocolo ${PROTOCOL})${criado ? '; token novo criado, pareie o add-on' : ''}`,
    );
  });

  // Um erro aqui não pode derrubar o perfil inteiro: o DSH é útil sem o add-on.
  pronto.catch((erro) => {
    ctx.logger?.error?.(`dsh-navegador: a ponte nao subiu: ${erro?.message ?? erro}`);
  });
}

async function registrarRota(ctx, ponte, opcoes) {
  const rota = {
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => atender(ctx, ponte, opcoes, req, res),
  };
  ctx.effect(() => ctx.webServer.register(rota), 'dsh-navegador: rotas da ponte');
  await anotarEstado(ctx, ponte, opcoes);
}

/** Escreve um retrato da ponte no home do harness, para diagnóstico. */
async function anotarEstado(ctx, ponte, opcoes) {
  const dshHomePath = ctx.get('dshHomePath');
  if (typeof dshHomePath !== 'function' || opcoes.home === null) return;
  const caminho = dshHomePath('integrations/dsh-navegador/ponte.json');
  const retrato = {
    protocolo: PROTOCOL,
    versao: VERSAO,
    porta: ctx.webServer.port,
    host: ctx.webServer.host,
    rpc: rpcPermitidos(),
    fluxo: fluxoPermitidos(),
    tetoCorpoBytes: TETO_CORPO_BYTES,
    pareamento: opcoes.permitirPareamento,
    pastaConversas: opcoes.cwdConversas ?? null,
    workspaceConversas: await opcoes.workspaceId(),
    escritoEm: new Date().toISOString(),
  };
  try {
    await mkdir(dirname(caminho), { recursive: true });
    await writeFile(caminho, `${JSON.stringify(retrato, null, 2)}\n`, 'utf8');
  } catch (erro) {
    ctx.logger?.warn?.(`dsh-navegador: nao consegui escrever ${caminho}: ${erro?.message ?? erro}`);
  }
}

/**
 * Despacha uma requisição da ponte.
 *
 * A ordem das cercas é sempre a mesma: loopback, Host local, (token), e só
 * depois o trabalho. O `/parear` é o único que dispensa token, e por isso ele
 * ainda recusa `Origin` de página web.
 */
async function atender(ctx, ponte, opcoes, req, res) {
  let caminho = '/';
  try {
    caminho = new URL(req.url ?? '/', 'http://local').pathname;
  } catch {
    responderTexto(res, 400, 'caminho invalido');
    return;
  }

  try {
    if (caminho === ROTAS.ola) {
      const recusa = avaliar(req, null, { exigeToken: false });
      if (recusa !== undefined) return responderJson(res, recusa.status, { ok: false, erro: recusa.motivo });
      if (req.method !== 'GET') return responderTexto(res, 405, 'use GET');
      return responderJson(
        res,
        200,
        ponte.estado({
          rpc: rpcPermitidos(),
          fluxo: fluxoPermitidos(),
          pareamento: opcoes.permitirPareamento,
          // `workspaceId` é o que agrupa a conversa: o painel usa esse id
          // quando existe, e `cwd` fica como retrato do caminho.
          addon: { cwd: opcoes.cwdConversas ?? null, workspaceId: await opcoes.workspaceId() },
        }),
      );
    }

    if (caminho === ROTAS.parear) {
      if (!opcoes.permitirPareamento) return responderJson(res, 404, { ok: false, erro: 'pareamento desligado neste ambiente' });
      const recusa = avaliar(req, null, { exigeToken: false, recusaOrigem: true });
      if (recusa !== undefined) return responderJson(res, recusa.status, { ok: false, erro: recusa.motivo });
      if (req.method !== 'GET') return responderTexto(res, 405, 'use GET');
      const { token, criado } = await opcoes.tokenPromessa;
      return responderJson(res, 200, {
        ok: true,
        protocolo: PROTOCOL,
        token,
        novo: criado,
        autoridade: `127.0.0.1:${ctx.webServer.port}`,
        versao: VERSAO,
      });
    }

    const recusa = avaliar(req, ponte.token);
    if (recusa !== undefined) return responderJson(res, recusa.status, { ok: false, erro: recusa.motivo });

    if (caminho === ROTAS.sinal) {
      if (req.method !== 'POST') return responderTexto(res, 405, 'use POST');
      return responderJson(res, 200, ponte.estado());
    }

    if (caminho === ROTAS.aba) {
      if (req.method !== 'POST') return responderTexto(res, 405, 'use POST');
      const corpo = await lerCorpoJson(req);
      const aba = ponte.definirAba(corpo?.aba ?? null);
      return responderJson(res, 200, { ok: true, aba });
    }

    if (caminho === ROTAS.pedidos) {
      // GET é o método natural de uma assinatura; POST entra junto para o
      // cliente poder usar o mesmo caminho de código dos fluxos.
      if (req.method !== 'GET' && req.method !== 'POST') return responderTexto(res, 405, 'use GET');
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      ponte.assinar(req, res, ac.signal);
      return undefined;
    }

    if (caminho === ROTAS.resposta) {
      if (req.method !== 'POST') return responderTexto(res, 405, 'use POST');
      const corpo = await lerCorpoJson(req);
      return responderJson(res, 200, { ok: true, ...ponte.responder(corpo) });
    }

    if (caminho.startsWith(ROTAS.rpc)) {
      if (req.method !== 'POST') return responderTexto(res, 405, 'use POST');
      const endpoint = caminho.slice(ROTAS.rpc.length);
      if (!permitido(endpoint, 'rpc')) return responderJson(res, 403, { ok: false, erro: `endpoint nao permitido na ponte: ${endpoint}` });
      const corpo = await lerCorpoJson(req);
      const args = await emWorkspaceDoAddon(endpoint, extrairArgs(corpo), opcoes);
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const resultado = await ponte.rpc(endpoint, args, ac.signal);
      return responderJson(res, 200, resultado);
    }

    if (caminho.startsWith(ROTAS.fluxo)) {
      if (req.method !== 'POST') return responderTexto(res, 405, 'use POST');
      const endpoint = caminho.slice(ROTAS.fluxo.length);
      if (!permitido(endpoint, 'fluxo')) return responderJson(res, 403, { ok: false, erro: `fluxo nao permitido na ponte: ${endpoint}` });
      const corpo = await lerCorpoJson(req);
      return await transmitir(ponte, endpoint, extrairArgs(corpo), req, res);
    }

    return responderJson(res, 404, { ok: false, erro: 'rota desconhecida na ponte' });
  } catch (erro) {
    const status = Number.isSafeInteger(erro?.status) ? erro.status : 500;
    if (res.headersSent) {
      try {
        res.write(linha({ tipo: 'erro', erro: { code: 'ponte/falha', message: String(erro?.message ?? erro) } }));
      } catch {
        /* nada a fazer: a conexão já foi */
      }
      res.end();
      return undefined;
    }
    ctx.logger?.warn?.(`dsh-navegador: falha em ${caminho}: ${erro?.message ?? erro}`);
    return responderJson(res, status, { ok: false, erro: String(erro?.message ?? erro) });
  }
}

/** Abre um fluxo do gateway e o entrega como NDJSON. */
async function transmitir(ponte, endpoint, args, req, res) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  req.on('close', () => ac.abort());

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });

  const batimento = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write('\n');
    } catch {
      /* o fechamento adiante resolve */
    }
  }, 15_000);
  batimento.unref?.();

  try {
    const iteravel = await ponte.fluxo(endpoint, args, ac.signal);
    for await (const valor of iteravel) {
      if (res.destroyed) break;
      if (!res.write(linha({ tipo: 'item', valor }))) {
        await new Promise((resolve) => {
          const pronto = () => {
            res.off('drain', pronto);
            res.off('close', pronto);
            resolve();
          };
          res.once('drain', pronto);
          res.once('close', pronto);
        });
      }
    }
    if (!res.writableEnded && !res.destroyed) res.write(linha({ tipo: 'fim' }));
  } catch (erro) {
    if (!res.writableEnded && !res.destroyed) {
      const detalhe = erro?.details !== undefined && erro.details !== null ? { details: erro.details } : {};
      res.write(
        linha({
          tipo: 'erro',
          erro: { code: typeof erro?.code === 'string' ? erro.code : 'ponte/falha', message: String(erro?.message ?? erro), ...detalhe },
        }),
      );
    }
  } finally {
    clearInterval(batimento);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
  return undefined;
}
