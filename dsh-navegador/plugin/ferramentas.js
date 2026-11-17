/**
 * Ferramentas que o agente ganha para trabalhar na aba do navegador.
 *
 * Duas, e o corte entre elas é o que o Ramses pediu: ler sempre, agir só quando
 * ele pedir, com aprovação por ação. `navegador_ler` não pede aprovação porque a
 * aba lida é a que o painel já está mostrando; `navegador_agir` manda UM pedido
 * por chamada e o painel mostra o que vai ser feito antes de fazer.
 *
 * A exceção é a autoaprovação: o usuário pode ligar, no painel, "aprovar nesta
 * conversa". A partir daí as ações rodam sem cartão e voltam com
 * `autoaprovada: true`, para o modelo não narrar uma aprovação que não houve
 * (desenho e testes em `ferramentas/testar-autoaprovacao.mjs`; ver HANDOFF).
 *
 * @module dsh-navegador/plugin/ferramentas
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { copiarTextoHost } from './transferencia.js';

/** Limite de caracteres que o agente recebe de uma leitura de texto. */
const LIMITE_PADRAO = 20_000;
/** Teto duro do limite de texto. */
const LIMITE_MAXIMO = 200_000;

const ABA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Aba alvo do pedido, como o painel a via no momento.',
  properties: {
    url: { type: 'string', required: true },
    titulo: { type: 'string' },
    id: { type: 'integer' },
    // `ativa` e `fixada` respondem as duas perguntas que o agente nao tem como
    // fazer sozinho: a aba que ele usou e a da frente agora? e a mesma que o
    // painel esta mostrando?
    ativa: { type: 'boolean' },
    fixada: { type: 'boolean' },
    janela: { type: 'integer' },
  },
};

/**
 * Uma aba da listagem de `navegador_abas`.
 *
 * `janela` e o id da janela do Chrome (duas janelas podem ter a mesma aba ativa),
 * e `fixada` diz qual delas o painel esta mostrando.
 */
const ABA_LISTADA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true },
    titulo: { type: 'string' },
    url: { type: 'string', required: true },
    ativa: { type: 'boolean' },
    fixada: { type: 'boolean' },
    janela: { type: 'integer' },
  },
};

const SAIDA_ABAS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resumo: { type: 'string', required: true },
    abas: { type: 'array', required: true, items: ABA_LISTADA },
    fixada: { type: 'integer' },
  },
};

/**
 * Imagem de uma captura, no formato que o DSH aceita como bloco de conteudo.
 *
 * E o mesmo `IMAGE_VALUE_SCHEMA` do `read_image` do proprio DSH: `bytes`,
 * `width` e `height` vem do armazenamento de anexos, e `attachmentId` e o que o
 * render transforma em bloco de imagem.
 */
const IMAGEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
};

const SAIDA_PRINT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resumo: { type: 'string', required: true },
    arquivo: { type: 'string', required: true },
    bytes: { type: 'integer' },
    inteira: { type: 'boolean' },
    aba: ABA_SCHEMA,
    imagem: IMAGEM_SCHEMA,
  },
};

/**
 * Um quadro (iframe) de uma leitura.
 *
 * O `id` é o que o agente devolve no parâmetro `quadro` de `navegador_agir` quando
 * quer apontar o iframe em vez de deixar o add-on escolher.
 */
const QUADRO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    url: { type: 'string', required: true },
    principal: { type: 'boolean' },
  },
};

const SAIDA_LEITURA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    o_que: { type: 'string', required: true },
    resumo: { type: 'string', required: true },
    aba: ABA_SCHEMA,
    texto: { type: 'string' },
    // O trecho que o usuario selecionou. Fica aqui porque o schema e fechado
    // (`additionalProperties: false`): campo que nao esta declarado e descartado
    // antes do render, e o `o_que: 'selecao'` voltava vazio sem ninguem ver.
    selecao: { type: 'string' },
    itens: { type: 'array', items: { type: 'string' } },
    // Quadros lidos (principal e iframes). Vazio/omitido quando a leitura veio de
    // uma extensao antiga que ainda nao le iframe.
    quadros: { type: 'array', items: QUADRO_SCHEMA },
    // Areas rolaveis do que foi lido, para o agente saber quem rola antes de
    // mandar `rolar` (a janela do Slack nao rola: a lista de mensagens rola).
    rolagem: { type: 'array', items: { type: 'string' } },
    truncado: { type: 'boolean' },
  },
};

const SAIDA_ACAO = {
  type: 'object',
  additionalProperties: false,
  properties: {
    acao: { type: 'string', required: true },
    resumo: { type: 'string', required: true },
    aba: ABA_SCHEMA,
    // Id do quadro (iframe) em que a acao rodou, quando ela saiu do principal.
    quadro: { type: 'string' },
    aprovada: { type: 'boolean' },
    // `true` quando o painel estava com a autoaprovacao ligada: a acao rodou sem
    // cartao e o modelo nao pode dizer ao usuario que ele aprovou naquele momento.
    autoaprovada: { type: 'boolean' },
    // `true` quando a aprovacao nao veio a tempo: a acao continua pendente no
    // painel e o resultado NAO existe ainda. O `pedido` e o identificador dela.
    pendente: { type: 'boolean' },
    pedido: { type: 'string' },
    expira_em: { type: 'string' },
    // Resultado da acao "copiar": gravou na area de transferencia.
    copiado: { type: 'boolean' },
    metodo: { type: 'string' },
    conferido: { type: 'boolean' },
    bytes: { type: 'integer' },
  },
};

