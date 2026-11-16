/**
 * Teste de bancada do add-on `dsh-colar-texto`: roda o bundle de cliente num
 * ambiente falso (window/document/React/ctx) e exercita o handler de `paste` e a
 * compactacao do transcrito de ponta a ponta, sem navegador.
 *
 * Uso (com o node do harness do DSH):
 *   & "$env:APPDATA\dsh-desktop\harness\.desktop-bin\node.cmd" .\teste-bancada.cjs
 *
 * O caminho do bundle sai da pasta deste arquivo, entao o teste roda igual na
 * fonte e na copia do perfil. Opcional: passe outro caminho como primeiro
 * argumento.
 *
 * Sai 0 quando passa tudo e 1 quando algum caso falha (a saida lista os casos).
 */
process.noAsar = true

const fs = require('node:fs')
const path = require('node:path')

const CLIENTE = process.argv[2] ?? path.join(__dirname, 'client.js')

let falhas = 0
function conferir(descricao, condicao, extra) {
  const marca = condicao ? 'ok  ' : 'FALHA'
  if (!condicao) falhas += 1
  console.log(`${marca} ${descricao}${condicao || extra === undefined ? '' : ' -> ' + JSON.stringify(extra)}`)
}

//#region ambiente falso
/**
 * Combina um elemento falso com os poucos seletores que o plugin usa:
 * `.classe`, `tag[atributo]`, `[atributo="valor"]`.
 * @param el - elemento falso.
 * @param seletor - seletor simples.
 * @returns true quando casa.
 */
function combina(el, seletor) {
  if (seletor === '') return false
  if (seletor.startsWith('.')) return el.classes.has(seletor.slice(1))
  const m = /^([a-z]*)\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(seletor)
  if (m === null) return false
  if (m[1] !== '' && el.tag !== m[1]) return false
  const valor = el.atributos[m[2]]
  if (valor === undefined) return false
  return m[3] === undefined || valor === m[3]
}

class FakeElement {
  constructor(opcoes = {}) {
    this.tag = opcoes.tag ?? 'div'
    this.display = opcoes.display ?? (this.tag === 'span' ? 'inline' : 'block')
    this.atributos = { ...(opcoes.atributos ?? {}) }
    this.classes = new Set(opcoes.classes ?? [])
    this.dataset = {}
    this.proprioTexto = opcoes.texto ?? ''
    this.rect = opcoes.rect ?? { top: 0, bottom: 100, left: 0, right: 100, height: 100, width: 100 }
    this.dentroDoCard = opcoes.dentroDoCard ?? false
    this.pai = null
    this.filhos = []
    if (opcoes.pai !== undefined && opcoes.pai !== null) {
      this.pai = opcoes.pai
      this.pai.filhos.push(this)
    }
  }
  get children() {
    return this.filhos
  }
  get textContent() {
    let texto = this.proprioTexto
    for (const filho of this.filhos) texto += filho.textContent
    return texto
  }
  set textContent(valor) {
    this.proprioTexto = String(valor)
    this.filhos = []
  }
  get classList() {
    const self = this
    return {
      add: (...nomes) => {
        for (const nome of nomes) self.classes.add(nome)
      },
      remove: (...nomes) => {
        for (const nome of nomes) self.classes.delete(nome)
      },
      contains: (nome) => self.classes.has(nome)
    }
  }
  setAttribute(nome, valor) {
    this.atributos[nome] = String(valor)
  }
  getAttribute(nome) {
    return this.atributos[nome] ?? null
  }
  hasAttribute(nome) {
    return Object.prototype.hasOwnProperty.call(this.atributos, nome)
  }
  appendChild(filho) {
    filho.pai = this
    this.filhos.push(filho)
    return filho
  }
  closest(seletor) {
    let atual = this
    while (atual !== null) {
      if (seletor === '[data-composer-card]' ? atual.dentroDoCard : combina(atual, seletor)) return atual
      atual = atual.pai
    }
    return null
  }
  contains(outro) {
    let atual = outro
    while (atual !== null && atual !== undefined) {
      if (atual === this) return true
      atual = atual.pai
    }
    return false
  }
  querySelectorAll(seletor) {
    const achados = []
    const visitar = (el) => {
      for (const unico of seletor.split(',')) {
        if (combina(el, unico.trim())) {
          achados.push(el)
          break
        }
      }
      for (const filho of el.filhos) visitar(filho)
    }
    for (const filho of this.filhos) visitar(filho)
    return achados
  }
  querySelector(seletor) {
    return this.querySelectorAll(seletor)[0] ?? null
  }
  getBoundingClientRect() {
    return this.rect
  }
}
global.Element = FakeElement

