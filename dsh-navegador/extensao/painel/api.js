/*
 * Cliente da ponte `dsh-navegador` no servidor do DSH.
 *
 * Três operações, e só:
 *   - `ola` / `parear`: achar a ponte e pegar o token;
 *   - `rpc`: chamada unária (envelope igual ao do `/api` do DSH);
 *   - `fluxo` / `assinar`: NDJSON transmitido aos poucos.
 *
 * O token vai em `Authorization: Bearer`. Não há cookie no meio: foi assim de
 * propósito, porque o cookie do `dsh web` é `HttpOnly` + `SameSite=Strict` e
 * nenhuma extensão alcança ele.
 */

import { BASE_PONTE, PROTOCOLO, normalizarBase, urlPonte } from '../comum.js';

/** Erro vindo da ponte ou do gateway, com código preservado. */
export class ErroPonte extends Error {
  constructor(mensagem, codigo, detalhes) {
    super(mensagem);
    this.name = 'ErroPonte';
    this.codigo = codigo ?? 'ponte/falha';
    this.detalhes = detalhes;
  }
}

/*
 * Envelope de argumentos NO FIO, por endpoint.
 *
 * Isto não é capricho: o gateway valida os nomes exatamente contra o descritor
 * do Remote, e o nome NÃO é sempre `request`. Os 180 endpoints do DSH Desktop
 * 0.12.1 se dividem em três formas, medidas com `ferramentas/mapear-endpoints.mjs`,
 * que lê os descritores de dentro do app.asar:
 *
 *   1. `{ request: <args> }`  - a maioria (session/prompt, session/create,
 *      session/cancel, session/projections, session/follow, skills/list,
 *      messageFeedback/*, job/kill, ...). E o CONJUNTO COM_REQUEST abaixo.
 *   2. `{ _request: <args> }` - UM caso, `session/list`. Com underscore.
 *   3. sem envelope           - parâmetros soltos (`account/getBalance {client}`,
 *      `userQuestions/answer {agentId, callId, answer}`, `goals/get {agentId}`)
 *      ou nenhum parâmetro (`agentPresets/list`, `session/modelCatalog`,
 *      `llm/listProviders`, `pluginInventory/list`). É o que sobra.
 *
 * O que muda entre versões é o ENVELOPE (qual chave) e, às vezes, o MIOLO (quais
 * campos dentro dela). Medido em 21/10/2026: no 0.12 `skills/list` e
 * `messageFeedback/list` continuam com `request`, mas passaram a exigir
 * `request: { sessionId }`; com `request: {}` o gateway recusa por boundary
 * validation. O `conferir-envelope.mjs` confere esta tabela contra os descritores
 * da versão instalada, então deriva de envelope vira falha de teste, não rodada
 * de tentativa e erro.
 *
 * Errar isso dá "args fields do not match the descriptor" e custa uma rodada por
 * endpoint: em 16/10/2026 custou duas.
 */
/** Endpoints cujo argumento passa por `{ _request: ... }`. */
export const COM_UNDERSCORE_REQUEST = new Set(['session/list']);

/** Endpoints cujo argumento passa por `{ request: ... }`. */
export const COM_REQUEST = new Set([
  // sessões
  'session/create',
  'session/prompt',
  'session/cancel',
  'session/rename',
  'session/delete',
  'session/fork',
  'session/page',
  'session/search',
  'session/projections',
  'session/selectModel',
  // FLUXOS com envelope (o `session/follow` cai aqui: sem ele, o gateway
  // responde "missing request; unexpected address, assistantStream")
  'session/follow',
  'job/follow',
  'job/list',
  // leitura de apoio
  'skills/list',
  'sessionFeedback/record',
  'messageFeedback/list',
  'messageFeedback/put',
  'messageFeedback/delete',
  // trabalho em segundo plano
  'job/kill',
  // metas (21/10/2026: no DSH 0.12 `create` e `edit` passaram a querer envelope;
  // `goals/get` e o resto continuam com `agentId` solto)
  'goals/create',
  'goals/edit',
  // descoberta de modelos: idem, passou a querer envelope no 0.12
  'llm/discoverModels',
]);

/**
 * Monta o `args` no formato que o descritor daquele endpoint espera.
 * @param endpoint - endpoint no formato `namespace/metodo`.
 * @param args - argumentos no formato semântico (o de dentro do envelope).
 */
export function envelope(endpoint, args = {}) {
  if (COM_UNDERSCORE_REQUEST.has(endpoint)) return { _request: args ?? {} };
  if (COM_REQUEST.has(endpoint)) return { request: args ?? {} };
  return args ?? {};
}

