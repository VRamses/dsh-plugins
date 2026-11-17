/*
 * Configuração e utilidades compartilhadas entre o service worker e o painel.
 *
 * Tudo o que é estado do add-on mora em `chrome.storage.local`: a extensão é
 * recarregada muitas vezes (modo desenvolvedor) e o painel abre e fecha; perder
 * o token ou a conversa a cada vez seria inaceitável.
 */

/** Versão do protocolo que este add-on fala com a ponte. */
export const PROTOCOLO = 1;

/** Prefixo HTTP da ponte no servidor do DSH. */
export const BASE_PONTE = '/dsh-navegador';

/** Configuração inicial da ponte. */
export const PADRAO_PONTE = {
  baseUrl: 'http://127.0.0.1:43129',
  token: '',
};

/** Preferências de conversa. */
export const PADRAO_PREFERENCIAS = {
  /** Pasta de trabalho das sessões novas criadas pelo add-on. */
  cwd: '',
  /** Manda o texto da aba junto com a pergunta. */
  anexarAba: true,
  /** Manda também um print da aba. */
  anexarPrint: false,
  /** Preset de agente das sessões novas (vazio = o padrão do DSH). */
  preset: '',
  /** Modelo preferido, no formato `provider/model` (vazio = o do DSH). */
  modelo: '',
  /** Rola o transcrito sozinho enquanto a resposta chega. */
  rolarSozinho: true,
};

/** Chaves usadas em `chrome.storage.local`. */
export const CHAVES = {
  ponte: 'ponte',
  preferencias: 'preferencias',
  conversa: 'conversa',
  cache: 'cache-transcrito',
};

/** Lê um objeto do storage com os padrões por baixo. */
async function lerComPadrao(chave, padrao) {
  const bruto = await chrome.storage.local.get(chave);
  const valor = bruto?.[chave];
  return { ...padrao, ...(valor !== null && typeof valor === 'object' ? valor : {}) };
}

/** Configuração da ponte (endereço e token). */
export function lerPonte() {
  return lerComPadrao(CHAVES.ponte, PADRAO_PONTE);
}

/** Grava um pedaço da configuração da ponte. */
export async function salvarPonte(patch) {
  const atual = await lerPonte();
  const novo = { ...atual, ...patch };
  await chrome.storage.local.set({ [CHAVES.ponte]: novo });
  return novo;
}

/** Preferências de conversa. */
export function lerPreferencias() {
  return lerComPadrao(CHAVES.preferencias, PADRAO_PREFERENCIAS);
}

/** Grava um pedaço das preferências. */
export async function salvarPreferencias(patch) {
  const atual = await lerPreferencias();
  const novo = { ...atual, ...patch };
  await chrome.storage.local.set({ [CHAVES.preferencias]: novo });
  return novo;
}

/** Última conversa usada, para o painel reabrir onde parou. */
export async function lerConversa() {
  const bruto = await chrome.storage.local.get(CHAVES.conversa);
  const valor = bruto?.[CHAVES.conversa];
  return valor !== null && typeof valor === 'object' ? valor : { sessionId: null, titulo: '' };
}

/** Grava a conversa atual. */
export async function salvarConversa(patch) {
  const atual = await lerConversa();
  const novo = { ...atual, ...patch };
  await chrome.storage.local.set({ [CHAVES.conversa]: novo });
  return novo;
}

/** Chave da autoaprovação no armazenamento da sessão do navegador. */
export const CHAVE_AUTO_APROVAR = 'auto-aprovar';

/** Valor da autoaprovação quando ninguém escolheu nada. */
export const AUTO_APROVAR_PADRAO = { ligado: false, sessionId: null, desde: 0 };

/**
 * Onde a autoaprovação mora.
 *
 * `chrome.storage.session` de propósito: morre quando o navegador fecha, então a
 * escolha não vira um "sempre permitir" esquecido por semanas. O `local` é só a
 * rede de segurança de um Chromium antigo (a API existe desde o Chrome 102).
 */
