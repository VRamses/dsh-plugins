/*
 * Teste da espera curta por aprovacao e da expiracao dos pedidos.
 *
 * O defeito que este teste cobre foi medido em 04/11/2026: `navegador_agir`
 * esperava 180s por uma aprovacao que podia nunca vir, e o agente ficava travado
 * ate devolver "o navegador nao respondeu ao pedido". Pior: pedido que ninguem
 * aprovava continuava vivo e reaparecia no painel, e foi assim que uma acao do dia
 * anterior ficou parada em "Executando...".
 *
 * Roda contra a ponte de verdade (`criarPonte`), com um painel de mentira que
 * implementa so o contrato usado: `res.write` recebendo NDJSON. Os prazos entram
 * por opcao, em milissegundos, e nao pelos 12s/20s/120s do host.
 *
 * Uso: node testar-pendencias.mjs
 */

import { criarPonte } from '../plugin/ponte.js';

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

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ponte com prazos curtos, sem gateway (os testes nao usam RPC). */
function ponteCom(prazos) {
  const ctx = { get: () => undefined };
  return criarPonte(ctx, { token: 'token-de-teste', versao: '0.4.0', prazos });
}

/**
 * Painel de mentira assinando o canal de pedidos.
 *
 * Guarda cada linha NDJSON escrita, para o teste conferir o que o painel recebeu.
 */
function assinarPainel(ponte) {
  const escritos = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    write(texto) {
      escritos.push(String(texto));
      return true;
    },
    on() {},
    off() {},
    end() {
      res.writableEnded = true;
    },
  };
  const req = { on() {} };
  const ac = new AbortController();
  ponte.assinar(req, res, ac.signal);
  const mensagens = () =>
    escritos
      .join('')
      .split('\n')
      .map((linha) => linha.trim())
      .filter((linha) => linha !== '')
      .map((linha) => JSON.parse(linha));
  return { mensagens, fechar: () => ac.abort() };
}

