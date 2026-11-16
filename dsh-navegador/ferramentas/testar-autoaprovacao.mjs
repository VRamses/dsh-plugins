/*
 * Teste da autoaprovação das ações do agente.
 *
 * O painel não roda no Node (é extensão de navegador, com DOM e `chrome`), então
 * o que dá para provar aqui é o que decide o comportamento: a regra de escopo
 * ("vale para esta conversa"), o armazenamento que morre com o navegador, e a
 * fiação do painel (o desvio acontece ANTES do cartão de aprovação, e o cartão
 * oferece a caixa "não perguntar de novo").
 *
 * O clique de verdade, com o agente navegando, só o navegador prova: o roteiro
 * está no HANDOFF, seção 3.15.
 *
 * Uso: node testar-autoaprovacao.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoValePara, CHAVE_AUTO_APROVAR, lerAutoAprovar, salvarAutoAprovar } from '../extensao/comum.js';
import { comSelo } from '../plugin/ponte.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..');
const EXT = path.join(RAIZ, 'extensao');
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

/** `chrome.storage.session` de mentira, com o mesmo contrato usado pelo painel. */
function instalarArmazenamentoFalso() {
  const dados = new Map();
  globalThis.chrome = {
    storage: {
      session: {
        async get(chave) {
          return dados.has(chave) ? { [chave]: dados.get(chave) } : {};
        },
        async set(objeto) {
          for (const [chave, valor] of Object.entries(objeto)) dados.set(chave, valor);
        },
        async remove(chave) {
          dados.delete(chave);
        },
      },
    },
  };
  return dados;
}

const ler = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');

/** Corpo de uma função de primeiro nível, por chaves balanceadas. */
function corpoDaFuncao(fonte, nome) {
  const inicio = fonte.indexOf(`function ${nome}(`);
  if (inicio < 0) return null;
  // O primeiro `{` depois do nome pode ser o de um parâmetro desestruturado
  // (`{ automatica = false }`); o corpo é o primeiro `{` fora dos parênteses.
  let parenteses = 0;
  let abre = -1;
  for (let i = fonte.indexOf('(', inicio); i < fonte.length; i += 1) {
    if (fonte[i] === '(') parenteses += 1;
    else if (fonte[i] === ')') parenteses -= 1;
    else if (fonte[i] === '{' && parenteses === 0) {
      abre = i;
      break;
    }
  }
  if (abre < 0) return null;
  let profundidade = 0;
  for (let i = abre; i < fonte.length; i += 1) {
    if (fonte[i] === '{') profundidade += 1;
    else if (fonte[i] === '}') {
      profundidade -= 1;
      if (profundidade === 0) return fonte.slice(abre, i + 1);
    }
  }
  return null;
}