/** Cliente de uma ponte. */
export class Ponte {
  /**
   * @param baseUrl - endereço do servidor web do DSH.
   * @param token - token do pareamento (pode ser vazio, para `ola` e `parear`).
   */
  constructor(baseUrl, token = '') {
    this.baseUrl = normalizarBase(baseUrl);
    this.token = token;
  }

  #cabecalhos(comCorpo) {
    const cabecalhos = { accept: 'application/json' };
    if (comCorpo) cabecalhos['content-type'] = 'application/json';
    if (this.token !== '') cabecalhos.authorization = `Bearer ${this.token}`;
    return cabecalhos;
  }

  async #json(caminho, opcoes = {}) {
    const resposta = await fetch(urlPonte(this.baseUrl, caminho), {
      method: opcoes.method ?? 'GET',
      headers: this.#cabecalhos(opcoes.body !== undefined),
      ...(opcoes.body === undefined ? {} : { body: JSON.stringify(opcoes.body) }),
      ...(opcoes.signal === undefined ? {} : { signal: opcoes.signal }),
      cache: 'no-store',
    });
    const texto = await resposta.text();
    let dados;
    try {
      dados = texto === '' ? {} : JSON.parse(texto);
    } catch {
      throw new ErroPonte(`a ponte respondeu algo que nao e JSON (HTTP ${resposta.status})`, 'ponte/resposta-invalida');
    }
    if (!resposta.ok) {
      throw new ErroPonte(typeof dados?.erro === 'string' ? dados.erro : `a ponte recusou (HTTP ${resposta.status})`, `http/${resposta.status}`);
    }
    return dados;
  }

  /** Identidade da ponte. Não precisa de token e é o que descobre o endereço. */
  async ola() {
    const dados = await this.#json('/ola');
    if (dados?.protocolo !== PROTOCOLO) {
      throw new ErroPonte(`a ponte fala o protocolo ${dados?.protocolo ?? '?'} e este add-on fala o ${PROTOCOLO}`, 'ponte/protocolo');
    }
    return dados;
  }

  /** Pega o token da máquina. Só funciona de loopback, que é onde o painel está. */
  async parear() {
    const dados = await this.#json('/parear');
    if (typeof dados?.token !== 'string' || dados.token === '') throw new ErroPonte('a ponte nao devolveu token', 'ponte/sem-token');
    this.token = dados.token;
    return dados;
  }

  /** Diz se o token atual vale. */
  async sinal() {
    return this.#json('/sinal', { method: 'POST', body: {} });
  }

  /** Informa a ponte qual aba o painel está mostrando. */
  async anunciarAba(aba) {
    return this.#json('/aba', { method: 'POST', body: { aba } });
  }

  /**
   * Chamada unária. Os `args` vão no formato semântico e o envelope do endpoint
   * é montado aqui (`envelope`).
   * @returns o resultado cru do gateway: `{ok:true,value}` ou `{ok:false,error}`.
   */
  async rpc(endpoint, args = {}, signal) {
    return this.#json(`/rpc/${endpoint}`, { method: 'POST', body: { args: envelope(endpoint, args) }, signal });
  }

  /**
   * Chamada unária que exige sucesso e devolve só o valor.
   * @throws {ErroPonte} com o código e a mensagem do gateway.
   */
  async valor(endpoint, args = {}, signal) {
    const resultado = await this.rpc(endpoint, args, signal);
    if (resultado?.ok !== true) {
      const erro = resultado?.error ?? {};
      throw new ErroPonte(`${endpoint}: ${erro.message ?? 'falhou'}`, erro.code, erro.details);
    }
    return resultado.value;
  }

  /**
   * Assina um caminho NDJSON, entregando cada mensagem ao retorno de chamada.
   * Usado tanto pelos fluxos do gateway (POST) quanto pelo canal de pedidos
   * (GET: é uma assinatura de leitura, não um comando).
   * @param caminho - caminho depois do prefixo da ponte.
   * @param corpo - corpo JSON (ignorado no GET).
   * @param aoMensagem - recebe cada objeto decodificado.
   * @param signal - cancelamento.
   * @param método - `POST` (padrão) ou `GET`.
   */
  async assinar(caminho, corpo, aoMensagem, signal, metodo = 'POST') {
    const comCorpo = metodo !== 'GET';
    /*
     * O `signal` NAO vai para o `fetch`. No Node, abortar um fetch que esta com
     * um `read()` pendente derruba o processo com
     * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (medido em
     * 17/10/2026, `testar-transcrito.mjs --meu`). Como o corpo e lido aqui no
     * laco, a corrida em `comAborto` desiste na hora e o `cancel()` do leitor
     * fecha a conexao pelo caminho normal.
     */
    const resposta = await fetch(urlPonte(this.baseUrl, caminho), {
      method: metodo,
      headers: this.#cabecalhos(comCorpo),
      ...(comCorpo ? { body: JSON.stringify(corpo ?? {}) } : {}),
      cache: 'no-store',
    });
    if (!resposta.ok) {
      const texto = await resposta.text();
      let detalhe = texto;
      try {
        detalhe = JSON.parse(texto)?.erro ?? texto;
      } catch {
        /* fica o texto cru */
      }
      throw new ErroPonte(String(detalhe).slice(0, 400) || `a ponte recusou (HTTP ${resposta.status})`, `http/${resposta.status}`);
    }
    await lerNdjson(resposta.body, aoMensagem, signal);
  }

  /**
   * Assina um fluxo do gateway (`session/follow` e companhia).
   * @param endpoint - endpoint no formato `namespace/metodo`.
   */
  async fluxo(endpoint, args, aoValor, signal) {
    await this.assinar(
      `/fluxo/${endpoint}`,
      { args: envelope(endpoint, args) },
      (mensagem) => {
        if (mensagem.tipo === 'item') return aoValor(mensagem.valor);
        if (mensagem.tipo === 'erro') throw new ErroPonte(mensagem.erro?.message ?? 'o fluxo falhou', mensagem.erro?.code);
        return undefined;
      },
      signal,
    );
  }

  /** Assina o canal de pedidos do agente e o de troca de aba. */
  async pedidos(aoMensagem, signal) {
    await this.assinar('/pedidos', {}, aoMensagem, signal, 'GET');
  }

  /** Responde a um pedido do agente. */
  async responder(resposta) {
    return this.#json('/resposta', { method: 'POST', body: resposta });
  }
}