async function principal() {
  console.log('espera por aprovacao e expiracao dos pedidos');

  /*
   * `pedir` usa `setTimeout(...).unref()` de proposito, para nao segurar o boot do
   * DSH. Num teste que so espera promessa, isso faria o processo sair antes do
   * prazo; este intervalo mantem o laco vivo ate o fim.
   */
  const segura = setInterval(() => undefined, 250);

  // -------------------------------------------------------------------------
  // 1. sem painel, falha na hora
  // -------------------------------------------------------------------------

  console.log('\n1. sem painel aberto');
  const vazia = ponteCom({ aprovacaoMs: 50, respostaMs: 50, expiracaoMs: 200 });
  let erroSemPainel = null;
  try {
    vazia.pedir({ tipo: 'agir', acao: 'clicar' });
  } catch (erro) {
    erroSemPainel = erro;
  }
  conferir('pedir sem assinante falha sincrono', erroSemPainel instanceof Error);
  conferir('a mensagem manda abrir o painel', /painel do add-on/.test(erroSemPainel?.message ?? ''));

  // -------------------------------------------------------------------------
  // 2. acao sem aprovacao volta pendente, e rapido
  // -------------------------------------------------------------------------

  console.log('\n2. acao sem aprovacao');
  const ponte = ponteCom({ aprovacaoMs: 60, respostaMs: 80, expiracaoMs: 400 });
  const painel = assinarPainel(ponte);
  const inicio = Date.now();
  const resposta = await ponte.pedir({ tipo: 'agir', acao: 'clicar', seletor: '#x' });
  const gasto = Date.now() - inicio;

  conferir('a acao sem aprovacao volta pendente', resposta?.pendente === true);
  conferir('a resposta traz um identificador', typeof resposta?.id === 'string' && resposta.id.length > 10);
  conferir('nao espera os 180s antigos', gasto < 1000, `${gasto}ms`);
  conferir('a resposta diz quando o pedido expira', typeof resposta?.expiraEm === 'string' && resposta.expiraEm !== '');
  conferir('o painel recebeu o pedido com id e carimbo', painel.mensagens().some((m) => m.tipo === 'pedido' && m.pedido?.id === resposta.id && typeof m.pedido?.criadoEm === 'string'));
  conferir('o pedido pendente continua na ponte', ponte.estado().pedidos.pendentes === 1);

  // -------------------------------------------------------------------------
  // 3. o pendente expira e o painel e avisado
  // -------------------------------------------------------------------------

  console.log('\n3. expiracao do pendente');
  await espera(500);
  const depois = painel.mensagens();
  conferir('o painel foi avisado da expiracao', depois.some((m) => m.tipo === 'expirado' && m.id === resposta.id));
  conferir('a ponte nao guarda mais o pendente', ponte.estado().pedidos.pendentes === 0);
  const tardia = ponte.responder({ id: resposta.id, ok: true, valor: { resumo: 'cliquei tarde demais' } });
  conferir('resposta que chega tarde nao executa nada', tardia.conhecido === false);

  // -------------------------------------------------------------------------
  // 4. aprovacao a tempo resolve com o valor
  // -------------------------------------------------------------------------

  console.log('\n4. aprovacao a tempo');
  const ponte2 = ponteCom({ aprovacaoMs: 2000, respostaMs: 2000, expiracaoMs: 5000 });
  const painel2 = assinarPainel(ponte2);
  const promessa = ponte2.pedir({ tipo: 'agir', acao: 'clicar', seletor: '#y' });
  await espera(20);
  const enviado = painel2.mensagens().find((m) => m.tipo === 'pedido')?.pedido;
  const aceito = ponte2.responder({ id: enviado.id, ok: true, valor: { resumo: 'cliquei em <a>' }, aprovada: true, autoaprovada: true });
  const valor = await promessa;
  conferir('a resposta do painel resolve a promessa', valor?.resumo === 'cliquei em <a>');
  conferir('o painel foi avisado que resolveu', painel2.mensagens().some((m) => m.tipo === 'resolvido' && m.id === enviado.id));
  conferir('a ponte aceitou a resposta', aceito.conhecido === true);
  conferir('o selo de autoaprovacao chega no envelope', valor?.autoaprovada === true);
  conferir('a ponte fica sem pendentes', ponte2.estado().pedidos.pendentes === 0);

  // -------------------------------------------------------------------------
  // 5. leitura sem resposta falha, nao vira pendente
  // -------------------------------------------------------------------------

  console.log('\n5. leitura sem resposta');
  const ponte3 = ponteCom({ aprovacaoMs: 50, respostaMs: 60, expiracaoMs: 500 });
  assinarPainel(ponte3);
  let falhaLeitura = null;
  try {
    await ponte3.pedir({ tipo: 'ler', oQue: 'texto' });
  } catch (erro) {
    falhaLeitura = erro;
  }
  conferir('leitura sem resposta falha em vez de ficar pendente', falhaLeitura instanceof Error);
  conferir('a falha diz que o painel nao respondeu', /nao respondeu|expirou/.test(falhaLeitura?.message ?? ''), falhaLeitura?.message ?? '');

  // -------------------------------------------------------------------------
  // 6. pedido vencido NAO e reentregue ao reconectar
  // -------------------------------------------------------------------------

  console.log('\n6. reentrega ao reconectar');
  const ponte4 = ponteCom({ aprovacaoMs: 5000, respostaMs: 5000, expiracaoMs: 80 });
  const painel4 = assinarPainel(ponte4);
  const vencido = ponte4.pedir({ tipo: 'agir', acao: 'clicar', seletor: '#z' }).catch(() => null);
  await espera(200);
  await vencido;
  const reconectado = assinarPainel(ponte4);
  const reentregues = reconectado.mensagens().filter((m) => m.tipo === 'pedido');
  conferir('pedido vencido nao volta para o painel novo', reentregues.length === 0, `${reentregues.length} reentrega(s)`);

  // -------------------------------------------------------------------------
  // 7. um pedido vivo e reentregue (o comportamento bom continua)
  // -------------------------------------------------------------------------

  console.log('\n7. reentrega do pedido vivo');
  const ponte5 = ponteCom({ aprovacaoMs: 5000, respostaMs: 5000, expiracaoMs: 5000 });
  assinarPainel(ponte5);
  const vivo = ponte5.pedir({ tipo: 'agir', acao: 'clicar', seletor: '#w' }).catch(() => null);
  await espera(20);
  const outro = assinarPainel(ponte5);
  conferir('pedido vivo e reentregue ao painel que reconecta', outro.mensagens().filter((m) => m.tipo === 'pedido').length === 1);
  await espera(20);

  // -------------------------------------------------------------------------
  // 8. os prazos aparecem no estado
  // -------------------------------------------------------------------------

  console.log('\n8. prazos no estado da ponte');
  const estado = ponte.estado();
  conferir('o estado publica os prazos', estado.pedidos?.prazos?.aprovacaoMs === 60 && estado.pedidos?.prazos?.expiracaoMs === 400);

  clearInterval(segura);
  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

await principal();
