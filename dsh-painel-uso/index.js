/**
 * Metade host do painel de uso: entrega o saldo da conta DeepSeek ao navegador.
 *
 * Por que existe uma metade host: o saldo só sai de uma chamada autenticada a
 * `GET https://api.deepseek.com/user/balance`, e a chave não pode chegar ao
 * navegador. Então a rota roda aqui, no processo do servidor, lê a credencial
 * pelo serviço `credentials` (que já resolve ambiente, arquivo e .env) e devolve
 * apenas números.
 *
 * Esta metade também é o que faz `dsh-client-modules` enxergar o pacote e servir
 * o `./client` no manifesto da página.
 *
 * Rota: `GET /painel-uso/saldo`
 *
 * Rota: `GET /painel-uso/modelos` devolve, por modelo gratuito configurado, o
 * teto publicado e quantas chamadas este DSH fez na janela (dia e minuto). A
 * contagem sai do gancho `llm/stream`, que vê toda chamada de modelo do
 * processo, inclusive subagente, e é gravada em `painel-uso-contagem.json` no
 * harness home para sobreviver a reinício. Nenhum provedor expõe cota restante
 * em API, então o número é local: diz o que este DSH gastou, não o que a conta
 * inteira gastou.
 *
 * Segurança: a rota NÃO herda o gate do app (o webserver casa o prefixo mais
 * específico primeiro), então ela mesma pede a autorização ao serviço
 * `connection`, que aplica o fence de Host/Origin e valida o cookie de sessão do
 * navegador. Sem o serviço de conexão a resposta é 403, nunca dado aberto.
 *
 * Config (na linha do patch do perfil):
 *   alertBelowUsd: 1      limite em USD abaixo do qual o painel pinta de vermelho
 *   cacheSeconds: 300     validade do cache local (a própria API é instantânea)
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Caminho servido ao navegador (prefixo, para aceitar query string). */
const ROTA = '/painel-uso/saldo'
/** Endpoint oficial do saldo. */
const URL_SALDO = 'https://api.deepseek.com/user/balance'
/** Referência da credencial, como aparece no .credentials.yaml do DSH. */
const REF_CREDENCIAL = 'DEEPSEEK_API_KEY'
/** Identifica a versão viva desta metade host (confere se o reload pegou). */
const VERSAO = 4

/** Caminho servido ao navegador com o limite documentado de cada modelo. */
const ROTA_MODELOS = '/painel-uso/modelos'
/** Rota da franquia do Go: repassa o que o roteador `auto` leu do provedor. */
const ROTA_FRANQUIA = '/painel-uso/franquia'
/** Validade da lista de modelos (o catálogo muda pouco; a contagem muda rápido). */
const CACHE_MODELOS_MS = 5_000

/**
 * Limites dos modelos gratuitos: vêm do vault, com fallback local.
 *
 * O `tools\motores.json` do vault é a fonte única, gerada de `tools\motor.mjs`
 * pelo `tools\gerar-motores-json.mjs`. Antes esta tabela era uma cópia à mão e já
 * tinha divergido do roteador: o OpenRouter aparecia com 50/dia aqui e 1.000/dia
 * lá, e os Nemotron não apareciam. O fallback abaixo existe para máquina sem
 * vault e traz o mesmo conjunto que o kit configura hoje.
 *
 * `dia` e `minuto` são tetos em número de chamadas (o que a API do provedor não
 * informa depois do fato), `tpm` é o teto de tokens por minuto quando é o único
 * limite documentado, e `ctx` é o contexto de reserva quando o catálogo não
 * informa.
 */
const LIMITES_FALLBACK = {
  nvidia: {
    // A NVIDIA não publica teto diário: o limite é de taxa (40 por minuto).
    'z-ai/glm-5.3-flash': { minuto: 40, ctx: 1000000 }
  },
  openrouter: {
    // Conta sem crédito desde 25/10/2026: o teto real é 50/dia.
    'nvidia/nemotron-3-ultra-550b-a55b:free': { dia: 50, minuto: 20, ctx: 1000000 },
    'openrouter/free': { dia: 50, minuto: 20, ctx: 200000 },
    'cohere/north-mini-code:free': { dia: 50, minuto: 20, ctx: 256000 }
  },
  google: {
    'gemini-3.1-flash-lite': { dia: 500, minuto: 15, ctx: 1048576 }
  }
}

