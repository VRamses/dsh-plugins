// Contrato da ponte com o gateway do DSH Desktop 0.12: toda chamada precisa de
// um Peer. O falso gateway abaixo reproduz o que o gateway de verdade faz
// (`assertPeerLive` le `peer.signal`) e o teste falha se a ponte nao passar um.
//
// A importacao era um caminho absoluto com o nome do usuario do desktop
// (`file:///C:/Users/victo/...`), entao esta etapa quebrava no notebook, onde o
// perfil e outro. Relativa ao arquivo, funciona nas duas maquinas.
import { criarPonte } from '../plugin/ponte.js';

function gatewayFalso() {
  const exige = (peer) => {
    // Mesma leitura do gateway real (api-gateway/lib/index.js, assertPeerLive).
    if (peer.signal.aborted) throw new Error('peer disposed');
    if (peer.principal.kind !== 'owner') throw new Error('principal errado');
  };
  return {
    chamadas: [],
    async invokeRpc(endpoint, payload, signal, peer) {
      exige(peer);
      this.chamadas.push(`rpc ${endpoint}`);
      return { ok: true, value: { endpoint, payload } };
    },
    async stream(request) {
      exige(request.peer);
      this.chamadas.push(`fluxo ${request.namespace}/${request.method}`);
      return (async function* () {
        yield { tipo: 'item', valor: { primeiro: true } };
      })();
    },
  };
}

function ctxFalso({ comConexao = true } = {}) {
  const gateway = gatewayFalso();
  const conexao = {
    criados: 0,
    createPeer(options) {
      this.criados += 1;
      return { principal: options.principal, signal: new AbortController().signal };
    },
  };
  return {
    gateway,
    conexao,
    get(nome) {
      if (nome === 'typertGateway') return gateway;
      if (nome === 'connection') return comConexao ? conexao : undefined;
      return undefined;
    },
  };
}

const falhas = [];
const conferir = (condicao, texto) => {
  if (!condicao) falhas.push(texto);
  console.log(`${condicao ? 'ok  ' : 'FALHA'} ${texto}`);
};

// 1. O caminho ANTIGO (sem Peer) contra a leitura do gateway real: e o erro do
//    painel. Reproduz `assertPeerLive(request.peer)` lendo `peer.signal`.
const assertPeerLive = (peer) => {
  if (peer.signal.aborted) throw new Error('peer disposed');
};
const erroAntes = await (async () => {
  try {
    return { ok: await Promise.resolve().then(() => assertPeerLive(undefined)) };
  } catch (e) {
    return e;
  }
})();
conferir(
  erroAntes instanceof TypeError && /reading 'signal'/.test(erroAntes.message),
  `sem Peer o gateway estoura o erro do painel ("${erroAntes.message}")`,
);

// 2. Com o servico `connection`, RPC e fluxo passam e reusam um Peer so.
const ctx = ctxFalso();
const ponte = criarPonte(ctx, { token: 'x', versao: '0.2.0' });
const rpc = await ponte.rpc('session/list', {});
conferir(rpc.ok === true, 'rpc passa pelo gateway com o Peer');
const iteravel = await ponte.fluxo('session/follow', { address: { kind: 'session', sessionId: 's' } });
const quadros = [];
for await (const q of iteravel) quadros.push(q);
conferir(quadros.length === 1, 'fluxo devolve o iterador do gateway');
conferir(ctx.conexao.criados === 1, `o Peer e criado uma vez so (criados=${ctx.conexao.criados})`);
conferir(
  ctx.gateway.chamadas.join('|') === 'rpc session/list|fluxo session/follow',
  `chamadas: ${ctx.gateway.chamadas.join('|')}`,
);

// 3. Sem `connection`, a mensagem diz o que falta em vez de estourar TypeError.
const semConexao = criarPonte(ctxFalso({ comConexao: false }), { token: 'x', versao: '0.2.0' });
const erroSem = await semConexao.rpc('session/list', {}).catch((e) => e);
conferir(/connection/.test(erroSem.message) && !(erroSem instanceof TypeError), `sem connection: "${erroSem.message}"`);

console.log(falhas.length === 0 ? 'TUDO OK' : `FALHAS: ${falhas.length}`);
process.exitCode = falhas.length === 0 ? 0 : 1;