/**
 * Saida da ferramenta `navegador_copiar`.
 *
 * `metodo` diz por qual caminho a copia passou (API do clipboard no painel,
 * `execCommand`, ou a area de transferencia do sistema pelo host), e `conferido`
 * diz se deu para reler e comparar: `false` nao e falha, e sim "copiei sem poder
 * conferir".
 */
const SAIDA_COPIAR = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resumo: { type: 'string', required: true },
    copiado: { type: 'boolean', required: true },
    metodo: { type: 'string' },
    conferido: { type: 'boolean' },
    bytes: { type: 'integer' },
  },
};

/*
 * Saida da leitura de cookies: SO metadados.
 *
 * O valor dos cookies nunca entra aqui, de proposito. Devolver o cabecalho ao
 * modelo colocaria a credencial de sessao no transcrito da conversa, que e
 * exatamente o que a gravacao em arquivo evita.
 */
const SAIDA_COOKIES = {
  type: 'object',
  additionalProperties: false,
  properties: {
    host: { type: 'string', required: true },
    total: { type: 'integer', required: true },
    arquivo: { type: 'string', required: true },
    meta: { type: 'string' },
    expira_em: { type: 'string' },
    http_only: { type: 'integer' },
    csrf: { type: 'boolean' },
    token: { type: 'boolean' },
  },
};

function descreverAba(aba) {
  if (aba === undefined || aba === null) return 'aba desconhecida';
  const titulo = typeof aba.titulo === 'string' && aba.titulo !== '' ? aba.titulo : '(sem titulo)';
  const marcas = [];
  if (aba.ativa === true) marcas.push('aba ativa');
  if (aba.fixada === true) marcas.push('fixada no painel');
  return `${titulo} (${aba.url})${marcas.length === 0 ? '' : ` [${marcas.join(', ')}]`}`;
}

/**
 * Reduz a aba ao formato declarado em `ABA_SCHEMA`.
 *
 * O schema de saída é fechado (`additionalProperties: false`) e a ponte guarda a
 * aba com `janelaId` e `atualizadoEm` (ver `definirAba` em `ponte.js`). Sem esta
 * projeção o DSH **recusa a saída da ferramenta inteira**:
 *
 *   tool "navegador_ler" returned invalid output:
 *   "value.aba.janelaId" is not a declared property
 *
 * Medido em 17/10/2026, quando o teste de `o_que: 'selecao'` chegou nesse caminho.
 * @param aba - objeto da aba, de qualquer origem.
 * @returns `{ url, titulo?, id?, ativa?, fixada?, janela? }`, ou `undefined` se
 *   não houver aba utilizável.
 */
function projetarAba(aba) {
  if (aba === undefined || aba === null || typeof aba !== 'object') return undefined;
  if (typeof aba.url !== 'string' || aba.url === '') return undefined;
  const projetada = { url: aba.url };
  if (typeof aba.titulo === 'string' && aba.titulo !== '') projetada.titulo = aba.titulo;
  if (Number.isSafeInteger(aba.id)) projetada.id = aba.id;
  if (typeof aba.ativa === 'boolean') projetada.ativa = aba.ativa;
  if (typeof aba.fixada === 'boolean') projetada.fixada = aba.fixada;
  const janela = Number.isSafeInteger(aba.janela) ? aba.janela : Number.isSafeInteger(aba.janelaId) ? aba.janelaId : null;
  if (janela !== null) projetada.janela = janela;
  return projetada;
}

/**
 * Aba do resultado: a que o painel informou, ou a última que ele anunciou.
 *
 * O painel responde com a aba quando sabe; quando não responde, a ponte ainda
 * tem a última aba anunciada, e usá-la evita um "aba desconhecida" que faria o
 * modelo perder o alvo de vista.
 */
function abaDoResultado(ponte, resultado) {
  if (resultado?.aba !== undefined && resultado.aba !== null) return projetarAba(resultado.aba);
  return projetarAba(ponte?.abaAtual?.());
}

/**
 * Lê o parâmetro `aba` de uma ferramenta.
 *
 * O valor pode ser id (número ou texto de dígitos) ou trecho de título/URL. Quem
 * decide é o painel, que enxerga a lista de abas: aqui o valor só é normalizado.
 * @param args - argumentos da ferramenta.
 * @returns o alvo em texto, ou `undefined` quando não veio.
 */
function alvoDaAba(args) {
  if (args === null || args === undefined) return undefined;
  const bruto = args.aba;
  if (typeof bruto === 'number' && Number.isSafeInteger(bruto)) return String(bruto);
  if (typeof bruto === 'string' && bruto.trim() !== '') return bruto.trim();
  return undefined;
}

/**
 * Lê o parâmetro `quadro` (iframe) de uma ferramenta.
 *
 * O valor é o `id` que veio na lista `quadros` de uma leitura anterior. Serve
 * para o agente apontar o iframe quando a página tem mais de um candidato; sem
 * ele o add-on escolhe pelo seletor e prefere o quadro principal.
 * @param args - argumentos da ferramenta.
 * @returns o id em texto, ou `undefined` quando não veio.
 */
function quadroDoPedido(args) {
  if (args === null || args === undefined) return undefined;
  const bruto = args.quadro;
  if (typeof bruto === 'string' && bruto.trim() !== '') return bruto.trim();
  return undefined;
}