/** Caminho do `motores.json` no vault, a fonte única gerada do motor.mjs. */
const CAMINHO_MOTORES = join(
  process.env.USERPROFILE ?? homedir(),
  'Documents',
  'dsh-memory',
  'tools',
  'motores.json'
)

/** Por quanto tempo a tabela lida do vault fica em memória. */
const CACHE_LIMITES_MS = 30_000

let cacheLimites

/**
 * Tabela de limites em uso: a do vault quando existe e parseia, senão a local.
 *
 * Modelo pago (`gratuito: false`) fica de fora de propósito: esta rota é do painel
 * de limites gratuitos, e um teto nulo viraria barra vazia.
 */
function limites() {
  if (cacheLimites !== undefined && cacheLimites.expiraEm > Date.now()) {
    return cacheLimites.tabela
  }
  let tabela = LIMITES_FALLBACK
  try {
    const bruto = JSON.parse(readFileSync(CAMINHO_MOTORES, 'utf8'))
    const grupos = bruto?.motores
    if (grupos !== undefined && Object.keys(grupos).length > 0) {
      const lida = {}
      for (const [provedor, grupo] of Object.entries(grupos)) {
        const gratuitos = {}
        for (const [modelo, m] of Object.entries(grupo)) {
          if (m.gratuito === false) continue
          gratuitos[modelo] = {
            // `null` vira ausência: o chamador testa `=== undefined` para saber se
            // há teto, e `null` imprimiria "null req/dia" no tooltip.
            dia: m.dia ?? undefined,
            minuto: m.minuto ?? undefined,
            tpm: m.tpm ?? undefined,
            ctx: m.ctx ?? undefined
          }
        }
        if (Object.keys(gratuitos).length > 0) lida[provedor] = gratuitos
      }
      if (Object.keys(lida).length > 0) tabela = lida
    }
  } catch {
    // Vault ausente ou JSON quebrado: segue no fallback, sem barulho no painel.
  }
  cacheLimites = { tabela, expiraEm: Date.now() + CACHE_LIMITES_MS }
  return tabela
}

/** Arquivo da contagem local, ao lado dos demais dados do harness. */
const ARQUIVO_CONTAGEM = join(
  process.env.DSH_HOME ?? join(process.env.APPDATA ?? homedir(), 'dsh-desktop', 'harness'),
  'painel-uso-contagem.json'
)

/**
 * Consumo da franquia do Go, gravado pelo roteador `auto` em `uso.json`, ao lado
 * do proprio roteador.
 *
 * O arquivo anda junto com o roteador, e o roteador muda de pasta: em 25/10/2026
 * ele gravava em `_scratch\auto-router` e desde 10/11/2026 grava em
 * `ferramentas\auto-router`. Caminho fixo apontando para a pasta antiga era o
 * que deixava a linha do `auto` sem numero (a pasta nem existia). Por isso a
 * resolucao tenta os caminhos conhecidos, na ordem, e fica com o que existir de
 * fato; `DSH_AUTO_ROUTER_USO` continua tendo prioridade.
 */
const CAMINHOS_USO_ROUTER = [
  process.env.DSH_AUTO_ROUTER_USO,
  join(homedir(), 'Documents', 'DSH', 'ferramentas', 'auto-router', 'uso.json'),
  join(homedir(), 'Documents', 'DSH', '_scratch', 'auto-router', 'uso.json')
].filter((caminho) => typeof caminho === 'string' && caminho !== '')

/** Por quanto tempo o uso do roteador fica em memória (o roteador grava a cada chamada). */
const CACHE_USO_ROUTER_MS = 10_000
let cacheUsoRouter

/**
 * Le o consumo acumulado do roteador auto.
 *
 * O `porModelo` vem do proprio `uso.json` (o roteador passou a gravar em
 * 10/11/2026): o plano Go cobra a mesma franquia dos dois modelos dele, entao o
 * total e um so e a divisao serve para o painel mostrar de onde veio o dolar.
 * Fica vazio enquanto o roteador nao reiniciar com a versao que grava a divisao.
 * @returns {{usado: number, limite: number, porModelo: Array<{modelo: string, usd: number, chamadas: number}>} | null}
 * null quando nenhum caminho conhecido tem o `uso.json`.
 */