async function principal() {
  console.log('autoaprovacao das acoes do agente');

  // -------------------------------------------------------------------------
  // 1. regra de escopo
  // -------------------------------------------------------------------------

  console.log('\n1. a regra de escopo');
  conferir('sem escolha, não aprova nada', autoValePara({ ligado: false, sessionId: null }, 's1') === false);
  conferir('ligada na conversa s1 vale em s1', autoValePara({ ligado: true, sessionId: 's1' }, 's1') === true);
  conferir('ligada na conversa s1 NÃO vale em s2', autoValePara({ ligado: true, sessionId: 's1' }, 's2') === false);
  conferir('ligada sem conversa vale na primeira que abrir', autoValePara({ ligado: true, sessionId: null }, 's9') === true);
  conferir('ligada sem conversa e sem sessão aberta ainda vale', autoValePara({ ligado: true, sessionId: null }, null) === true);
  conferir('registro torto não aprova', autoValePara({ ligado: 'sim', sessionId: 's1' }, 's1') === false);
  conferir('registro ausente não aprova', autoValePara(undefined, 's1') === false);

  // -------------------------------------------------------------------------
  // 2. o armazenamento
  // -------------------------------------------------------------------------

  console.log('\n2. o armazenamento (sessao do navegador)');
  const dados = instalarArmazenamentoFalso();
  const inicial = await lerAutoAprovar();
  conferir('sem nada guardado, começa desligada', inicial.ligado === false && inicial.sessionId === null);

  await salvarAutoAprovar({ ligado: true, sessionId: 's1' });
  const guardado = await lerAutoAprovar();
  conferir('ligar guarda a conversa', guardado.ligado === true && guardado.sessionId === 's1', JSON.stringify(guardado));
  conferir('ligar guarda o momento', Number.isFinite(guardado.desde) && guardado.desde > 0);
  conferir('a chave é a combinada', dados.has(CHAVE_AUTO_APROVAR), CHAVE_AUTO_APROVAR);

  await salvarAutoAprovar({ ligado: true, sessionId: '' });
  const semSessao = await lerAutoAprovar();
  conferir('ligar sem conversa guarda null, não string vazia', semSessao.ligado === true && semSessao.sessionId === null);

  await salvarAutoAprovar({ ligado: false });
  const desligado = await lerAutoAprovar();
  conferir('desligar apaga a chave', !dados.has(CHAVE_AUTO_APROVAR) && desligado.ligado === false);

  // Sem `chrome` nenhum (Node puro), ler não explode: é o caso do teste e de um
  // navegador antigo sem `storage.session`.
  delete globalThis.chrome;
  const semApi = await lerAutoAprovar();
  conferir('sem API de armazenamento, assume desligada', semApi.ligado === false);
  await salvarAutoAprovar({ ligado: true, sessionId: 's1' });
  conferir('sem API de armazenamento, gravar não explode', true);

  // -------------------------------------------------------------------------
  // 3. a fiação do painel
  // -------------------------------------------------------------------------

  console.log('\n3. a fiacao do painel');
  const html = ler('painel/painel.html');
  const painel = ler('painel/painel.js');
  const ferramentas = fs.readFileSync(path.join(RAIZ, 'plugin', 'ferramentas.js'), 'utf8');

  conferir('botao de autoaprovar no HTML', html.includes('id="btn-auto"'));
  conferir('faixa de aviso no HTML', html.includes('id="faixa-auto"'));
  conferir('botao de desligar na faixa', html.includes('id="btn-auto-desligar"'));

  const tratar = corpoDaFuncao(painel, 'tratarMensagemDePedido') ?? '';
  const desvio = tratar.indexOf('ui.autoAprovar');
  const cartao = tratar.indexOf('desenharPedido(');
  /*
   * A ordem é a garantia de segurança: se o cartão vier antes do desvio, o
   * usuário continua sendo perguntado mesmo com o modo ligado (e o teste pega).
   */
  conferir('o desvio vem ANTES do cartao de aprovacao', desvio >= 0 && cartao >= 0 && desvio < cartao, `desvio ${desvio}, cartao ${cartao}`);
  conferir('o desvio so vale para "agir"', /autoAprovar\s*&&\s*mensagem\.pedido\?\.tipo\s*===\s*'agir'/.test(tratar));

  const execucao = corpoDaFuncao(painel, 'executarPedido') ?? '';
  conferir('executarPedido marca a resposta da ponte', execucao.includes('aprovada: true'));
  conferir('executarPedido avisa o caminho automatico', execucao.includes('autoaprovada: true'));

  const carregar = corpoDaFuncao(painel, 'carregarAutoAprovar') ?? '';
  conferir('a leitura usa a regra de escopo', carregar.includes('autoValePara('));

  const abrir = corpoDaFuncao(painel, 'abrirSessao') ?? '';
  conferir('trocar de conversa reavalia o modo', abrir.includes('carregarAutoAprovar('));

  conferir('o cartao oferece "nao perguntar de novo"', painel.includes('não perguntar de novo nesta conversa'));
  conferir('o cartao liga o modo ao aprovar com a caixa marcada', /caixa\.checked[^\n]*aplicarAutoAprovar\(true\)/.test(painel));
  conferir('a autoaprovacao aparece no transcrito', painel.includes('autoaprovação ligada nesta conversa'));
  conferir('a ferramenta devolve autoaprovada', ferramentas.includes('autoaprovada'));
  conferir('a ferramenta nao narra aprovacao que nao houve', ferramentas.includes('sem cartao de aprovacao'));

  // -------------------------------------------------------------------------
  // 4. o selo no host (envelope, não dentro do valor)
  // -------------------------------------------------------------------------

  console.log('\n4. o selo do host');
  /*
   * A compatibilidade depende disto: painel novo + host antigo não pode injetar
   * `autoaprovada` no valor, porque o schema fechado do host antigo recusaria a
   * saída inteira. O selo viaja no envelope, e o host só o usa quando entende.
   */
  const selado = comSelo({ ok: true, valor: { resumo: 'cliquei em <a>', aba: { url: 'https://x' } }, autoaprovada: true });
  conferir('com selo, o valor sai marcado', selado.autoaprovada === true && selado.resumo === 'cliquei em <a>');
  const semSelo = comSelo({ ok: true, valor: { resumo: 'cliquei em <a>' } });
  conferir('sem selo, o valor sai intacto', semSelo.autoaprovada === undefined && semSelo.resumo === 'cliquei em <a>');
  const objeto = { resumo: 'cliquei em <a>' };
  const marcado = comSelo({ valor: objeto, autoaprovada: true });
  conferir('o selo copia em vez de mutar o valor do painel', marcado !== objeto && objeto.autoaprovada === undefined);
  conferir('valor que não é objeto passa igual', comSelo({ valor: 'texto puro', autoaprovada: true }) === 'texto puro');
  conferir('leitura nunca ganha o selo', comSelo({ valor: { resumo: 'li a aba' } }).autoaprovada === undefined);
  /*
   * O selo tem de ficar no ENVELOPE do `responder`, nunca dentro de `valor`. O
   * valor carrega a aba projetada (`{...resultado, aba: ...}`) e desde 04/11/2026
   * ele é montado numa variável (por causa do `texto` da cópia, que sai antes de
   * responder), então a conferência aceita as duas formas: `valor: {...}` inline
   * ou `valor,` por atalho. O que ela cobra é o selo DEPOIS de `aprovada: true`,
   * que é o lugar do envelope, e a ausência dele na construção do valor.
   */
  const chamadaDaPonte = execucao.slice(execucao.indexOf('ui.ponte.responder('));
  const comAtalho = /valor,[\s\S]{0,200}aprovada: true[\s\S]{0,160}autoaprovada: true/.test(chamadaDaPonte);
  const inline = /valor:\s*\{[^}]*\}[\s\S]{0,200}aprovada: true[\s\S]{0,160}autoaprovada: true/.test(chamadaDaPonte);
  const valorSemSelo = /const valor = \{[\s\S]{0,300}?\};/.exec(execucao)?.[0] ?? '';
  conferir(
    'o painel manda o selo no envelope, nao no valor',
    (comAtalho || inline) && valorSemSelo.includes('autoaprovada') === false,
    (comAtalho ? 'valor por atalho' : inline ? 'valor inline' : 'sem selo no envelope'),
  );

  console.log(`\n${placar.ok} ok, ${placar.falhou} falha(s)`);
  process.exit(placar.falhou === 0 ? 0 : 1);
}

await principal();