const armazem = new Map()
let ouvintes = []
const estilos = []
const raizes = []
const documento = {
  documentElement: { lang: 'pt-BR' },
  body: new FakeElement({ tag: 'body' }),
  head: { appendChild: (el) => estilos.push(el) },
  createElement: (tag) => new FakeElement({ tag, display: 'none' }),
  addEventListener: (tipo, fn, captura) => {
    ouvintes.push({ tipo, fn, captura })
  },
  removeEventListener: (tipo, fn) => {
    ouvintes = ouvintes.filter((o) => !(o.tipo === tipo && o.fn === fn))
  },
  querySelector: (seletor) => {
    for (const el of estilos) if (combina(el, seletor)) return el
    return documento.querySelectorAll(seletor)[0] ?? null
  },
  querySelectorAll: (seletor) => {
    const achados = []
    for (const raiz of raizes) {
      for (const unico of seletor.split(',')) {
        if (combina(raiz, unico.trim())) {
          achados.push(raiz)
          break
        }
      }
      achados.push(...raiz.querySelectorAll(seletor))
    }
    return achados
  },
  /** Registra um no de topo do transcrito falso. */
  registrar: (no) => raizes.push(no)
}
global.document = documento

let observador
global.MutationObserver = class {
  constructor(cb) {
    this.cb = cb
    observador = this
  }
  observe() {}
  disconnect() {}
}

let moduloRegistrado
let seqTimer = 0
let timers = []
let quadros = []
const janela = {
  localStorage: {
    getItem: (chave) => (armazem.has(chave) ? armazem.get(chave) : null)
  },
  getComputedStyle: (el) => ({ display: el.display }),
  requestAnimationFrame: (fn) => {
    quadros.push(fn)
    return 1
  },
  setTimeout: (fn) => {
    seqTimer += 1
    timers.push({ id: seqTimer, fn })
    return seqTimer
  },
  clearTimeout: (id) => {
    timers = timers.filter((t) => t.id !== id)
  },
  __ModuleLoader__: {
    load: (definicao) => {
      moduloRegistrado = definicao
    }
  }
}
global.window = janela

/**
 * Avanca o relogio ate nao sobrar nada agendado: a varredura do transcrito e
 * debounced, entao um agendamento costuma gerar outro.
 */
function rodarTempo() {
  for (let volta = 0; volta < 10 && timers.length > 0; volta += 1) {
    const pendentes = timers
    timers = []
    for (const pendente of pendentes) pendente.fn()
  }
}

/** Roda os quadros agendados (a primeira varredura tambem espera um quadro). */
function rodarQuadro() {
  const pendentes = quadros
  quadros = []
  for (const pendente of pendentes) pendente()
}

let efeitoDoComponente
const reactFalso = {
  useRef: () => ({ current: 0 }),
  useEffect: (fn) => {
    efeitoDoComponente = fn()
  },
  createElement: () => null
}

/** @returns o clone do modulo carregado pelo bundle. */
function carregarBundle() {
  const codigo = fs.readFileSync(CLIENTE, 'utf8')
  const fabrica = new Function('window', 'document', 'Element', 'Intl', 'console', codigo + '\nreturn window.__ModuleLoader__')
  fabrica(janela, documento, FakeElement, Intl, console)
  const modulo = moduloRegistrado.factory((nome) => {
    if (nome === 'react') return reactFalso
    throw new Error('require inesperado: ' + nome)
  })
  return modulo
}
//#endregion

//#region cenario
const modulo = carregarBundle()
conferir('bundle registra o id do modulo', moduloRegistrado.id === 'dsh-colar-texto', moduloRegistrado.id)
conferir('apply e funcao', typeof modulo.apply === 'function')
conferir('inject lista slots/locale/sessions/inputTriggers', JSON.stringify(modulo.inject) === JSON.stringify(['slots', 'locale', 'sessions', 'inputTriggers']), modulo.inject)

