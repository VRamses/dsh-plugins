/*
 * Leitor dos descritores do Remote do DSH, direto de dentro do app.asar.
 *
 * Existe como módulo (e não dentro de um script) porque duas ferramentas precisam
 * da mesma leitura: `mapear-endpoints.mjs` (mostra ao humano) e
 * `conferir-envelope.mjs` (confere a tabela de envelope do painel contra a versão
 * instalada). Duplicar o parser já custou uma rodada: em 21/10/2026 o leitor
 * antigo devolvia "0 endpoints" porque o DSH Desktop 0.12 trocou o formato do
 * descritor, e o script não avisava.
 *
 * Formatos aceitos:
 *   - 0.11: `invocations: [ { namespace: 'x', method: 'y', parameters: [...] } ]`;
 *   - 0.12: um mapa, `'x/y': { service, scope, mode, parameters, invocation }`.
 *
 * @module dsh-navegador/ferramentas/descritores
 */

import fs from 'node:fs';

/*
 * O node do DSH Desktop é o do Electron (`ELECTRON_RUN_AS_NODE`), e ele embrulha
 * o `fs` para tratar caminhos dentro de `.asar`. Sem isto, `openSync('...\app.asar')`
 * é interpretado como "abrir app.asar DENTRO de um arquivo asar" e falha com
 * `ENOENT, not found in ...app.asar` (medido em 21/10/2026).
 */
process.noAsar = true;

/** Caminho do asar do DSH Desktop instalado. */
export const ASAR_PADRAO = 'C:\\Program Files\\DSH Desktop\\resources\\app.asar';

function lerCabecalho(caminho) {
  const fd = fs.openSync(caminho, 'r');
  try {
    const cabecalho = Buffer.alloc(16);
    fs.readSync(fd, cabecalho, 0, 16, 0);
    // 0..3 tamanho do pickle do cabeçalho, 8..11 bytes do pickle (4 + json),
    // 12..15 tamanho do JSON, 16.. JSON, e os dados em 8 + pickle.
    const tamanhoPickle = cabecalho.readUInt32LE(8);
    const tamanhoJson = cabecalho.readUInt32LE(12);
    const json = Buffer.alloc(tamanhoJson);
    fs.readSync(fd, json, 0, tamanhoJson, 16);
    return { arvore: JSON.parse(json.toString('utf8')), base: 8 + tamanhoPickle };
  } finally {
    fs.closeSync(fd);
  }
}

function listarArquivos(no, prefixo, saida) {
  for (const [nome, filho] of Object.entries(no.files ?? {})) {
    const caminho = prefixo === '' ? nome : `${prefixo}/${nome}`;
    if (filho.files) listarArquivos(filho, caminho, saida);
    else {
      // O cabeçalho do asar guarda `offset` como STRING; somar string com número
      // concatena, e o `readSync` recebe uma posição absurda.
      const bruto = filho.offset;
      saida.push({
        caminho,
        tamanho: filho.size ?? 0,
        deslocamento: bruto === null || bruto === undefined ? null : Number(bruto),
        solto: filho.unpacked === true,
      });
    }
  }
}

/** Devolve o trecho entre `[` e o `]` correspondente, respeitando aninhamento. */
function dentroDeColchetes(texto, inicio) {
  const abre = texto.indexOf('[', inicio);
  if (abre < 0) return '';
  let profundidade = 0;
  for (let i = abre; i < texto.length; i += 1) {
    if (texto[i] === '[') profundidade += 1;
    else if (texto[i] === ']') {
      profundidade -= 1;
      if (profundidade === 0) return texto.slice(abre + 1, i);
    }
  }
  return texto.slice(abre + 1);
}

/**
 * Devolve o objeto `{ ... }` que começa depois de `inicio`, com o `}` que fecha.
 *
 * Cortar o bloco pela PRÓXIMA chave de endpoint não serve: o `mode: 'stream'` de
 * um descritor seguinte entra no trecho do anterior e mente o modo (medido em
 * 21/10/2026: `skills/list` aparecia como stream).
 */
function blocoDeChaves(texto, inicio) {
  const abre = texto.indexOf('{', inicio);
  if (abre < 0) return '';
  let profundidade = 0;
  for (let i = abre; i < texto.length; i += 1) {
    if (texto[i] === '{') profundidade += 1;
    else if (texto[i] === '}') {
      profundidade -= 1;
      if (profundidade === 0) return texto.slice(abre, i + 1);
    }
  }
  return texto.slice(abre);
}

/** Separa o bloco em entradas de primeiro nível (cada `{ ... }`). */
function entradas(bloco) {
  const lista = [];
  let profundidade = 0;
  let inicio = -1;
  for (let i = 0; i < bloco.length; i += 1) {
    const c = bloco[i];
    if (c === '{') {
      if (profundidade === 0) inicio = i;
      profundidade += 1;
    } else if (c === '}') {
      profundidade -= 1;
      if (profundidade === 0 && inicio >= 0) {
        lista.push(bloco.slice(inicio, i + 1));
        inicio = -1;
      }
    }
  }
  return lista;
}

/** Lê `name`/`wire`/`source` de cada entrada de `parameters` de um descritor. */
function chavesDoDescritor(bloco) {
  const inicio = bloco.indexOf('parameters: [');
  if (inicio < 0) return [];
  return entradas(dentroDeColchetes(bloco, inicio)).map((p) => {
    const nome = /name:\s*['"]([^'"]+)['"]/.exec(p)?.[1] ?? '?';
    // `wire` é opcional: quando não vem, a chave no fio é o próprio `name`
    // (medido em 21/10/2026: `session/list` declara name `_request` sem wire).
    const fio = /wire:\s*['"]([^'"]+)['"]/.exec(p)?.[1] ?? nome;
    return { nome, fio, origem: /source:\s*['"]([^'"]+)['"]/.exec(p)?.[1] ?? '?' };
  });
}