/**
 * Caminho do PNG de uma captura.
 *
 * Fica em `~/.dsh-navegador/prints` para o agente poder reler o arquivo depois com
 * `read_image`, e para o print sobreviver ao fim da conversa.
 * @returns caminho absoluto, com carimbo de tempo e pid no nome.
 */
function caminhoDoPrint() {
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(homedir(), '.dsh-navegador', 'prints', `print-${carimbo}-${process.pid}.png`);
}

/**
 * Guarda a captura como anexo durável do DSH, para virar bloco de imagem.
 *
 * O bloco de imagem de uma ferramenta não aceita base64: ele aponta para um
 * anexo (`attachmentId`). Quem grava é o serviço `attachments` do DSH, o mesmo
 * que o `read_image` usa. Ele pode não estar montado (host sem esse serviço);
 * nesse caso a ferramenta continua funcionando e devolve só o arquivo, porque a
 * imagem embutida é conveniência e o arquivo é a entrega.
 * @param ctx - contexto do host.
 * @param base64 - PNG em base64, sem o prefixo do data URL.
 * @returns o objeto de imagem do schema, ou `undefined` quando não deu.
 */
async function imagemParaAnexo(ctx, base64) {
  let anexos;
  try {
    anexos = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined;
  } catch {
    return undefined;
  }
  if (anexos === undefined || anexos === null || typeof anexos.saveImages !== 'function') return undefined;
  try {
    const salvas = await anexos.saveImages([{ data: base64, mediaType: 'image/png', name: 'print-da-aba.png' }]);
    const ref = Array.isArray(salvas) ? salvas[0] : undefined;
    if (ref === undefined || ref === null || typeof ref.attachmentId !== 'string') return undefined;
    return {
      attachmentId: ref.attachmentId,
      mediaType: 'image/png',
      bytes: Number(ref.bytes) || 0,
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
      name: 'print-da-aba.png',
    };
  } catch {
    return undefined;
  }
}

/**
 * Registra as duas ferramentas no registro de ferramentas do host.
 *
 * @param ctx - contexto do host (precisa de `tools`).
 * @param ponte - a ponte, para falar com o painel.
 */