function usoRouter() {
  if (cacheUsoRouter !== undefined && cacheUsoRouter.expiraEm > Date.now()) {
    return cacheUsoRouter.dado
  }
  let dado = null
  for (const caminho of CAMINHOS_USO_ROUTER) {
    try {
      const bruto = JSON.parse(readFileSync(caminho, 'utf8'))
      if (typeof bruto?.usadoUsd === 'number' && typeof bruto?.limiteUsd === 'number') {
        const porModelo =
          bruto.porModelo !== null && typeof bruto.porModelo === 'object'
            ? Object.entries(bruto.porModelo)
                .map(([modelo, valor]) => ({
                  modelo,
                  usd: Number(valor?.usd) || 0,
                  chamadas: Number(valor?.chamadas) || 0,
                }))
                .filter((item) => item.usd > 0)
                .sort((a, b) => b.usd - a.usd)
            : []
        dado = {
          usado: bruto.usadoUsd,
          limite: bruto.limiteUsd,
          porModelo,
          // Chamadas que saíram por modelo gratuito do plano (`auto-livre`): não
          // somam dólar nenhum, então ficariam invisíveis no painel sem este
          // contador. É a prova de que a via grátis está servindo alguma coisa.
          gratis: Number(bruto.chamadasGratis) || 0,
        }
        break
      }
    } catch {
      // Caminho inexistente ou arquivo no meio da escrita pelo roteador: tenta
      // o proximo. Sem nenhum deles, a linha do auto fica sem numero.
    }
  }
  cacheUsoRouter = { dado, expiraEm: Date.now() + CACHE_USO_ROUTER_MS }
  return dado
}

/** Dias e minutos guardados antes de podar (a barra só olha hoje e agora). */
const DIAS_GUARDADOS = 7
const MINUTOS_GUARDADOS = 180

/**
 * Data local no formato `AAAA-MM-DD` (o teto do provedor vira à meia-noite local).
 * @param agora - instante de referência.
 * @returns a data sem fuso.
 */