/**
 * Monta um no do transcrito com a estrutura real, incluindo o outlet de slot
 * (`display: contents`) que fica entre o no e a linha:
 *   no[data-chat-flow-kind] > outlet[data-slot] > linha > pilha > [anexos] + bolha > runs
 * @param texto - texto da mensagem.
 * @param extras - `tipo`, `comAnexos` e `inline` (texto num span so, como na
 *   mensagem sem mencoes).
 * @returns `{ no, outlet, linha, pilha, bolha, anexos }`.
 */
function montarNoDoTranscrito(texto, extras = {}) {
  const no = new FakeElement({ atributos: { 'data-chat-flow-kind': extras.tipo ?? 'user' } })
  const outlet = new FakeElement({ pai: no, display: 'contents', atributos: { 'data-slot': 'conversation.chat.node' } })
  const linha = new FakeElement({ pai: outlet })
  const pilha = new FakeElement({ pai: linha })
  const anexos = extras.comAnexos === true ? new FakeElement({ pai: pilha, atributos: { 'data-message-attachments': 'true' } }) : null
  const bolha = new FakeElement({ pai: pilha })
  if (extras.inline !== false) {
    const run = new FakeElement({ tag: 'span', texto, pai: bolha })
    void run
  } else {
    bolha.appendChild(new FakeElement({ tag: 'span', texto: texto.slice(0, 10) }))
    bolha.appendChild(new FakeElement({ tag: 'span', texto: texto.slice(10) }))
  }
  documento.registrar(no)
  return { no, outlet, linha, pilha, bolha, anexos }
}

const textoGigante = 'x'.repeat(300000)
const noGrande = montarNoDoTranscrito(textoGigante)
const noCurto = montarNoDoTranscrito('mensagem curta de teste')
const noComAnexo = montarNoDoTranscrito('y'.repeat(4000), { comAnexos: true })

let registroDoSlot
let dicionarios
let fonteRegistrada
const servicoTriggers = {
  registerSource: (fonte) => {
    fonteRegistrada = fonte
    return () => {}
  }
}
const ctxFalso = {
  get: (nome) => (nome === 'sessions' ? servicoSessoes : nome === 'inputTriggers' ? servicoTriggers : undefined),
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => {
      dicionarios = { ns, dicts }
      return () => {}
    },
    bind: () => (chave, params) => (params === undefined ? chave : chave + ':' + JSON.stringify(params))
  },
  slots: {
    inject: (chave, fn) => fn(),
    register: (opcoes, componente) => {
      registroDoSlot = { opcoes, componente }
      return () => {}
    }
  }
}

let chamadas = []
let resultadoDoBail = true
const actx = {
  bail: (self, nome, payload) => {
    chamadas.push({ nome, payload })
    return resultadoDoBail ? true : undefined
  }
}
const servicoSessoes = {
  scope: (id) => (id === 'sessao-1' ? actx : undefined)
}

modulo.apply(ctxFalso)
const agendamentosDaMontagem = { timers: timers.length, quadros: quadros.length }
conferir('registra o occupant invisivel na overlay', registroDoSlot?.opcoes?.name === 'conversation.input.overlay' && registroDoSlot?.opcoes?.id === 'colar-texto', registroDoSlot?.opcoes)
conferir('publica os dois dicionarios', dicionarios?.ns === 'colar-texto' && Object.keys(dicionarios.dicts).sort().join(',') === 'en,zh')
conferir('registra a fonte de chip "paste"', fonteRegistrada?.name === 'paste' && fonteRegistrada?.trigger === '/', fonteRegistrada?.name)
conferir('a fonte tem codec com serialize', typeof fonteRegistrada?.codec?.serialize === 'function')
conferir('candidates da fonte e funcao', typeof fonteRegistrada?.candidates === 'function')