/**
 * Lê um corpo NDJSON linha por linha e chama o retorno para cada linha.
 * Linha vazia é o batimento de vida: só reinicia o relógio.
 */
/**
 * Desiste de uma promessa quando o sinal aborta, sem tocar no fetch.
 *
 * Existe por causa da assertion do libuv no Windows: quem fecha a conexao e o
 * `cancel()` do leitor, no `finally` de `lerNdjson`.
 * @param promessa - a promessa a esperar.
 * @param signal - sinal de cancelamento (opcional).
 * @returns o valor da promessa, ou rejeita com AbortError.
 */
function comAborto(promessa, signal) {
  if (signal === undefined) return promessa;
  if (signal.aborted === true) return Promise.reject(new DOMException('abortado', 'AbortError'));
  return new Promise((ok, falha) => {
    const aoAbortar = () => falha(new DOMException('abortado', 'AbortError'));
    signal.addEventListener('abort', aoAbortar, { once: true });
    promessa.then(
      (valor) => {
        signal.removeEventListener('abort', aoAbortar);
        ok(valor);
      },
      (erro) => {
        signal.removeEventListener('abort', aoAbortar);
        falha(erro);
      },
    );
  });
}

async function lerNdjson(corpo, aoMensagem, signal) {
  if (corpo === null) throw new ErroPonte('a ponte fechou o fluxo sem corpo', 'ponte/sem-corpo');
  const leitor = corpo.getReader();
  const decodificador = new TextDecoder();
  let sobra = '';
  try {
    for (;;) {
      const { value, done } = await comAborto(leitor.read(), signal);
      if (done === true) break;
      sobra += decodificador.decode(value, { stream: true });
      let corte = sobra.indexOf('\n');
      while (corte >= 0) {
        const linha = sobra.slice(0, corte).trim();
        sobra = sobra.slice(corte + 1);
        if (linha !== '') {
          let mensagem;
          try {
            mensagem = JSON.parse(linha);
          } catch {
            throw new ErroPonte('a ponte mandou uma linha que nao e JSON', 'ponte/linha-invalida');
          }
          aoMensagem(mensagem);
        }
        corte = sobra.indexOf('\n');
      }
    }
    const resto = sobra.trim();
    if (resto !== '') aoMensagem(JSON.parse(resto));
  } finally {
    try {
      await leitor.cancel();
    } catch {
      /* o fluxo já morreu */
    }
  }
}

/** Prefixo da ponte, reexportado por conveniência de quem importa daqui. */
export { BASE_PONTE };