function areaDaAuto() {
  return globalThis.chrome?.storage?.session ?? globalThis.chrome?.storage?.local;
}

/**
 * A autoaprovação vale para esta conversa?
 *
 * A escolha é presa à conversa do DSH em que foi ligada: trocar de conversa no
 * painel volta a perguntar. Sem conversa na hora de ligar (`sessionId` nulo), a
 * primeira que abrir adota a escolha.
 *
 * @param guardado - o que veio do armazenamento.
 * @param sessaoAtual - id da conversa aberta no painel, ou `null`.
 * @returns `true` quando as ações podem rodar sem cartão de aprovação.
 */
export function autoValePara(guardado, sessaoAtual) {
  if (guardado?.ligado !== true) return false;
  if (guardado.sessionId === null || guardado.sessionId === undefined) return true;
  return guardado.sessionId === sessaoAtual;
}

/** Lê a autoaprovação guardada. */
export async function lerAutoAprovar() {
  const area = areaDaAuto();
  if (area === undefined) return { ...AUTO_APROVAR_PADRAO };
  const bruto = await area.get(CHAVE_AUTO_APROVAR);
  const valor = bruto?.[CHAVE_AUTO_APROVAR];
  if (valor === null || typeof valor !== 'object') return { ...AUTO_APROVAR_PADRAO };
  return {
    ligado: valor.ligado === true,
    sessionId: typeof valor.sessionId === 'string' && valor.sessionId !== '' ? valor.sessionId : null,
    desde: Number.isFinite(valor.desde) ? valor.desde : 0,
  };
}

/**
 * Grava a autoaprovação. Desligar apaga a chave, para não sobrar `ligado: false`.
 * @param estado - `{ ligado, sessionId }`.
 */
export async function salvarAutoAprovar(estado) {
  const area = areaDaAuto();
  if (area === undefined) return;
  if (estado?.ligado !== true) {
    await area.remove(CHAVE_AUTO_APROVAR);
    return;
  }
  await area.set({
    [CHAVE_AUTO_APROVAR]: {
      ligado: true,
      sessionId: typeof estado.sessionId === 'string' && estado.sessionId !== '' ? estado.sessionId : null,
      desde: Date.now(),
    },
  });
}

/** Chave da aba fixada no painel. */
export const CHAVE_ABA_FIXADA = 'aba-fixada';

/**
 * Armazenamento usado para o que é "desta sessão do navegador".
 *
 * `chrome.storage.session` quando existe (Chrome 102+), senão `local`: o painel
 * pode ser recarregado muitas vezes por dia e a aba fixada não deve se perder no
 * meio, mas também não deve virar preferência permanente que sobrevive a semanas.
 */
function areaDaSessao() {
  return globalThis.chrome?.storage?.session ?? globalThis.chrome?.storage?.local;
}

/**
 * Lê a aba fixada guardada.
 *
 * Desde 04/11/2026 o painel lembra qual aba ele estava fixando: abrir a barra
 * lateral de novo não deve devolver a fixação para a aba ativa por acaso. Se a
 * aba não existir mais, quem chama confere e cai na ativa.
 * @returns `{id, url, titulo, janela}` ou `null`.
 */
export async function lerAbaFixada() {
  const area = areaDaSessao();
  if (area === undefined) return null;
  try {
    const bruto = await area.get(CHAVE_ABA_FIXADA);
    const valor = bruto?.[CHAVE_ABA_FIXADA];
    if (valor === null || typeof valor !== 'object') return null;
    if (!Number.isSafeInteger(valor.id)) return null;
    return {
      id: valor.id,
      url: typeof valor.url === 'string' ? valor.url : '',
      titulo: typeof valor.titulo === 'string' ? valor.titulo : '',
      janela: Number.isSafeInteger(valor.janela) ? valor.janela : null,
    };
  } catch {
    return null;
  }
}