/** Formato 0.11: `invocations: [ { namespace, method, parameters } ]`. */
function formatoInvocations(texto) {
  const inicio = texto.indexOf('invocations: [');
  if (inicio < 0) return null;
  const achados = [];
  for (const entrada of entradas(dentroDeColchetes(texto, inicio))) {
    const namespace = /namespace:\s*['"]([^'"]+)['"]/.exec(entrada)?.[1];
    const method = /method:\s*['"]([^'"]+)['"]/.exec(entrada)?.[1];
    if (namespace === undefined || method === undefined) continue;
    achados.push({
      endpoint: `${namespace}/${method}`,
      modo: /mode:\s*['"]stream['"]/.test(entrada) ? 'stream' : 'unario',
      chaves: chavesDoDescritor(entrada),
    });
  }
  return achados.length > 0 ? achados : null;
}

/** Formato 0.12: mapa `'namespace/metodo': { scope, mode, parameters, invocation }`. */
function formatoMapa(texto) {
  const regex = /['"]([A-Za-z0-9_$]+)\/([A-Za-z0-9_$]+)['"]\s*:\s*\{/g;
  const marcas = [];
  let m;
  while ((m = regex.exec(texto)) !== null) {
    marcas.push({ abre: m.index + m[0].length - 1, endpoint: `${m[1]}/${m[2]}` });
  }
  if (marcas.length === 0) return null;
  const achados = [];
  for (const marca of marcas) {
    const bloco = blocoDeChaves(texto, marca.abre);
    if (bloco === '') continue;
    const chaves = chavesDoDescritor(bloco);
    // O `scope` também é argumento no fio (`{ context: 'agent', wire: 'agentId' }`).
    const escopo = /scope:\s*\{[^}]*wire:\s*['"]([^'"]+)['"]/.exec(bloco)?.[1];
    if (escopo !== undefined && !chaves.some((c) => c.fio === escopo)) {
      chaves.unshift({ nome: escopo, fio: escopo, origem: 'escopo' });
    }
    achados.push({
      endpoint: marca.endpoint,
      // O modo fica no descritor, não no `invocation` (medido em 21/10/2026:
      // `session/follow` tem `mode: 'stream'` e `invocation: { kind: 'direct' }`).
      modo: /mode:\s*['"]stream['"]/.test(bloco) ? 'stream' : 'unario',
      chaves,
    });
  }
  return achados;
}

/**
 * Lê todos os descritores do asar.
 * @param opções - `asar` (caminho) e `filtros` (substrings de endpoint).
 * @returns `{ versao, endpoints, formatos }`.
 */
export function lerDescritores(opcoes = {}) {
  const asar = opcoes.asar ?? ASAR_PADRAO;
  const filtros = opcoes.filtros ?? [];
  const { arvore, base } = lerCabecalho(asar);
  const arquivos = [];
  listarArquivos(arvore, '', arquivos);

  const versao = lerVersao(asar, arvore, base);
  const alvos = arquivos.filter(
    (f) => f.caminho.endsWith('typert.host.js') && !f.solto && f.deslocamento !== null && f.tamanho <= 8_000_000,
  );

  const fd = fs.openSync(asar, 'r');
  const endpoints = [];
  const formatos = new Set();
  try {
    for (const arquivo of alvos) {
      const buffer = Buffer.alloc(arquivo.tamanho);
      fs.readSync(fd, buffer, 0, arquivo.tamanho, base + arquivo.deslocamento);
      const texto = buffer.toString('utf8');
      const mapa = formatoMapa(texto);
      const invocacoes = mapa === null ? formatoInvocations(texto) : null;
      if (mapa !== null) formatos.add('mapa (0.12)');
      else if (invocacoes !== null) formatos.add('invocations (0.11)');
      for (const item of mapa ?? invocacoes ?? []) {
        if (filtros.length > 0 && !filtros.some((f) => item.endpoint.includes(f))) continue;
        endpoints.push({ ...item, pacote: arquivo.caminho.split('/')[1] ?? arquivo.caminho });
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return { versao, endpoints, formatos: [...formatos] };
}

/** Versão do DSH Desktop, lida do `package.json` da raiz do asar. */
function lerVersao(asar, arvore, base) {
  const entrada = arvore.files?.['package.json'];
  if (entrada === undefined || typeof entrada.offset === 'undefined') return 'desconhecida';
  try {
    const fd = fs.openSync(asar, 'r');
    try {
      const buffer = Buffer.alloc(entrada.size);
      fs.readSync(fd, buffer, 0, entrada.size, base + Number(entrada.offset));
      const texto = buffer.toString('utf8');
      /*
       * Não dá para confiar no recorte: em 21/10/2026 a entrada de `package.json`
       * vinha com 4 bytes do arquivo anterior na frente e o `size` do cabeçalho
       * cortava o fim do JSON (13712 bytes, JSON.truncado). O `JSON.parse` cru
       * falhava; a versão sai por regex, que não depende do alinhamento.
       */
      const casado = /"name"\s*:\s*"dsh-desktop"[\s\S]{0,400}?"version"\s*:\s*"([^"]+)"/.exec(texto);
      return casado?.[1] ?? 'desconhecida';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'desconhecida';
  }
}