export function registrarFerramentas(ctx, ponte) {
  ctx.tools.register(
    defineTool({
      name: 'navegador_ler',
      description:
        'Le uma aba do navegador do usuario (Chrome/Chromium/Opera) na maquina dele. Sem o parametro "aba", le a aba fixada no painel do add-on; com ele, le a aba indicada por id ou por trecho do titulo/url (veja navegador_abas). A leitura vale tambem para o conteudo dentro de iframes (o simulador de chatbot do Droz roda o chat num iframe): a resposta lista os quadros em "quadros" e junta o texto de todos. Escolha o_que: "aba" devolve so a identificacao da aba; "texto" devolve o conteudo do documento; "selecao" devolve o trecho que o usuario selecionou; "elementos" lista os elementos acionaveis visiveis e numera cada um com um seletor pronto para navegador_agir; "rolagem" diz quais areas da pagina realmente rolam (a janela ou um container interno, como a lista de mensagens do Slack). Quando o conteudo nao aparece no texto (canvas, aplicativo web), use navegador_print. Precisa do painel do add-on aberto.',
      parameters: {
        o_que: {
          type: 'string',
          required: true,
          enum: ['aba', 'texto', 'selecao', 'elementos', 'rolagem'],
          description: 'O que ler na aba.',
        },
        aba: {
          type: 'string',
          description:
            'Aba alvo: id em numero (ex: "1843") ou trecho do titulo ou da url (ex: "miro"). Padrao: a aba fixada no painel.',
        },
        seletor: {
          type: 'string',
          description: 'Seletor CSS, usado apenas com o_que="elementos". Exemplo: "button, a[href]".',
        },
        limite: {
          type: 'integer',
          description: `Maximo de caracteres devolvidos no texto. Padrao ${LIMITE_PADRAO}, teto ${LIMITE_MAXIMO}.`,
        },
      },
      output: {
        schema: SAIDA_LEITURA,
        render: (_args, valor) => [{ type: 'text', text: textoDaLeitura(valor) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const oQue = String(args.o_que ?? '');
        const limite = Math.min(Math.max(Number(args.limite ?? LIMITE_PADRAO) || LIMITE_PADRAO, 200), LIMITE_MAXIMO);
        const alvo = alvoDaAba(args);
        const resultado = await ponte.pedir(
          {
            tipo: 'ler',
            oQue,
            seletor: typeof args.seletor === 'string' ? args.seletor : undefined,
            limite,
            ...(alvo === undefined ? {} : { alvo }),
          },
          exec.signal,
        );
        if (typeof resultado !== 'object' || resultado === null) throw new Error('o painel devolveu uma leitura invalida');
        const aba = abaDoResultado(ponte, resultado);
        const quadros = Array.isArray(resultado.quadros)
          ? resultado.quadros
              .filter((quadro) => quadro !== null && typeof quadro === 'object' && typeof quadro.url === 'string')
              .map((quadro) => ({
                url: quadro.url,
                ...(typeof quadro.id === 'string' && quadro.id !== '' ? { id: quadro.id } : {}),
                principal: quadro.principal === true,
              }))
          : [];
        return {
          o_que: oQue,
          resumo: typeof resultado.resumo === 'string' ? resultado.resumo : 'leitura concluida',
          ...(aba === undefined ? {} : { aba }),
          ...(typeof resultado.texto === 'string' ? { texto: resultado.texto } : {}),
          ...(typeof resultado.selecao === 'string' && resultado.selecao !== '' ? { selecao: resultado.selecao } : {}),
          ...(Array.isArray(resultado.itens) ? { itens: resultado.itens.map(String) } : {}),
          ...(quadros.length > 0 ? { quadros } : {}),
          ...(Array.isArray(resultado.rolagem) ? { rolagem: resultado.rolagem.map(String) } : {}),
          ...(resultado.truncado === true ? { truncado: true } : {}),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'navegador_agir',
      description:
        'Pede UMA acao numa aba do navegador do usuario. Sem o parametro "aba", age na aba fixada no painel; com ele, na aba indicada por id ou trecho do titulo/url. O usuario ve o pedido no painel e aprova ou recusa antes de qualquer coisa acontecer, entao a acao pode voltar recusada: nesse caso pare e pergunte a ele o que fazer. Se ele tiver ligado a autoaprovacao no painel ("Aprovar nesta conversa"), a acao roda direto e volta com autoaprovada: true: nesse caso siga em frente sem pedir confirmacao, mas nao diga que ele aprovou aquela acao. Se ninguem aprovar em alguns segundos, a resposta volta com pendente: true e um identificador: NAO repita a acao, avise o usuario que ela espera aprovacao no painel. Uma acao por chamada, e sempre leia a aba antes (navegador_ler) para saber em que elemento esta agindo. Acoes: "clicar" (seletor), "digitar" (seletor + texto; "modo": "teclas" digita caractere por caractere, o que faz autocomplete e mascara reagirem), "teclar" (tecla), "rolar" (direcao, pixels; rola o container certo, inclusive a lista interna do Slack, e quando o seletor vem junto rola o container daquele elemento), "navegar" (url; com nova_aba: true abre outra aba e fixa o painel nela), "copiar" (copia para a area de transferencia o texto da selecao do usuario, ou o texto do seletor), "voltar", "avancar", "recarregar", "esperar" (segundos). Em pagina com iframe, passe "quadro" com o id que veio em "quadros" na leitura; sem ele o add-on escolhe pelo seletor e prefere o quadro principal.',
      parameters: {
        acao: {
          type: 'string',
          required: true,
          enum: ['clicar', 'digitar', 'teclar', 'rolar', 'navegar', 'voltar', 'avancar', 'recarregar', 'esperar', 'copiar'],
          description: 'A acao a executar na aba.',
        },
        aba: {
          type: 'string',
          description:
            'Aba alvo: id em numero (ex: "1843") ou trecho do titulo ou da url (ex: "miro"). Padrao: a aba fixada no painel.',
        },
        quadro: {
          type: 'string',
          description:
            'Quadro (iframe) alvo: o id que veio em "quadros" na leitura. Padrao: escolhido pelo seletor, com preferencia pelo quadro principal.',
        },
        seletor: { type: 'string', description: 'Seletor CSS do elemento, obrigatorio em "clicar" e "digitar".' },
        texto: { type: 'string', description: 'Texto a digitar, obrigatorio em "digitar".' },
        modo: {
          type: 'string',
          enum: ['eventos', 'teclas'],
          description:
            'So com "digitar": "eventos" (padrao) escreve de uma vez disparando os eventos nativos; "teclas" digita caractere por caractere.',
        },
        tecla: { type: 'string', description: 'Tecla ou combinacao, para "teclar". Exemplos: "Enter", "Escape", "Control+a".' },
        direcao: { type: 'string', enum: ['cima', 'baixo'], description: 'Direcao da rolagem, para "rolar".' },
        pixels: { type: 'integer', description: 'Quantos pixels rolar, para "rolar". Padrao 600.' },
        url: { type: 'string', description: 'Endereco de destino, obrigatorio em "navegar".' },
        nova_aba: {
          type: 'boolean',
          description: 'Só com "navegar": abre o endereco numa aba nova e passa a fixar o painel nela.',
        },
        segundos: { type: 'number', description: 'Quanto esperar, para "esperar". Padrao 2, teto 60.' },
      },
      output: {
        schema: SAIDA_ACAO,
        render: (_args, valor) => [{ type: 'text', text: textoDaAcao(valor) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const acao = String(args.acao ?? '');
        const pedido = { tipo: 'agir', acao };
        const alvo = alvoDaAba(args);
        if (alvo !== undefined) pedido.alvo = alvo;
        const quadro = quadroDoPedido(args);
        if (quadro !== undefined) pedido.quadro = quadro;
        if (typeof args.seletor === 'string') pedido.seletor = args.seletor;
        if (typeof args.texto === 'string') pedido.texto = args.texto;
        if (typeof args.modo === 'string' && args.modo !== '') pedido.modo = args.modo;
        if (typeof args.tecla === 'string') pedido.tecla = args.tecla;
        if (typeof args.direcao === 'string') pedido.direcao = args.direcao;
        if (args.pixels !== undefined) pedido.pixels = Number(args.pixels);
        if (typeof args.url === 'string') pedido.url = args.url;
        if (args.nova_aba === true) pedido.novaAba = true;
        if (args.segundos !== undefined) pedido.segundos = Number(args.segundos);

        let resultado;
        try {
          resultado = await ponte.pedir(pedido, exec.signal);
        } catch (erro) {
          const motivo = erro instanceof Error ? erro.message : String(erro);
          throw new Error(`a acao "${acao}" nao foi executada: ${motivo}`);
        }
        if (typeof resultado !== 'object' || resultado === null) throw new Error('o painel devolveu uma resposta invalida');
        const aba = abaDoResultado(ponte, resultado);
        /*
         * Sem aprovacao a tempo, a acao NAO falhou: ela esta na tela esperando o
         * usuario. Repetir a chamada criaria um segundo cartao para a mesma
         * coisa, e narrar "nao foi executada" seria falso.
         */
        if (resultado.pendente === true) {
          return {
            acao,
            resumo: 'sem resposta do painel em 12s: pode estar esperando aprovacao ou ja executando',
            pendente: true,
            ...(typeof resultado.id === 'string' ? { pedido: resultado.id } : {}),
            ...(typeof resultado.expiraEm === 'string' ? { expira_em: resultado.expiraEm } : {}),
            ...(aba === undefined ? {} : { aba }),
          };
        }
        return {
          acao,
          resumo: typeof resultado.resumo === 'string' ? resultado.resumo : `acao ${acao} executada`,
          ...(aba === undefined ? {} : { aba }),
          ...(typeof resultado.quadro?.id === 'string' && resultado.quadro.id !== '' ? { quadro: resultado.quadro.id } : {}),
          ...(resultado.aprovada === true ? { aprovada: true } : {}),
          ...(resultado.autoaprovada === true ? { autoaprovada: true } : {}),
          ...(resultado.copiado === true ? { copiado: true } : {}),
          ...(typeof resultado.metodo === 'string' && resultado.metodo !== '' ? { metodo: resultado.metodo } : {}),
          ...(typeof resultado.conferido === 'boolean' ? { conferido: resultado.conferido } : {}),
          ...(Number.isFinite(resultado.bytes) ? { bytes: resultado.bytes } : {}),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'navegador_abas',
      description:
        'Lista as abas abertas no navegador do usuario (Chrome/Chromium/Opera) com id, titulo, url, qual esta ativa, em qual janela e qual delas o painel esta fixando. Use antes de navegador_ler ou navegador_agir com o parametro "aba", para escolher a aba certa em vez de chutar um trecho de titulo. Precisa do painel do add-on aberto.',
      parameters: {},
      output: {
        schema: SAIDA_ABAS,
        render: (_args, valor) => [{ type: 'text', text: textoDasAbas(valor) }],
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const resultado = await ponte.pedir({ tipo: 'abas' }, exec.signal);
        if (typeof resultado !== 'object' || resultado === null) throw new Error('o painel devolveu uma lista invalida');
        const abas = Array.isArray(resultado.abas) ? resultado.abas : [];
        const fixada = Number.isSafeInteger(resultado.fixada) ? resultado.fixada : undefined;
        return {
          resumo: typeof resultado.resumo === 'string' ? resultado.resumo : `${abas.length} aba(s) aberta(s)`,
          abas: abas
            .filter((aba) => Number.isSafeInteger(aba?.id) && typeof aba?.url === 'string')
            .map((aba) => ({
              id: aba.id,
              url: aba.url,
              ...(typeof aba.titulo === 'string' && aba.titulo !== '' ? { titulo: aba.titulo } : {}),
              ativa: aba.ativa === true,
              fixada: aba.fixada === true,
              ...(Number.isSafeInteger(aba.janela) ? { janela: aba.janela } : {}),
            })),
          ...(fixada === undefined ? {} : { fixada }),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'navegador_print',
      description:
        'Tira uma imagem PNG de uma aba do navegador do usuario e devolve a imagem na conversa (alem de gravar o arquivo). E o caminho quando o texto nao resolve: canvas (Miro, Figma, mapa), aplicativo web que desenha a tela, ou conferir como um chat esta aparecendo. Sem o parametro "aba", captura a aba fixada no painel; com ele, a aba indicada por id ou trecho do titulo/url. inteira: true costura a pagina toda, nao so a area visivel. A captura traz a aba para a frente, porque a API do Chrome so pega a aba ativa. Precisa do painel do add-on aberto.',
      parameters: {
        aba: {
          type: 'string',
          description:
            'Aba alvo: id em numero (ex: "1843") ou trecho do titulo ou da url (ex: "miro"). Padrao: a aba fixada no painel.',
        },
        inteira: {
          type: 'boolean',
          description: 'Pega a pagina inteira (rola e costura) em vez de so a area visivel. Padrao false.',
        },
      },
      output: {
        schema: SAIDA_PRINT,
        render: (_args, valor) => {
          const blocos = [{ type: 'text', text: textoDoPrint(valor) }];
          const imagem = valor.imagem;
          if (imagem !== undefined && imagem !== null && typeof imagem.attachmentId === 'string') {
            blocos.push({
              type: 'image',
              attachment: {
                attachmentId: imagem.attachmentId,
                mediaType: imagem.mediaType,
                bytes: imagem.bytes,
                width: imagem.width,
                height: imagem.height,
                ...(typeof imagem.name === 'string' ? { name: imagem.name } : {}),
              },
            });
          }
          return blocos;
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const alvo = alvoDaAba(args);
        let resultado;
        try {
          resultado = await ponte.pedir(
            {
              tipo: 'print',
              ...(alvo === undefined ? {} : { alvo }),
              ...(args.inteira === true ? { inteira: true } : {}),
            },
            exec.signal,
          );
        } catch (erro) {
          const motivo = erro instanceof Error ? erro.message : String(erro);
          throw new Error(`nao consegui capturar a aba: ${motivo}`);
        }
        const dataUrl = typeof resultado?.dataUrl === 'string' ? resultado.dataUrl : '';
        if (dataUrl.startsWith('data:image/') === false) throw new Error('o navegador nao devolveu imagem na captura');
        const corte = dataUrl.indexOf(',');
        const base64 = dataUrl.slice(corte + 1);
        const bytes = Buffer.from(base64, 'base64');
        /*
         * O arquivo é gravado SEMPRE: é o que sobrevive ao fim da conversa e o
         * que o `read_image` consegue reler depois. A imagem embutida é o
         * caminho rápido, e ela depende do serviço de anexos do DSH existir.
         */
        const arquivo = caminhoDoPrint();
        mkdirSync(path.dirname(arquivo), { recursive: true });
        writeFileSync(arquivo, bytes);
        const imagem = await imagemParaAnexo(ctx, base64);
        const aba = abaDoResultado(ponte, resultado);
        const inteira = resultado?.inteira === true;
        return {
          resumo: `print ${inteira ? 'da pagina inteira' : 'da area visivel'} (${bytes.byteLength} bytes)`,
          arquivo,
          bytes: bytes.byteLength,
          inteira,
          ...(aba === undefined ? {} : { aba }),
          ...(imagem === undefined ? {} : { imagem }),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'navegador_copiar',
      description:
        'Copia um texto para a area de transferencia da maquina do usuario. Use quando precisar colar algo em outro programa, ou quando ele pedir "copia isso" (token, trecho de ticket, resposta). Nao depende de gesto do usuario: tenta a API do clipboard no painel do add-on e, se o navegador recusar, grava pela area de transferencia do sistema no host. Requer o texto ja lido (use navegador_ler ou navegador_agir acao "copiar" quando a origem e a propria pagina).',
      parameters: {
        texto: {
          type: 'string',
          required: true,
          description: 'Texto exato a copiar. Respeita acentos e quebras de linha.',
        },
      },
      output: {
        schema: SAIDA_COPIAR,
        render: (_args, valor) => [{ type: 'text', text: textoDaCopia(valor) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const texto = String(args.texto ?? '');
        if (texto === '') throw new Error('navegador_copiar precisa do texto a copiar');
        let falhaPainel = '';
        try {
          const resultado = await ponte.pedir({ tipo: 'copiar', texto }, exec.signal);
          if (resultado?.copiado === true) {
            return {
              resumo: typeof resultado.resumo === 'string' ? resultado.resumo : `copiei ${texto.length} caractere(s)`,
              copiado: true,
              ...(typeof resultado.metodo === 'string' ? { metodo: resultado.metodo } : {}),
              ...(typeof resultado.conferido === 'boolean' ? { conferido: resultado.conferido } : {}),
              bytes: texto.length,
            };
          }
          falhaPainel = 'o painel respondeu sem confirmar a copia';
        } catch (erro) {
          falhaPainel = erro instanceof Error ? erro.message : String(erro);
        }
        /*
         * Último recurso: a área de transferência do sistema, escrita pelo host.
         * É o caminho que funciona mesmo com o painel fechado, e cobre o caso do
         * clique sintético não valer como ativação de usuário.
         */
        const host = await copiarTextoHost(texto);
        if (host.ok !== true) {
          throw new Error(`nao consegui copiar: painel (${falhaPainel || 'sem resposta'}); host (${host.erro ?? 'falhou'})`);
        }
        return {
          resumo: `copiei ${texto.length} caractere(s) pela area de transferencia do sistema`,
          copiado: true,
          metodo: host.metodo,
          conferido: false,
          bytes: texto.length,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'navegador_cookies',
      description:
        'Le os cookies de sessao do navegador do usuario para um host permitido e grava o cabecalho Cookie num arquivo local. Use quando precisar renovar uma sessao (Zendesk, Slack, Recurly) sem pedir ao usuario para copiar cookie a mao. Nao devolve o valor dos cookies: devolve contagem, caminho do arquivo e a validade mais curta. Dominios permitidos: zendesk.com, slack.com e recurly.com, e os subhosts de cada um. Para cookie gravado no dominio pai (o `d` do Slack em `.slack.com`), passe o dominio base (ex: "slack.com"), nao o subhost.',
      parameters: {
        host: {
          type: 'string',
          description: 'Dominio alvo. Padrao "neilpatel.zendesk.com".',
        },
        arquivo: {
          type: 'string',
          description:
            'Caminho de destino. Padrao: <home>\\.zendesk\\session.txt para host zendesk.com, senao <home>\\.dsh-sessions\\<host>.txt',
        },
      },
      output: {
        schema: SAIDA_COOKIES,
        render: (_args, valor) => [{ type: 'text', text: textoDosCookies(valor) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const host = String(args.host ?? 'neilpatel.zendesk.com').trim();
        let resultado;
        try {
          resultado = await ponte.pedir({ tipo: 'cookies', host }, exec.signal);
        } catch (erro) {
          const motivo = erro instanceof Error ? erro.message : String(erro);
          throw new Error(`nao consegui ler os cookies de ${host}: ${motivo}`);
        }
        const cookies = Array.isArray(resultado?.cookies) ? resultado.cookies : [];
        if (cookies.length === 0) {
          throw new Error(
            `o navegador nao devolveu cookie nenhum para ${host}. A sessao existe nessa janela do Chrome?`,
          );
        }

        const padraoArquivo =
          host.endsWith('zendesk.com')
            ? path.join(homedir(), '.zendesk', 'session.txt')
            : path.join(homedir(), '.dsh-sessions', `${host}.txt`);
        const destino =
          typeof args.arquivo === 'string' && args.arquivo.trim() !== ''
            ? args.arquivo.trim()
            : padraoArquivo;
        const cabecalho = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

        mkdirSync(path.dirname(destino), { recursive: true });
        writeFileSync(destino, `${cabecalho}\n`, { encoding: 'utf8', mode: 0o600 });

        const meta = path.join(path.dirname(destino), 'session-meta.json');
        const capturadoEm = new Date().toISOString();
        writeFileSync(
          meta,
          `${JSON.stringify(
            {
              host,
              total: cookies.length,
              capturado_em: capturadoEm,
              origem: 'add-on navegador',
            },
            null,
            2,
          )}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );

        /*
         * O token anti-CSRF vai para arquivo irmão. Sem ele o Zendesk recusa
         * escrita com cookie (`403 invalid_authenticity_token`); com ele, a nota
         * interna passa. Também não volta para a conversa, pelo mesmo motivo dos
         * cookies: credencial não entra no transcrito.
         */
        const csrf = typeof resultado?.csrf === 'string' ? resultado.csrf.trim() : '';
        const csrfArquivo = path.join(path.dirname(destino), 'csrf.txt');
        if (csrf !== '') {
          writeFileSync(csrfArquivo, `${csrf}\n`, { encoding: 'utf8', mode: 0o600 });
        }

        /*
         * Token do cliente web do Slack (`xoxc-`) para arquivo irmão. Ele não é
         * cookie e só vale junto com o cookie `d`, então guardar os dois lado a
         * lado é o que permite montar a chamada depois. Também não volta para a
         * conversa.
         */
        const tokenSlack = typeof resultado?.token === 'string' ? resultado.token.trim() : '';
        const tokenArquivo = path.join(path.dirname(destino), 'slack-token.txt');
        if (tokenSlack !== '') {
          writeFileSync(tokenArquivo, `${tokenSlack}\n`, { encoding: 'utf8', mode: 0o600 });
        }

        /*
         * Diagnóstico sem segredo: quando o token não aparece, os nomes das chaves
         * do armazenamento dizem onde procurar na próxima tentativa.
         */
        if (tokenSlack === '' && Array.isArray(resultado?.chaves) && resultado.chaves.length > 0) {
          writeFileSync(
            path.join(path.dirname(destino), 'slack-chaves.json'),
            `${JSON.stringify({ onde: resultado?.token_onde ?? '', chaves: resultado.chaves }, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
        }

        const httpOnly = cookies.filter((c) => c.httpOnly === true).length;
        return {
          host,
          total: cookies.length,
          arquivo: destino,
          meta,
          ...(expiracaoMaisCedo(cookies) === undefined ? {} : { expira_em: expiracaoMaisCedo(cookies) }),
          ...(httpOnly > 0 ? { http_only: httpOnly } : {}),
          ...(csrf !== '' ? { csrf: true } : {}),
          ...(tokenSlack !== '' ? { token: true } : {}),
        };
      },
    }),
  );
}

/** Monta o texto que o modelo lê numa leitura. */
function textoDaLeitura(valor) {
  const linhas = [`Leitura da aba: ${valor.o_que}.`];
  if (valor.aba !== undefined) linhas.push(`Aba: ${descreverAba(valor.aba)}`);
  if (Array.isArray(valor.quadros) && valor.quadros.length > 1) {
    linhas.push('', `Quadros lidos (${valor.quadros.length}):`);
    valor.quadros.forEach((quadro) => {
      linhas.push(
        `- quadro ${quadro.id === undefined ? '?' : quadro.id}${quadro.principal === true ? ' (principal)' : ''}: ${quadro.url}`,
      );
    });
  }
  if (typeof valor.selecao === 'string' && valor.selecao !== '') linhas.push('', 'Selecao do usuario:', valor.selecao);
  if (typeof valor.texto === 'string' && valor.texto !== '') {
    linhas.push('', valor.truncado === true ? 'Conteudo (truncado):' : 'Conteudo:', valor.texto);
  }
  if (Array.isArray(valor.itens) && valor.itens.length > 0) {
    linhas.push('', 'Elementos encontrados:');
    for (const item of valor.itens) linhas.push(`- ${item}`);
  }
  if (Array.isArray(valor.rolagem) && valor.rolagem.length > 0) {
    linhas.push('', 'Areas rolaveis:');
    for (const linha of valor.rolagem) linhas.push(`- ${linha}`);
  }
  if (linhas.length === 1) linhas.push(valor.resumo);
  return linhas.join('\n');
}

/** Monta o texto que o modelo lê numa ação. */
function textoDaAcao(valor) {
  const linhas = [`Acao "${valor.acao}" na aba do navegador.`];
  if (valor.pendente === true) {
    linhas.push('Resultado: o painel nao respondeu em 12s. A acao pode estar esperando aprovacao no painel OU ja estar executando.');
    if (typeof valor.pedido === 'string' && valor.pedido !== '') linhas.push(`Identificador do pedido: ${valor.pedido}`);
    if (typeof valor.expira_em === 'string' && valor.expira_em !== '') {
      linhas.push(`O pedido expira em ${valor.expira_em} se ninguem aprovar.`);
    }
    linhas.push(
      'Antes de repetir, leia a aba (navegador_ler) para ver se o efeito ja aconteceu: repetir as cegas duplica clique e digitacao.',
    );
  } else {
    linhas.push(`Resultado: ${valor.resumo}`);
  }
  if (valor.aba !== undefined) linhas.push(`Aba: ${descreverAba(valor.aba)}`);
  if (typeof valor.quadro === 'string' && valor.quadro !== '') linhas.push(`Quadro: ${valor.quadro}`);
  if (valor.copiado === true) {
    linhas.push(
      `Area de transferencia: copiado${typeof valor.metodo === 'string' ? ` (${valor.metodo})` : ''}${
        valor.conferido === true ? ', conferido pela releitura' : valor.conferido === false ? ', sem conferencia' : ''
      }.`,
    );
  } else if (valor.autoaprovada === true) {
    linhas.push('O painel esta com a autoaprovacao ligada nesta conversa: a acao rodou sem cartao de aprovacao.');
  } else if (valor.aprovada === true) {
    linhas.push('O usuario aprovou esta acao no painel.');
  }
  return linhas.join('\n');
}

/** Monta o texto que o modelo lê depois de copiar um texto. */
function textoDaCopia(valor) {
  const linhas = [`Copia para a area de transferencia: ${valor.copiado === true ? 'feita' : 'nao confirmada'}.`];
  if (typeof valor.bytes === 'number' && valor.bytes > 0) linhas.push(`${valor.bytes} caractere(s).`);
  if (typeof valor.metodo === 'string' && valor.metodo !== '') linhas.push(`Caminho: ${valor.metodo}.`);
  if (valor.conferido === true) linhas.push('Conferida pela releitura da area de transferencia.');
  else if (valor.conferido === false) linhas.push('A copia foi feita sem conferencia: reler a area de transferencia nao deu.');
  return linhas.join('\n');
}

/** Monta o texto que o modelo lê na lista de abas. */
function textoDasAbas(valor) {
  const linhas = [`Abas abertas no navegador (${valor.abas.length}):`];
  for (const aba of valor.abas) {
    const marcas = [];
    if (aba.ativa === true) marcas.push('ativa');
    if (aba.fixada === true) marcas.push('fixada no painel');
    if (Number.isSafeInteger(aba.janela)) marcas.push(`janela ${aba.janela}`);
    linhas.push(
      `- ${aba.id} | ${aba.titulo === undefined ? '(sem titulo)' : aba.titulo} | ${aba.url}${marcas.length === 0 ? '' : ` | ${marcas.join(', ')}`}`,
    );
  }
  if (valor.abas.length === 0) {
    linhas.push('(nenhuma aba). O painel do add-on esta aberto?');
  } else {
    linhas.push('', 'Para escolher uma delas, passe o id no parametro "aba" de navegador_ler, navegador_agir ou navegador_print.');
  }
  return linhas.join('\n');
}

/** Monta o texto que o modelo lê depois de um print. */
function textoDoPrint(valor) {
  const linhas = [`Print ${valor.inteira === true ? 'da pagina inteira' : 'da area visivel'} da aba.`];
  if (valor.aba !== undefined) linhas.push(`Aba: ${descreverAba(valor.aba)}`);
  linhas.push(`Arquivo: ${valor.arquivo}`);
  if (typeof valor.bytes === 'number' && valor.bytes > 0) linhas.push(`Tamanho: ${valor.bytes} bytes.`);
  linhas.push(
    valor.imagem === undefined
      ? 'A imagem nao pode ser embutida nesta conversa; use read_image no arquivo para ver.'
      : 'A imagem vai junto desta resposta.',
  );
  return linhas.join('\n');
}

/** Monta o texto que o modelo lê depois de capturar cookies. */
function textoDosCookies(valor) {
  const linhas = [`Sessao capturada do navegador: ${valor.host} (${valor.total} cookies).`];
  linhas.push(`Arquivo: ${valor.arquivo}`);
  if (typeof valor.expira_em === 'string' && valor.expira_em !== '') {
    linhas.push(`A validade mais curta entre os cookies vai ate ${valor.expira_em}.`);
  }
  if (typeof valor.http_only === 'number' && valor.http_only > 0) {
    linhas.push(`${valor.http_only} desses cookies sao HttpOnly, que e o motivo de nao aparecerem em document.cookie.`);
  }
  linhas.push('Os valores nao foram devolvidos para a conversa: eles estao no arquivo.');
  return linhas.join('\n');
}

/**
 * A validade mais curta entre os cookies que têm prazo, em ISO.
 *
 * Cookie de sessão (`expirationDate` ausente) não entra: ele morre quando o
 * navegador fecha, então não serve para avisar sobre expiração.
 * @param cookies - lista vinda do service worker.
 * @returns ISO da data mais próxima, ou `undefined` quando nenhum tem prazo.
 */
function expiracaoMaisCedo(cookies) {
  let menor;
  for (const c of cookies) {
    if (typeof c?.expirationDate !== 'number') continue;
    if (menor === undefined || c.expirationDate < menor) menor = c.expirationDate;
  }
  if (menor === undefined) return undefined;
  return new Date(menor * 1000).toISOString();
}