/** Grava a aba fixada; `null` apaga. */
export async function salvarAbaFixada(aba) {
  const area = areaDaSessao();
  if (area === undefined) return;
  if (aba === null || aba === undefined) {
    await area.remove(CHAVE_ABA_FIXADA);
    return;
  }
  await area.set({
    [CHAVE_ABA_FIXADA]: {
      id: aba.id,
      url: typeof aba.url === 'string' ? aba.url : '',
      titulo: typeof aba.titulo === 'string' ? aba.titulo : '',
      janela: Number.isSafeInteger(aba.janela) ? aba.janela : Number.isSafeInteger(aba.janelaId) ? aba.janelaId : null,
    },
  });
}

/**
 * Aceita o que o usuário digitar como endereço da ponte.
 * `127.0.0.1:43129`, `http://127.0.0.1:43129/`, `localhost:43129` viram todos
 * `http://127.0.0.1:43129`.
 * @param texto - texto cru.
 * @returns endereço normalizado, sem barra no fim.
 */
export function normalizarBase(texto) {
  let valor = String(texto ?? '').trim();
  if (valor === '') return PADRAO_PONTE.baseUrl;
  if (!/^https?:\/\//i.test(valor)) valor = `http://${valor}`;
  try {
    const url = new URL(valor);
    const porta = url.port === '' ? '' : `:${url.port}`;
    return `${url.protocol}//${url.hostname}${porta}`;
  } catch {
    return PADRAO_PONTE.baseUrl;
  }
}

/** Monta uma URL da ponte. */
export function urlPonte(baseUrl, caminho) {
  return `${normalizarBase(baseUrl)}${BASE_PONTE}${caminho}`;
}

/** Endereços candidatos, na ordem em que vale a pena tentar. */
export function candidatosBase(configurada) {
  const lista = [normalizarBase(configurada), 'http://127.0.0.1:43129', 'http://127.0.0.1:43130', 'http://127.0.0.1:43128', 'http://localhost:43129'];
  return [...new Set(lista)];
}

/**
 * Endereços locais das abas abertas, que valem uma sonda.
 *
 * A lista fixa de portas envelhece: o DSH escolhe a porta do servidor web na
 * subida e ela muda quando o app reinicia ou atualiza (medido em 17/11/2026 no
 * notebook: a ponte passou da 43129 para a 59293 depois da atualização para a
 * 0.14.0 e o painel ficou em `Failed to fetch`, sem achar nada). A aba do
 * próprio DSH entrega a porta viva de graça.
 *
 * @returns origens `http(s)://host:porta` sem repetição, ou `[]`.
 */
export async function candidatosDasAbas() {
  const abas = globalThis.chrome?.tabs;
  if (typeof abas?.query !== 'function') return [];
  let lista;
  try {
    lista = await abas.query({});
  } catch {
    return [];
  }
  const origens = [];
  for (const aba of lista ?? []) {
    try {
      const url = new URL(String(aba?.url ?? ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname)) continue;
      origens.push(`${url.protocol}//${url.hostname}${url.port === '' ? '' : `:${url.port}`}`);
    } catch {
      /* aba sem URL legível: ignora */
    }
  }
  return [...new Set(origens)];
}

/**
 * Procura uma ponte viva.
 * @param configurada - endereço configurado, tentado primeiro.
 * @param tempoLimiteMs - prazo de cada tentativa.
 * @returns o estado devolvido pelo `/ola`, ou `null`.
 */
export async function descobrirPonte(configurada, tempoLimiteMs = 1200) {
  const lista = [...new Set([...candidatosBase(configurada), ...(await candidatosDasAbas())])];
  const sonda = async (base) => {
    const resposta = await fetch(urlPonte(base, '/ola'), { signal: AbortSignal.timeout(tempoLimiteMs), cache: 'no-store' });
    if (!resposta.ok) return null;
    const dados = await resposta.json();
    if (dados?.ok === true && dados?.protocolo === PROTOCOLO) return { ...dados, baseUrl: base };
    return null;
  };
  const achados = await Promise.all(lista.map((base) => sonda(base).catch(() => null)));
  return achados.find((achado) => achado !== null) ?? null;
}

/** Formata um horário curto para o painel. */
export function horaCurta(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Formata um número de tokens de forma legível. */
export function tokens(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