/** Monta o componente e devolve o listener de paste instalado. */
let ultimaLimpeza
function montar(props) {
  const antes = ouvintes.length
  ultimaLimpeza = undefined
  registroDoSlot.componente({ sessionId: 'sessao-1', inputActions: { captureInsertion: () => ({ start: 3, end: 3, draftRev: 7 }) }, t: (chave, params) => chave + ':' + params.total, ...props })
  ultimaLimpeza = efeitoDoComponente
  return ouvintes.slice(antes).find((o) => o.tipo === 'paste')
}

/** Evento de colagem falso. */
function colar(texto, extras = {}) {
  const marcas = { preventDefault: 0, stopPropagation: 0 }
  return {
    target: new FakeElement({ dentroDoCard: extras.foraDoCard !== true }),
    clipboardData: {
      items: extras.comArquivo ? [{ kind: 'file' }, { kind: 'string' }] : [{ kind: 'string' }],
      getData: (tipo) => (tipo === 'text/plain' ? texto : '')
    },
    preventDefault: () => {
      marcas.preventDefault += 1
    },
    stopPropagation: () => {
      marcas.stopPropagation += 1
    },
    marcas
  }
}

/** Evento de clique falso dentro de uma bolha. */
function clicar(elemento, clientY) {
  const alvo = elemento.filhos[0] ?? elemento
  const evento = { target: alvo, clientY }
  for (const ouvinte of ouvintes.filter((o) => o.tipo === 'click')) ouvinte.fn(evento)
  return evento
}
//#endregion

//#region casos
const ouvinte = montar({})
conferir('instala o listener em captura', ouvinte?.captura === true)

// 1) texto grande vira chip
chamadas = []
resultadoDoBail = true
const grande = 'x'.repeat(300000)
let evento = colar(grande)
ouvinte.fn(evento)
conferir('texto de 300k chama a insercao', chamadas.length === 1, chamadas.length)
conferir('usa o evento de insercao de referencia', chamadas[0]?.nome === 'slash/input-insert-reference', chamadas[0]?.nome)
conferir('span vem do captureInsertion', JSON.stringify(chamadas[0]?.payload?.span) === JSON.stringify({ start: 3, end: 3, draftRev: 7 }), chamadas[0]?.payload?.span)
conferir('clipboardText e o texto inteiro', chamadas[0]?.payload?.reference?.clipboardText.length === 300000, chamadas[0]?.payload?.reference?.clipboardText?.length)
conferir('rotulo e curto e com o total', chamadas[0]?.payload?.reference?.label === 'chip.label:300.000' || chamadas[0]?.payload?.reference?.label === 'chip.label:300,000', chamadas[0]?.payload?.reference?.label)
conferir('fonte do chip e "paste"', chamadas[0]?.payload?.reference?.source === 'paste', chamadas[0]?.payload?.reference?.source)
conferir('suprime a colagem depois de inserir', evento.marcas.preventDefault === 1 && evento.marcas.stopPropagation === 1, evento.marcas)

// 2) texto curto passa direto
chamadas = []
evento = colar('uma frase curta')
ouvinte.fn(evento)
conferir('texto curto nao chama a insercao', chamadas.length === 0, chamadas.length)
conferir('texto curto nao e suprimido', evento.marcas.preventDefault === 0, evento.marcas)

// 3) muitas linhas, poucos caracteres
chamadas = []
evento = colar(Array.from({ length: 40 }, (_, i) => 'l' + i).join('\n'))
ouvinte.fn(evento)
conferir('40 linhas chamam a insercao', chamadas.length === 1, chamadas.length)

// 4) insercao recusada -> colagem normal
chamadas = []
resultadoDoBail = false
evento = colar(grande)
ouvinte.fn(evento)
conferir('insercao recusada nao suprime a colagem', chamadas.length === 1 && evento.marcas.preventDefault === 0, evento.marcas)

// 5) fora do card do composer
chamadas = []
resultadoDoBail = true
evento = colar(grande, { foraDoCard: true })
ouvinte.fn(evento)
conferir('colagem fora do composer e ignorada', chamadas.length === 0, chamadas.length)

// 6) colagem com arquivo: quem trata e o anexo
chamadas = []
evento = colar(grande, { comArquivo: true })
ouvinte.fn(evento)
conferir('colagem com arquivo nao vira chip', chamadas.length === 0, chamadas.length)

