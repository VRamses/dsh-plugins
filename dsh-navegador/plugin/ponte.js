/**
 * Núcleo da ponte: fala com o gateway interno do DSH, entrega os quadros para o
 * add-on e carrega os pedidos que o agente faz ao navegador.
 *
 * O caminho é tudo em processo: `ctx.get('typertGateway')` é o mesmo despachante
 * que atende o `/api` do DSH, então a ponte não precisa de cookie, de HTTP
 * interno nem de WebSocket. Foi de propósito: menos peça móvel entre o painel e
 * o harness.
 *
 * @module dsh-navegador/plugin/ponte
 */

import { randomUUID } from 'node:crypto';
import { linha } from './protocol.js';

/** Teto do corpo aceito pela ponte (imagem de aba entra em base64 aqui). */
const TETO_CORPO = 32 * 1024 * 1024;
/** Intervalo do comentário de vida nos fluxos abertos. */
const BATIMENTO_MS = 15_000;
/**
 * Prazo de espera pela APROVAÇÃO de uma ação.
 *
 * Antes eram 180s esperando o usuário clicar, e o agente ficava travado: quando
 * ninguém aprovava, a ferramenta só devolvia "o navegador nao respondeu ao
 * pedido". Agora, passado este prazo, a resposta volta na hora com
 * `pendente: true` e um identificador, e o pedido continua na tela do painel.
 */
const PRAZO_APROVACAO_MS = 12_000;
/** Prazo de espera pela resposta de leitura, print e lista de abas. */
const PRAZO_RESPOSTA_MS = 20_000;
/**
 * Vida de um pedido pendente.
 *
 * Depois disto ele nunca mais roda, mesmo que alguém clique no cartão: era assim
 * que ação do dia anterior continuava "Executando..." no painel.
 */
const PRAZO_EXPIRACAO_MS = 120_000;

/** Lê o corpo JSON de uma requisição, com teto de tamanho. */
export async function lerCorpoJson(req) {
  const declarado = Number(req.headers['content-length']);
  if (Number.isFinite(declarado) && declarado > TETO_CORPO) {
    const erro = new Error(`corpo acima do teto de ${TETO_CORPO} bytes`);
    erro.status = 413;
    throw erro;
  }
  const pedacos = [];
  let total = 0;
  for await (const pedaco of req) {
    total += pedaco.byteLength;
    if (total > TETO_CORPO) {
      const erro = new Error(`corpo acima do teto de ${TETO_CORPO} bytes`);
      erro.status = 413;
      throw erro;
    }
    pedacos.push(pedaco);
  }
  if (total === 0) return {};
  const texto = Buffer.concat(pedacos).toString('utf8');
  try {
    return JSON.parse(texto);
  } catch {
    const erro = new Error('o corpo nao e JSON');
    erro.status = 400;
    throw erro;
  }
}

/** Responde JSON sem cache e sem nenhum cabeçalho de CORS. */
export function responderJson(res, status, objeto) {
  const corpo = Buffer.from(JSON.stringify(objeto ?? null), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(corpo.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(corpo);
}

/** Responde texto puro, também sem CORS. */
export function responderTexto(res, status, texto) {
  const corpo = Buffer.from(texto, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(corpo.byteLength),
    'cache-control': 'no-store',
  });
  res.end(corpo);
}

/**
 * Valida o payload no mesmo formato que o `/api` do DSH espera: exatamente uma
 * chave `args`, objeto simples.
 *
 * A checagem importa porque o gateway do outro lado é LENIENTE demais: um corpo
 * `{errado:true}` vira `{}` e um endpoint com parâmetro opcional responde 200,
 * o que esconde o erro de quem chamou. Aqui isso é 400.
 * @param corpo - corpo JSON já decodificado.
 * @throws {Error} com `status` 400 quando o envelope está errado.
 */
export function extrairArgs(corpo) {
  const erro = (mensagem) => {
    const falha = new Error(mensagem);
    falha.status = 400;
    return falha;
  };
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) throw erro('o corpo precisa ser um objeto');
  const chaves = Object.keys(corpo);
  if (chaves.length !== 1 || chaves[0] !== 'args') throw erro('o corpo precisa ter exatamente a chave `args`');
  const args = corpo.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw erro('`args` precisa ser um objeto');
  return args;
}

/**
 * Acrescenta ao valor devolvido pelo painel o selo de autoaprovação, quando ele
 * veio no envelope (`autoaprovada: true`).
 *
 * O selo fica no envelope de propósito: um painel novo falando com um host
 * antigo não injeta campo que o schema fechado da ferramenta recusaria, e um
 * painel antigo falando com este host simplesmente não manda o selo. Só o
 * `navegador_agir` usa o campo; as leituras não declaram `autoaprovada` e
 * continuam recebendo o valor intacto porque o painel não manda o selo nelas.
 */
