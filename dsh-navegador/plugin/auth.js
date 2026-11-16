/**
 * Autenticação e cerca de rede da ponte `dsh-navegador`.
 *
 * Modelo, em uma frase: a ponte só responde em loopback, e tudo o que sai dela
 * (menos `ola` e `parear`) exige `Authorization: Bearer <token>`.
 *
 * Por que token, e não o cookie do DSH: o cookie do `dsh web` é `HttpOnly` e
 * `SameSite=Strict`, amarrado a uma autoridade, e nenhuma extensão de navegador
 * consegue usá-lo. O token daqui é gerado pelo harness, guardado no cofre de
 * credenciais (`<home>\.credentials.yaml`, registro `dsh-navegador/ponte`),
 * entregue UMA vez por `parear` e comparado em tempo constante.
 *
 * Por que `parear` pode ser sem token: uma página web que tentasse ler a
 * resposta não consegue, porque a ponte nunca devolve cabeçalho CORS e o
 * navegador bloqueia a leitura de resposta cross-origin. Quem tem permissão de
 * host (a extensão) lê; a página vê "opaque". É o pedido de pareamento não tem
 * efeito colateral: só devolve o token que já existia.
 *
 * @module dsh-navegador/plugin/auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Owner do registro no cofre de credenciais. */
const DONO = 'dsh-navegador';
/** Id do registro no cofre de credenciais. */
const ID_REGISTRO = 'ponte';
/** Bytes de entropia do token. */
const BYTES = 32;

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Verdadeiro quando o endereço remoto é a própria máquina. */
export function ehLoopback(remoto) {
  if (typeof remoto !== 'string' || remoto === '') return false;
  const semPrefixo = remoto.startsWith('::ffff:') ? remoto.slice('::ffff:'.length) : remoto;
  if (semPrefixo === '::1' || semPrefixo === 'localhost') return true;
  const partes = semPrefixo.split('.');
  return partes.length === 4 && partes[0] === '127' && partes.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** Verdadeiro quando o cabeçalho `Host` aponta para a própria máquina. */
export function hostLocal(cabecalhos) {
  const bruto = cabecalhos?.host;
  if (typeof bruto !== 'string' || bruto === '') return false;
  try {
    return ehLoopback(new URL(`http://${bruto}`).hostname.replace(/^\[|\]$/gu, ''));
  } catch {
    return false;
  }
}

/**
 * Verdadeiro quando o `Origin` parece de PÁGINA web (`http:`/`https:`).
 *
 * A extensão manda `Origin` ausente ou um esquema de extensão
 * (`chrome-extension:`, `opera-extension:`); uma página sempre manda http(s).
 * Isso é o segundo cadeado do `parear`: mesmo que a leitura estivesse liberada
 * por um bug de CORS, a requisição de uma página seria recusada aqui.
 */
export function origemDePagina(cabecalhos) {
  const origem = cabecalhos?.origin;
  if (typeof origem !== 'string' || origem === '') return false;
  try {
    const { protocol } = new URL(origem);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return true;
  }
}

/**
 * Carrega o token da ponte, criando na primeira vez.
 *
 * @param ctx - contexto do host com o serviço `credentials`.
 * @returns o token em texto (base64url) e se ele acabou de ser criado.
 */
export async function carregarToken(ctx) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) {
    throw new Error('dsh-navegador: o servico `credentials` nao esta montado; a ponte nao tem onde guardar o token');
  }
  const { credentialKey } = await import('@deepseek-ai/dsh-credentials');
  const chave = credentialKey(DONO, ID_REGISTRO);
  let criado = false;
  const registro = await credentials.modifyRecord(chave, async (atual) => {
    const existente = lerToken(atual);
    if (existente !== undefined) return undefined;
    criado = true;
    return { kind: 'grant', payload: { version: 1, token: base64url(randomBytes(BYTES)) } };
  });
  const token = lerToken(registro);
  if (token === undefined) throw new Error('dsh-navegador: o registro do token nao foi criado no cofre de credenciais');
  return { token, criado };
}

function lerToken(registro) {
  if (registro === undefined || registro === null) return undefined;
  const payload = registro.payload;
  if (registro.kind !== 'grant' || typeof payload !== 'object' || payload === null) return undefined;
  const token = payload.token;
  if (typeof token !== 'string' || token.length !== 43) return undefined;
  return token;
}

/** Compara o token apresentado com o esperado, sem vazar tempo. */
export function tokenConfere(apresentado, esperado) {
  if (typeof apresentado !== 'string' || typeof esperado !== 'string') return false;
  const a = Buffer.from(apresentado, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * Lê o token do cabeçalho `Authorization: Bearer ...`.
 * @param cabeçalhos - cabeçalhos da requisição.
 * @returns o token, ou `undefined` quando o cabeçalho não está no formato.
 */
export function tokenDoCabecalho(cabecalhos) {
  const bruto = cabecalhos?.authorization;
  if (typeof bruto !== 'string') return undefined;
  const partes = bruto.split(' ');
  if (partes.length !== 2 || partes[0].toLowerCase() !== 'bearer') return undefined;
  const token = partes[1].trim();
  return token === '' ? undefined : token;
}

/**
 * Decide se a requisição pode seguir, e com que recusa responder.
 *
 * @param req - requisição `node:http`.
 * @param token - token esperado da ponte.
 * @param opções - `exigeToken` (padrão true) e `recusaOrigem` (padrão false).
 * @returns `undefined` quando passa, ou `{ status, motivo }` quando recusa.
 */
export function avaliar(req, token, opcoes = {}) {
  const exigeToken = opcoes.exigeToken !== false;
  if (!ehLoopback(req.socket?.remoteAddress)) {
    return { status: 403, motivo: 'a ponte so responde em loopback' };
  }
  if (!hostLocal(req.headers)) {
    return { status: 403, motivo: 'Host nao e local' };
  }
  if (opcoes.recusaOrigem === true && origemDePagina(req.headers)) {
    return { status: 403, motivo: 'pedido vindo de pagina web' };
  }
  if (!exigeToken) return undefined;
  if (!tokenConfere(tokenDoCabecalho(req.headers), token)) {
    return { status: 401, motivo: 'token ausente ou invalido' };
  }
  return undefined;
}