// 7) marcadores internos do DSH sao removidos do texto
chamadas = []
evento = colar('\uFFFC' + 'y'.repeat(2000) + '\uE100')
ouvinte.fn(evento)
const limpo = chamadas[0]?.payload?.reference?.clipboardText ?? ''
conferir('U+FFFC e faixa privada saem do texto', limpo.length === 2000 && !limpo.includes('\uFFFC') && !limpo.includes('\uE100'), limpo.length)

// 8) desligado no localStorage
armazem.set('dsh-colar-texto', 'off')
chamadas = []
evento = colar(grande)
ouvinte.fn(evento)
conferir('"off" desliga o add-on', chamadas.length === 0, chamadas.length)
armazem.delete('dsh-colar-texto')

// 9) limite ajustado pelo navegador
armazem.set('dsh-colar-texto:caracteres', '50')
chamadas = []
evento = colar('z'.repeat(60))
ouvinte.fn(evento)
conferir('limite do localStorage vale', chamadas.length === 1, chamadas.length)
armazem.delete('dsh-colar-texto:caracteres')

// 10) sessao sem escopo materializado
chamadas = []
ouvinte.fn(colar(grande))
const salvo = servicoSessoes.scope
servicoSessoes.scope = () => undefined
chamadas = []
evento = colar(grande)
ouvinte.fn(evento)
conferir('sem escopo de sessao, nada acontece', chamadas.length === 0 && evento.marcas.preventDefault === 0, evento.marcas)
servicoSessoes.scope = salvo

// 11) componente sem props de sessao nao instala listener
conferir('sem sessionId nao instala listener', montar({ sessionId: undefined }) === undefined)
conferir('sem inputActions nao instala listener', montar({ inputActions: undefined }) === undefined)

// 12) desmontar remove o listener
const pasteAntesDoDesmonte = ouvintes.filter((o) => o.tipo === 'paste').length
montar({})
ultimaLimpeza?.()
conferir('desmontar remove o listener de paste', ouvintes.filter((o) => o.tipo === 'paste').length === pasteAntesDoDesmonte)

// 13) o codec da fonte: e o que o envio usa para montar o prompt
chamadas = []
resultadoDoBail = true
const textoA = 'a'.repeat(2000)
const textoB = Array.from({ length: 30 }, (_, i) => 'linha ' + i).join('\n')
ouvinte.fn(colar(textoA))
const refA = chamadas[0]?.payload?.reference?.ref
const sessaoOutra = montar({ sessionId: 'sessao-1' })
sessaoOutra.fn(colar(textoB))
const refB = chamadas[1]?.payload?.reference?.ref
conferir('dois chips recebem refs distintos', refA !== refB && refA !== undefined, { refA, refB })

// 14) o transcrito: a bolha longa ja nasce cortada, na varredura da montagem
conferir('publica o CSS da compactacao', estilos.length === 1 && estilos[0].textContent.includes('.dct-recolhida'), estilos.length)
conferir('bolha longa nasce recolhida', noGrande.bolha.classes.has('dct-bolha') && noGrande.bolha.classes.has('dct-recolhida'), [...noGrande.bolha.classes])
conferir('acha a bolha atras do outlet display:contents', !noGrande.outlet.classes.has('dct-bolha') && !noGrande.linha.classes.has('dct-bolha'), [...noGrande.outlet.classes])
conferir('a marca fica na bolha, nao na linha', !noGrande.linha.classes.has('dct-bolha') && !noGrande.pilha.classes.has('dct-bolha'))
conferir('o run inline nao e marcado', !noGrande.bolha.filhos[0].classes.has('dct-bolha'))
conferir('a dica sai traduzida', noGrande.bolha.getAttribute('data-dct-dica') === 'transcricao.expandir' && noGrande.bolha.getAttribute('data-dct-dica-recolher') === 'transcricao.recolher', noGrande.bolha.getAttribute('data-dct-dica'))
conferir('mensagem curta fica intacta', !noCurto.bolha.classes.has('dct-bolha'))
conferir('com anexo, a bolha e cortada e os anexos nao', noComAnexo.bolha.classes.has('dct-recolhida') && !noComAnexo.anexos.classes.has('dct-bolha'), [...noComAnexo.bolha.classes])
const noDoAssistente = montarNoDoTranscrito('z'.repeat(5000), { tipo: 'assistant' })
conferir('mensagem do assistente nao e tocada', !noDoAssistente.bolha.classes.has('dct-bolha'))