function diaLocal(agora = new Date()) {
  const dois = (valor) => String(valor).padStart(2, '0')
  return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}`
}

/**
 * Minuto local no formato `AAAA-MM-DDTHH:MM`.
 * @param agora - instante de referência.
 * @returns a chave do minuto corrente.
 */
function minutoLocal(agora = new Date()) {
  const dois = (valor) => String(valor).padStart(2, '0')
  return `${diaLocal(agora)}T${dois(agora.getHours())}:${dois(agora.getMinutes())}`
}

/**
 * Lê a contagem do disco, tolerando arquivo ausente ou de versão antiga.
 * @returns `{ versao, dias, minutos }` sempre utilizável.
 */
function carregarContagem() {
  try {
    const bruto = JSON.parse(readFileSync(ARQUIVO_CONTAGEM, 'utf8'))
    if (bruto?.versao === 1 && typeof bruto.dias === 'object' && bruto.dias !== null) {
      return { versao: 1, dias: bruto.dias, minutos: typeof bruto.minutos === 'object' && bruto.minutos !== null ? bruto.minutos : {} }
    }
  } catch {
    // Sem arquivo (primeira execução) ou JSON inválido: começa zerado.
  }
  return { versao: 1, dias: {}, minutos: {} }
}

/**
 * Descarta chaves fora da janela de interesse, para o arquivo não crescer.
 * @param estado - contagem em memória, podada no lugar.
 */
function podar(estado) {
  const dias = Object.keys(estado.dias).sort()
  for (const chave of dias.slice(0, Math.max(0, dias.length - DIAS_GUARDADOS))) delete estado.dias[chave]
  const minutos = Object.keys(estado.minutos).sort()
  for (const chave of minutos.slice(0, Math.max(0, minutos.length - MINUTOS_GUARDADOS))) delete estado.minutos[chave]
}

/** Contagem em memória, carregada uma vez por processo. */
const contagem = carregarContagem()
let gravacao

/**
 * Grava a contagem no disco com atraso, em arquivo temporário e rename.
 * Uma chamada de modelo não espera I/O, e o processo que morre perde no máximo
 * os últimos segundos.
 */
function agendarGravacao() {
  if (gravacao !== undefined) return
  gravacao = setTimeout(() => {
    gravacao = undefined
    try {
      podar(contagem)
      const temporario = ARQUIVO_CONTAGEM + '.tmp'
      writeFileSync(temporario, JSON.stringify(contagem), 'utf8')
      renameSync(temporario, ARQUIVO_CONTAGEM)
    } catch {
      // Sem permissão de escrita o painel continua com o número em memória.
    }
  }, 2000)
  gravacao.unref?.()
}

/**
 * Soma uma chamada de modelo na contagem do dia e do minuto correntes.
 * @param provedor - rota que atendeu (ex.: `nvidia`).
 * @param modelo - id do modelo na rota.
 */
function contar(provedor, modelo) {
  if (typeof provedor !== 'string' || typeof modelo !== 'string') return
  const chave = provedor + '/' + modelo
  const dia = diaLocal()
  const minuto = minutoLocal()
  const porDia = (contagem.dias[dia] ??= {})
  porDia[chave] = (porDia[chave] ?? 0) + 1
  const porMinuto = (contagem.minutos[minuto] ??= {})
  porMinuto[chave] = (porMinuto[chave] ?? 0) + 1
  agendarGravacao()
}

/**
 * Quantas chamadas este DSH fez na janela corrente.
 * @param provedor - rota do modelo.
 * @param modelo - id do modelo.
 * @returns contagem de hoje e do minuto corrente.
 */
function usado(provedor, modelo) {
  const chave = provedor + '/' + modelo
  return {
    dia: contagem.dias[diaLocal()]?.[chave] ?? 0,
    minuto: contagem.minutos[minutoLocal()]?.[chave] ?? 0
  }
}

/**
 * Lê um número de config com padrão e piso.
 * @param valor - valor cru vindo do patch.
 * @param padrao - valor usado quando ausente ou inválido.
 * @param minimo - piso aplicado.
 * @returns o número utilizável.
 */
function numero(valor, padrao, minimo) {
  const parsed = typeof valor === 'number' ? valor : Number.parseFloat(String(valor ?? ''))
  if (!Number.isFinite(parsed)) return padrao
  return Math.max(minimo, parsed)
}

/**
 * Resposta JSON com no-store: saldo não se guarda em cache de navegador.
 * @param res - resposta HTTP.
 * @param status - código HTTP.
 * @param corpo - objeto serializável.
 */
function responder(res, status, corpo) {
  const body = JSON.stringify(corpo)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * Corpo do plugin no host.
 * @param ctx - contexto do host.
 * @param config - `alertBelowUsd` e `cacheSeconds` da linha do patch.
 */
export function apply(ctx, config) {
  const alertaAbaixoDe = numero(config?.alertBelowUsd, 1, 0)
  const validadeMs = numero(config?.cacheSeconds, 300, 15) * 1000

  // Toda chamada de modelo do processo passa por `llm/stream`, inclusive a de
  // subagente. O gancho só soma na contagem e devolve o stream intacto: falha
  // aqui é telemetria, nunca pode derrubar a chamada.
  ctx.on('llm/stream', (options, next) => {
    try {
      contar(options?.provider, options?.model)
    } catch {
      // Sem contagem o painel mostra 0, e o modelo segue funcionando.
    }
    return next()
  })

  /** Cache de uma entrada + voo único: N painéis abertos = 1 chamada à API. */
  let cache
  let emVoo

  /**
   * Lê a chave pela camada de credenciais do DSH.
   * @returns a chave, ou undefined quando não há credencial configurada.
   */
  async function chave() {
    const credenciais = ctx.get('credentials')
    if (credenciais !== undefined) {
      const resolvido = await credenciais.resolve(REF_CREDENCIAL)
      if (resolvido?.value !== undefined && resolvido.value !== '') return resolvido.value
    }
    const doAmbiente = process.env[REF_CREDENCIAL]
    return doAmbiente === undefined || doAmbiente === '' ? undefined : doAmbiente
  }

  /**
   * Consulta o saldo na API oficial.
   * @returns o corpo normalizado para o navegador.
   * @throws quando falta credencial, a rede falha ou a API recusa.
   */
  async function consultar() {
    const apiKey = await chave()
    if (apiKey === undefined) throw new Error(`sem credencial ${REF_CREDENCIAL} configurada neste DSH`)

    const resposta = await fetch(URL_SALDO, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    })
    const texto = await resposta.text()
    if (!resposta.ok) throw new Error(`a API respondeu ${resposta.status}: ${texto.slice(0, 200)}`)

    const dados = JSON.parse(texto)
    const moedas = (Array.isArray(dados.balance_infos) ? dados.balance_infos : []).map((info) => ({
      moeda: info.currency ?? '?',
      total: Number.parseFloat(info.total_balance),
      concedido: Number.parseFloat(info.granted_balance),
      recarregado: Number.parseFloat(info.topped_up_balance)
    }))
    const total = moedas.length > 0 ? moedas[0].total : undefined
    return {
      ok: true,
      versao: VERSAO,
      disponivel: dados.is_available === true,
      moedas,
      alertaAbaixoDe,
      abaixoDoAlerta: total !== undefined && Number.isFinite(total) && total < alertaAbaixoDe,
      atualizadoEm: new Date().toISOString()
    }
  }

  /**
   * Devolve o saldo do cache quando válido, senão consulta (uma consulta por vez).
   * @returns o corpo normalizado.
   */
  async function saldo() {
    if (cache !== undefined && cache.expiraEm > Date.now()) return cache.corpo
    if (emVoo !== undefined) return emVoo
    emVoo = consultar().then(
      (corpo) => {
        cache = { corpo, expiraEm: Date.now() + validadeMs }
        emVoo = undefined
        return corpo
      },
      (erro) => {
        emVoo = undefined
        throw erro
      }
    )
    return emVoo
  }

  /**
   * Trata a requisição do navegador: autoriza, consulta e responde.
   * @param req - requisição HTTP.
   * @param res - resposta, de propriedade deste handler.
   */
  async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      responder(res, 405, { ok: false, erro: 'metodo nao permitido' })
      return
    }

    const conexao = ctx.get('connection')
    if (conexao === undefined) {
      responder(res, 403, { ok: false, erro: 'sem servico de conexao: rota sem autorizacao' })
      return
    }
    const recusa = conexao.requestRejection(req)
    if (recusa !== undefined) {
      responder(res, recusa, { ok: false, erro: 'nao autorizado' })
      return
    }

    if (req.method === 'HEAD') {
      responder(res, 200, { ok: true })
      return
    }

    try {
      responder(res, 200, await saldo())
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro)
      ctx.logger?.warn?.(`painel-uso: falha ao consultar saldo: ${mensagem}`)
      responder(res, 503, { ok: false, versao: VERSAO, erro: mensagem, alertaAbaixoDe })
    }
  }

  /** Cache da lista de modelos (o catálogo é local, mas listModels é async). */
  let cacheModelos

  /**
   * Lê a seleção de modelos de subagente do DSH, quando o plugin que a mantém
   * está composto. O serviço é a fonte da verdade: repetir a lista aqui faria a
   * barra divergir do que o subagente pode escolher de fato.
   * @returns `{ habilitado, rotas, chaves }`, ou `null` quando o serviço não existe.
   */
  function selecaoSubagente() {
    try {
      const servico = ctx.get('subagentModelSelection')
      if (servico === undefined || typeof servico.current !== 'function') return null
      const atual = servico.current()
      const rotas = (Array.isArray(atual?.allowedModels) ? atual.allowedModels : []).map((rota) => ({
        provedor: rota.provider,
        modelo: rota.model
      }))
      return {
        habilitado: atual?.enabled === true,
        rotas,
        chaves: new Set(rotas.map((rota) => rota.provedor + '/' + rota.modelo))
      }
    } catch {
      // Serviço presente mas com configuração inválida: trata como ausente.
      return null
    }
  }

  /**
   * Lista os modelos gratuitos das rotas configuradas com o limite documentado e
   * marca quais estão liberados para subagente.
   * A cota restante não existe em API nenhuma: o que sai é o teto publicado.
   * @returns o corpo normalizado para o navegador.
   * @throws quando o serviço `llm` não está disponível.
   */
  async function modelos() {
    if (cacheModelos !== undefined && cacheModelos.expiraEm > Date.now()) return cacheModelos.corpo
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('servico llm indisponivel')
    const selecao = selecaoSubagente()
    const catalogos = new Map()

    /**
     * Catálogo de uma rota, buscado uma vez por chamada.
     * @param rota - id do provedor.
     * @returns a lista de modelos, vazia quando a rota não responde.
     */
    async function catalogoDe(rota) {
      if (!catalogos.has(rota)) {
        try {
          catalogos.set(rota, await llm.listModels(rota))
        } catch {
          catalogos.set(rota, [])
        }
      }
      return catalogos.get(rota)
    }

    const lista = []
    const vistos = new Set()
    for (const rota of llm.listProviders().map((provedor) => provedor.id)) {
      const tabela = limites()[rota]
      if (tabela === undefined) continue
      const catalogo = await catalogoDe(rota)
      const porId = new Map(catalogo.map((modelo) => [modelo.id, modelo]))
      for (const [id, regra] of Object.entries(tabela)) {
        const meta = porId.get(id)
        // Rota configurada mas modelo fora do catálogo: não inventa linha.
        if (meta === undefined && catalogo.length > 0) continue
        const feito = usado(rota, id)
        // `limite` continua saindo como texto: o tooltip do credit-widget le
        // este campo, e a barra do painel usa os numeros de `dia`/`minuto`.
        const limite = [
          regra.dia === undefined ? null : `${regra.dia} req/dia`,
          regra.minuto === undefined ? null : `${regra.minuto} req/min`,
          regra.tpm === undefined ? null : `${regra.tpm} TPM`
        ]
          .filter((parte) => parte !== null)
          .join(' · ')
        const chave = rota + '/' + id
        vistos.add(chave)
        lista.push({
          provedor: rota,
          modelo: id,
          contexto: typeof meta?.contextWindow === 'number' ? meta.contextWindow : regra.ctx,
          limite,
          // Contagem de hoje independente de a tabela ter teto diario: o painel
          // filtra por "motor usado hoje" e um modelo que so tem teto por minuto
          // (a NVIDIA e 40/min) ficaria sempre com `dia: null` e nunca apareceria.
          usadoHoje: feito.dia,
          dia: regra.dia === undefined ? null : { limite: regra.dia, usado: feito.dia },
          minuto: regra.minuto === undefined ? null : { limite: regra.minuto, usado: feito.minuto },
          tpm: regra.tpm ?? null,
          // null quando o DSH não tem o serviço de seleção: a sidebar mostra tudo.
          subagente: selecao === null ? null : selecao.habilitado && selecao.chaves.has(chave)
        })
      }
    }
    // Modelo liberado para subagente que não está na tabela curada: entra sem
    // teto documentado, para a sidebar não esconder o que o subagente usa.
    if (selecao !== null && selecao.habilitado) {
      for (const rota of selecao.rotas) {
        const chave = rota.provedor + '/' + rota.modelo
        if (vistos.has(chave)) continue
        const catalogo = await catalogoDe(rota.provedor)
        const meta = catalogo.find((modelo) => modelo.id === rota.modelo)
        if (meta === undefined && catalogo.length > 0) continue
        vistos.add(chave)
        const usd = rota.provedor === 'auto' ? usoRouter() : null
        lista.push({
          provedor: rota.provedor,
          modelo: rota.modelo,
          contexto: typeof meta?.contextWindow === 'number' ? meta.contextWindow : null,
          limite: usd === null ? '' : `US$ ${usd.limite}/mes`,
          usadoHoje: usado(rota.provedor, rota.modelo).dia,
          dia: null,
          minuto: null,
          tpm: null,
          usd,
          subagente: true
        })
      }
    }
    const corpo = {
      ok: true,
      versao: VERSAO,
      modelos: lista,
      subagentes:
        selecao === null ? null : { habilitado: selecao.habilitado, total: selecao.rotas.length },
      atualizadoEm: new Date().toISOString()
    }
    cacheModelos = { corpo, expiraEm: Date.now() + CACHE_MODELOS_MS }
    return corpo
  }

  /**
   * Entrega a lista de modelos com o mesmo gate da rota de saldo.
   * @param req - requisição HTTP.
   * @param res - resposta HTTP.
   */
  async function handlerModelos(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      responder(res, 405, { ok: false, erro: 'metodo nao permitido' })
      return
    }
    const conexao = ctx.get('connection')
    if (conexao === undefined) {
      responder(res, 403, { ok: false, erro: 'sem servico de conexao: rota sem autorizacao' })
      return
    }
    const recusa = conexao.requestRejection(req)
    if (recusa !== undefined) {
      responder(res, recusa, { ok: false, erro: 'nao autorizado' })
      return
    }
    if (req.method === 'HEAD') {
      responder(res, 200, { ok: true })
      return
    }
    try {
      responder(res, 200, await modelos())
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro)
      ctx.logger?.warn?.(`painel-uso: falha ao listar modelos: ${mensagem}`)
      responder(res, 503, { ok: false, versao: VERSAO, erro: mensagem })
    }
  }

  /**
   * Mantém a rota viva enquanto esta linha existir na composição.
   * @param webCtx - contexto que já enxerga o serviço `webServer`.
   */
  /** Cache curto da franquia: o roteador ja guarda amostras, aqui so evita repetir. */
  let cacheFranquia
  const CACHE_FRANQUIA_MS = 30_000

  /**
   * Lê a franquia do Go pelo roteador `auto`, que é quem tem a chave do plano e
   * o histórico de amostras. O navegador não fala com o roteador direto (outra
   * porta, outra origem), então a leitura passa por esta rota.
   *
   * O contador local (`uso.json`) não serve como fonte de limite: ele só vê o que
   * passa pelo roteador. Medido em 11/11/2026, ele dizia 13% do mês enquanto a
   * API do plano dizia 27%. Por isso o número vem do provedor.
   *
   * @returns corpo normalizado para o navegador, ou `{ok:false}` com o motivo.
   */
  async function franquia() {
    if (cacheFranquia !== undefined && cacheFranquia.expiraEm > Date.now()) return cacheFranquia.corpo
    const alvos = Array.isArray(config?.routerFranquia)
      ? config.routerFranquia
      : ['http://127.0.0.1:8799/franquia', 'http://127.0.0.1:8809/franquia']
    let ultimoErro = 'roteador não respondeu'
    for (const alvo of alvos) {
      try {
        const resposta = await fetch(alvo, { signal: AbortSignal.timeout(8000) })
        const corpo = await resposta.json()
        if (corpo?.ok === true) {
          cacheFranquia = { corpo, expiraEm: Date.now() + CACHE_FRANQUIA_MS }
          return corpo
        }
        ultimoErro = corpo?.erro ?? 'HTTP ' + resposta.status
      } catch (erro) {
        ultimoErro = erro instanceof Error ? erro.message : String(erro)
      }
    }
    const corpo = { ok: false, versao: VERSAO, erro: ultimoErro, alvos }
    cacheFranquia = { corpo, expiraEm: Date.now() + 10_000 }
    return corpo
  }

  /**
   * Entrega a franquia com o mesmo gate das outras rotas.
   * @param req - requisição HTTP.
   * @param res - resposta HTTP.
   */
  async function handlerFranquia(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      responder(res, 405, { ok: false, erro: 'metodo nao permitido' })
      return
    }
    const conexao = ctx.get('connection')
    if (conexao === undefined) {
      responder(res, 403, { ok: false, erro: 'sem servico de conexao: rota sem autorizacao' })
      return
    }
    const recusa = conexao.requestRejection(req)
    if (recusa !== undefined) {
      responder(res, recusa, { ok: false, erro: 'nao autorizado' })
      return
    }
    if (req.method === 'HEAD') {
      responder(res, 200, { ok: true })
      return
    }
    try {
      responder(res, 200, await franquia())
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro)
      ctx.logger?.warn?.(`painel-uso: falha ao ler a franquia: ${mensagem}`)
      responder(res, 503, { ok: false, versao: VERSAO, erro: mensagem })
    }
  }

  const registrar = (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROTA, handler }),
      'painel-uso: rota de saldo'
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROTA_MODELOS, handler: handlerModelos }),
      'painel-uso: rota de modelos'
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROTA_FRANQUIA, handler: handlerFranquia }),
      'painel-uso: rota de franquia'
    )
  }

  // Sempre por `inject`. Na 0.12.1 acessar `ctx.webServer` por propriedade sem
  // inject declarado estoura "cannot get property webServer without inject", e o
  // ramo antigo `else registrar(ctx)` fazia exatamente isso: a metade host caía,
  // a rota /painel-uso/saldo virava 404 e o painel e o badge de saldo ficavam sem
  // dado. O `inject` chama o registrar na hora quando o serviço já existe, e de
  // novo se ele aparecer ou mudar.
  ctx.inject(['webServer'], registrar)
}