export function comSelo(resposta) {
  const valor = resposta.valor;
  if (resposta.autoaprovada !== true || valor === null || typeof valor !== 'object' || Array.isArray(valor)) return valor;
  return { ...valor, autoaprovada: true };
}

/**
 * Cria a ponte: despacho de RPC, fluxos NDJSON e a fila de pedidos ao navegador.
 *
 * @param ctx - contexto do host (lê `typertGateway`).
 * @param opções - `token`, `criadoEm`, `versao`, `home`.
 * @returns a ponte montada.
 */
export function criarPonte(ctx, opcoes) {
  const { token, versao } = opcoes;
  const criadoEm = new Date().toISOString();
  /*
   * Os prazos aceitam ajuste por opção para o teste rodar em milissegundos. O
   * boot do DSH não passa nada, então valem os padrões medidos aqui.
   */
  const prazoAprovacao = Number(opcoes.prazos?.aprovacaoMs) || PRAZO_APROVACAO_MS;
  const prazoResposta = Number(opcoes.prazos?.respostaMs) || PRAZO_RESPOSTA_MS;
  const prazoExpiracao = Number(opcoes.prazos?.expiracaoMs) || PRAZO_EXPIRACAO_MS;

  /** Assinantes ativos do canal de pedidos (um por painel aberto). */
  const assinantes = new Set();
  /** Pedidos do agente aguardando resposta do navegador. */
  const pendentes = new Map();
  /** Última aba informada pelo painel. */
  let aba = null;

  const gateway = () => {
    const servico = ctx.get('typertGateway');
    if (servico === undefined) throw new Error('dsh-navegador: o servico `typertGateway` nao esta montado');
    return servico;
  };

  /**
   * O Peer da ponte, exigido pelo gateway a partir do DSH Desktop 0.12.
   *
   * Medido em 21/10/2026 no 0.12.1: `invokeRpc` e `stream` nao aceitam mais a
   * chamada sem dono, porque `prepareInvocation` chama `assertPeerLive(request.peer)`
   * e essa funcao le `peer.signal`. Sem Peer a resposta vira
   * `Cannot read properties of undefined (reading 'signal')`, que era o que o
   * painel mostrava como "fluxo caiu (...); reconectando" e o que fazia toda
   * chamada de `/rpc` voltar `{ok:false, error:{code:"gateway/internal"}}`.
   *
   * Quem cria Peer em processo e o servico `connection` (`createPeer`, dono do
   * Context que leu o servico), e o principal `owner` e o mesmo das requisicoes
   * `/api` da interface; sem ele o gateway negaria por falta de recurso.
   *
   * O Peer e criado uma vez e reaproveitado: o sinal dele so aborta quando o
   * proprio plugin e descartado, e ai o proximo uso cria outro.
   * @returns o Peer da ponte.
   * @throws {Error} quando o servico `connection` nao esta montado.
   */
  let peer = null;
  function peerDaPonte() {
    const conexao = ctx.get('connection');
    if (conexao === undefined) {
      throw new Error(
        'dsh-navegador: o servico `connection` nao esta montado; sem Peer o gateway recusa a chamada (o add-on precisa do `connection` no inject)',
      );
    }
    if (peer !== null && peer.signal?.aborted !== true) return peer;
    const criado =
      typeof conexao.createPeer === 'function' ? conexao.createPeer({ principal: { kind: 'owner' } }) : conexao.browserPeer;
    if (criado === undefined || criado === null) {
      throw new Error('dsh-navegador: o servico `connection` nao entregou um Peer');
    }
    peer = criado;
    return peer;
  }

  function estado(extra = {}) {
    return {
      ok: true,
      protocolo: 1,
      ponte: { nome: 'dsh-navegador', versao, pid: process.pid, criadoEm, home: opcoes.home ?? null },
      painel: { assinantes: assinantes.size, aba },
      pedidos: {
        pendentes: pendentes.size,
        // Visíveis no `/ola` e no `sinal`: quem diagnostica vê na hora que a
        // espera por aprovação é curta de propósito.
        prazos: { aprovacaoMs: prazoAprovacao, respostaMs: prazoResposta, expiracaoMs: prazoExpiracao },
      },
      ...extra,
    };
  }

  /** Executa uma chamada unária pelo gateway, com o mesmo formato de resposta do `/api`. */
  async function rpc(endpoint, args, signal) {
    const resultado = await gateway().invokeRpc(endpoint, { args }, signal, peerDaPonte());
    if (resultado === undefined || typeof resultado !== 'object') {
      throw new Error(`resposta inesperada do gateway em ${endpoint}`);
    }
    return resultado;
  }

  /** Abre um fluxo pelo gateway e devolve o iterador assíncrono. */
  async function fluxo(endpoint, args, signal) {
    const [namespace, metodo] = endpoint.split('/');
    return gateway().stream({ namespace, method: metodo, args, signal, peer: peerDaPonte() });
  }

  // ---------------------------------------------------------------------
  // Canal de pedidos: o agente pede, o painel mostra, o usuário decide.
  // ---------------------------------------------------------------------

  function envioAssinante(assinante, objeto) {
    if (assinante.res.writableEnded || assinante.res.destroyed) return false;
    try {
      assinante.res.write(linha(objeto));
      return true;
    } catch {
      return false;
    }
  }

  /** Registra um painel como ouvinte dos pedidos do agente. */
  function assinar(req, res, signal) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    const assinante = { res, desde: new Date().toISOString(), aba: null };
    assinantes.add(assinante);
    envioAssinante(assinante, { tipo: 'aberto', desde: assinante.desde, aba });
    /*
     * Reentrega os pedidos que ainda estão esperando: o painel pode ter
     * recarregado no meio de um pedido do agente. Pedido vencido NÃO volta, e é
     * isso que impede a ação de ontem de reaparecer no painel de hoje.
     */
    const agora = Date.now();
    for (const pendente of pendentes.values()) {
      if (pendente.expiraEm <= agora) continue;
      envioAssinante(assinante, { tipo: 'pedido', pedido: pendente.pedido });
    }

    const batimento = setInterval(() => {
      if (assinante.res.writableEnded || assinante.res.destroyed) return;
      try {
        assinante.res.write('\n');
      } catch {
        /* o fechamento abaixo resolve */
      }
    }, BATIMENTO_MS);
    batimento.unref?.();

    const encerrar = () => {
      clearInterval(batimento);
      assinantes.delete(assinante);
      if (!res.writableEnded) res.end();
    };
    signal.addEventListener('abort', encerrar, { once: true });
    res.on('close', encerrar);
    res.on('error', encerrar);
  }

  /**
   * Espera a resposta do navegador para um pedido.
   *
   * Três desfechos, e a diferença entre eles é o que o agente precisa saber:
   *
   * - o painel responde: devolve o valor (ou rejeita com o motivo da recusa);
   * - ninguém aprova a ação em `prazoAprovacao`: resolve com `{pendente, id}`,
   *   porque a ação NÃO falhou, ela está na tela esperando o usuário;
   * - leitura/print/lista sem resposta: rejeita, porque aí é defeito.
   *
   * O pedido fica em `pendentes` até ser respondido ou até `prazoExpiracao`; vivo
   * depois disso, ele seria a ação de ontem presa no painel.
   * @param pedido - descrição do pedido (`tipo` + campos).
   * @param signal - cancelamento da chamada da ferramenta.
   * @returns o valor devolvido pelo painel, ou o aviso de pendente.
   */
  function pedir(pedido, signal) {
    if (assinantes.size === 0) {
      throw new Error(
        'o painel do add-on do navegador nao esta aberto nesta janela. Abra o painel na aba que voce quer usar e chame de novo.',
      );
    }
    const id = randomUUID();
    const agora = Date.now();
    const completo = {
      id,
      criadoEm: new Date(agora).toISOString(),
      expiraEm: new Date(agora + prazoExpiracao).toISOString(),
      aba,
      ...pedido,
    };
    // Só ação espera aprovação; leitura, print e lista respondem em milissegundos.
    const esperaAprovacao = pedido.tipo === 'agir';

    return new Promise((resolve, reject) => {
      let respondido = false;
      let avisado = false;
      let prazoDeResposta = null;
      let prazoDeExpiracao = null;

      const soltar = () => {
        clearTimeout(prazoDeResposta);
        clearTimeout(prazoDeExpiracao);
        signal?.removeEventListener('abort', aoCancelar);
        pendentes.delete(id);
      };

      const concluir = (resposta) => {
        if (respondido) return;
        respondido = true;
        soltar();
        for (const assinante of assinantes) envioAssinante(assinante, { tipo: 'resolvido', id });
        // Já avisado de "pendente": o resultado sai no transcrito do painel, não
        // na ferramenta, que já voltou.
        if (avisado) return;
        if (resposta.ok === true) resolve(comSelo(resposta));
        else {
          reject(
            new Error(typeof resposta.erro === 'string' && resposta.erro !== '' ? resposta.erro : 'o navegador recusou o pedido'),
          );
        }
      };

      const expirar = (erro) => {
        if (respondido) return;
        respondido = true;
        soltar();
        for (const assinante of assinantes) envioAssinante(assinante, { tipo: 'expirado', id });
        if (!avisado) reject(erro);
      };

      const aoCancelar = () => expirar(new Error('o pedido ao navegador foi cancelado'));

      const avisarPendente = () => {
        avisado = true;
        resolve({
          pendente: true,
          id,
          criadoEm: completo.criadoEm,
          expiraEm: completo.expiraEm,
          resumo: 'pendente de aprovacao no painel',
        });
      };

      /*
       * O painel avisa que começou a executar (autoaprovação ligada, ou você já
       * clicou em aprovar). Sem esse aviso a ponte não distingue "ninguém aprovou
       * em 12 s" de "aprovou e está executando algo lento", e ação lenta virava
       * "pendente" mesmo tendo rodado. Medido em 17/11/2026 no RadarRAM: clicar
       * voltava resultado, digitar 22 caracteres voltava pendente e o texto
       * aparecia no campo depois.
       */
      const aceitar = () => {
        if (respondido) return false;
        clearTimeout(prazoDeResposta);
        prazoDeResposta = setTimeout(
          () =>
            expirar(
              new Error(
                `o painel aceitou a acao e nao devolveu o resultado em ${Math.max(1, Math.round(prazoResposta / 1000))}s`,
              ),
            ),
          prazoResposta,
        );
        prazoDeResposta.unref?.();
        return true;
      };

      prazoDeResposta = setTimeout(() => {
        if (respondido) return;
        if (esperaAprovacao) avisarPendente();
        else expirar(new Error(`o painel nao respondeu ao pedido em ${Math.max(1, Math.round(prazoResposta / 1000))}s`));
      }, esperaAprovacao ? prazoAprovacao : prazoResposta);
      prazoDeResposta.unref?.();

      prazoDeExpiracao = setTimeout(
        () => expirar(new Error('o pedido ao navegador expirou sem resposta; nada foi executado')),
        prazoExpiracao,
      );
      prazoDeExpiracao.unref?.();

      pendentes.set(id, { pedido: completo, expiraEm: agora + prazoExpiracao, concluir, aceitar });
      for (const assinante of assinantes) envioAssinante(assinante, { tipo: 'pedido', pedido: completo });
      if (signal?.aborted === true) {
        aoCancelar();
        return;
      }
      signal?.addEventListener('abort', aoCancelar, { once: true });
    });
  }

  /** Recebe a resposta do painel a um pedido. */
  function responder(resposta) {
    if (typeof resposta !== 'object' || resposta === null) throw new Error('resposta invalida');
    const id = resposta.id;
    if (typeof id !== 'string') throw new Error('resposta sem id');
    const pendente = pendentes.get(id);
    if (pendente === undefined) return { conhecido: false };
    // Aviso de "comecei a executar": não conclui nada, só troca o relógio do
    // prazo de aprovação pelo de resposta. Painel antigo não manda este aviso, e
    // aí vale o comportamento de antes.
    if (resposta.tipo === 'aceito') {
      const aceito = typeof pendente.aceitar === 'function' ? pendente.aceitar() : false;
      return { conhecido: true, aceito };
    }
    pendente.concluir(resposta);
    return { conhecido: true };
  }

  /** Guarda o contexto da aba atual informado pelo painel. */
  function definirAba(nova) {
    if (nova === null) {
      aba = null;
      return aba;
    }
    if (typeof nova !== 'object' || typeof nova.url !== 'string') throw new Error('aba invalida');
    aba = {
      url: nova.url,
      titulo: typeof nova.titulo === 'string' ? nova.titulo : '',
      id: Number.isSafeInteger(nova.id) ? nova.id : null,
      janelaId: Number.isSafeInteger(nova.janelaId) ? nova.janelaId : null,
      atualizadoEm: new Date().toISOString(),
    };
    for (const assinante of assinantes) envioAssinante(assinante, { tipo: 'aba', aba });
    return aba;
  }

  return {
    token,
    estado,
    rpc,
    fluxo,
    assinar,
    responder,
    pedir,
    definirAba,
    abaAtual: () => aba,
    temPainel: () => assinantes.size > 0,
  };
}

/** Exportado para o teste conseguir o mesmo limite do servidor. */
export const TETO_CORPO_BYTES = TETO_CORPO;