// 15) expandir e recolher pelo clique
noGrande.bolha.rect = { top: 0, bottom: 100, left: 0, right: 100, height: 100, width: 100 }
clicar(noGrande.bolha, 50)
conferir('clique na bolha recolhida expande', noGrande.bolha.classes.has('dct-expandida') && !noGrande.bolha.classes.has('dct-recolhida'), [...noGrande.bolha.classes])
clicar(noGrande.bolha, 50)
conferir('clique no meio da bolha aberta nao recolhe', noGrande.bolha.classes.has('dct-expandida'))
clicar(noGrande.bolha, 90)
conferir('clique no rodape da bolha aberta recolhe', noGrande.bolha.classes.has('dct-recolhida') && !noGrande.bolha.classes.has('dct-expandida'), [...noGrande.bolha.classes])
clicar(noCurto.bolha, 50)
conferir('clique em mensagem curta nao faz nada', !noCurto.bolha.classes.has('dct-expandida'))

// 16) no novo que chega depois (paginacao/rolagem) e pego pela varredura agendada
const noNovo = montarNoDoTranscrito('w'.repeat(4000))
conferir('no novo ainda nao esta marcado', !noNovo.bolha.classes.has('dct-bolha'))
observador.cb()
rodarTempo()
conferir('a varredura agendada marca o no novo', noNovo.bolha.classes.has('dct-recolhida'))

// 16b) a varredura adiada da montagem pega o transcrito que so aparece depois do
// apply, sem depender de nenhuma mutacao ter avisado (o script dos modulos roda
// no <head>, antes de existir transcrito na tela)
conferir('a montagem agenda a varredura no quadro e em 600ms', agendamentosDaMontagem.quadros >= 1 && agendamentosDaMontagem.timers >= 1, agendamentosDaMontagem)
const noTardio = montarNoDoTranscrito('t'.repeat(3000))
rodarQuadro()
rodarTempo()
conferir('a varredura adiada marca o no tardio', noTardio.bolha.classes.has('dct-recolhida'))

// 17) desligar so a compactacao do transcrito
armazem.set('dsh-colar-texto:transcricao', 'off')
const noDesligado = montarNoDoTranscrito('v'.repeat(4000))
observador.cb()
rodarTempo()
conferir('"transcricao=off" nao marca nada', !noDesligado.bolha.classes.has('dct-bolha'))
armazem.delete('dsh-colar-texto:transcricao')

// 18) limite proprio do transcrito
armazem.set('dsh-colar-texto:transcricao', '20')
const noLimite = montarNoDoTranscrito('u'.repeat(40))
observador.cb()
rodarTempo()
conferir('limite proprio do transcrito vale', noLimite.bolha.classes.has('dct-recolhida'))
armazem.delete('dsh-colar-texto:transcricao')

Promise.all([
  fonteRegistrada.codec.serialize(refA).then((t) => conferir('codec.serialize(refA) devolve o texto A', t === textoA, t?.length)),
  fonteRegistrada.codec.serialize(refB).then((t) => conferir('codec.serialize(refB) devolve o texto B', t === textoB, t?.length)),
  Promise.resolve().then(() =>
    conferir('codec.clipboardText(refA) devolve o texto A', fonteRegistrada.codec.clipboardText(refA) === textoA)
  ),
  fonteRegistrada.candidates().then((linhas) => conferir('candidates nao lista nada no menu', Array.isArray(linhas) && linhas.length === 0, linhas)),
  fonteRegistrada.codec.serialize('paste:inexistente').then((t) => conferir('ref desconhecido nao vira texto vazio', t === 'paste:inexistente', t))
]).then(() => {
  console.log(falhas === 0 ? '\nTODOS OS CASOS PASSARAM' : `\n${falhas} CASO(S) FALHARAM`)
  process.exit(falhas === 0 ? 0 : 1)
})
//#endregion
