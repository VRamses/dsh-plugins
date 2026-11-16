/*
 * Markdown mínimo e seguro para o painel.
 *
 * Escapa TUDO primeiro e só depois aplica as transformações, então nenhum texto
 * do modelo, da página ou do usuário consegue injetar HTML. O conjunto é pequeno
 * de propósito: o que o DSH escreve cabe em parágrafo, título, lista, código,
 * citação, link, tabela simples e negrito/itálico.
 *
 * Não há dependência externa: o painel tem de carregar sem rede.
 */

/** Escapa os caracteres que teriam significado em HTML. */
export function escapar(texto) {
  return String(texto ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Aplica o markdown e devolve HTML pronto para `innerHTML`. Recebe texto CRU. */
export function paraHtml(markdown) {
  const linhas = String(markdown ?? '').replaceAll('\r\n', '\n').split('\n');
  const saida = [];
  let i = 0;

  while (i < linhas.length) {
    const linha = linhas[i];

    // bloco de código cercado
    const cerca = /^\s*(```| -  -  - )\s*([A-Za-z0-9+#._-]*)\s*$/.exec(linha);
    if (cerca !== null) {
      const marca = cerca[1];
      const linguagem = cerca[2];
      const corpo = [];
      i += 1;
      while (i < linhas.length && !linhas[i].trimStart().startsWith(marca)) {
        corpo.push(linhas[i]);
        i += 1;
      }
      i += 1;
      saida.push(`<pre><code${linguagem === '' ? '' : ` class="ling-${escapar(linguagem)}"`}>${escapar(corpo.join('\n'))}</code></pre>`);
      continue;
    }

    // tabela simples: linha com pipes seguida de separadora
    if (/^\s*\|.*\|\s*$/.test(linha) && i + 1 < linhas.length && /^\s*\|[\s:|-]+\|\s*$/.test(linhas[i + 1])) {
      const cabecalho = celulas(linha);
      i += 2;
      const corpo = [];
      while (i < linhas.length && /^\s*\|.*\|\s*$/.test(linhas[i])) {
        corpo.push(celulas(linhas[i]));
        i += 1;
      }
      const th = cabecalho.map((c) => `<th>${linhaInline(escapar(c))}</th>`).join('');
      const tr = corpo.map((linha) => `<tr>${linha.map((c) => `<td>${linhaInline(escapar(c))}</td>`).join('')}</tr>`).join('');
      saida.push(`<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`);
      continue;
    }

    if (linha.trim() === '') {
      i += 1;
      continue;
    }

    const titulo = /^(#{1,6})\s+(.*)$/.exec(linha);
    if (titulo !== null) {
      const nivel = Math.min(titulo[1].length + 2, 6);
      saida.push(`<h${nivel}>${linhaInline(escapar(titulo[2]))}</h${nivel}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(linha)) {
      saida.push('<hr>');
      i += 1;
      continue;
    }

    const marcador = /^\s*([-*+]|\d+[.)])\s+/.exec(linha);
    if (marcador !== null) {
      const ordenada = /\d/.test(marcador[1]);
      const itens = [];
      while (i < linhas.length) {
        const atual = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(linhas[i]);
        if (atual === null) break;
        itens.push(`<li>${linhaInline(escapar(atual[2]))}</li>`);
        i += 1;
      }
      saida.push(`<${ordenada ? 'ol' : 'ul'}>${itens.join('')}</${ordenada ? 'ol' : 'ul'}>`);
      continue;
    }

    if (/^\s*>\s?/.test(linha)) {
      const citadas = [];
      while (i < linhas.length && /^\s*>\s?/.test(linhas[i])) {
        citadas.push(linhas[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      saida.push(`<blockquote>${linhaInline(escapar(citadas.join('\n'))).replaceAll('\n', '<br>')}</blockquote>`);
      continue;
    }

    // parágrafo: junta linhas até uma vazia ou outro bloco, preservando a quebra
    const paragrafo = [];
    while (i < linhas.length) {
      const atual = linhas[i];
      if (atual.trim() === '') break;
      if (/^\s*(```| -  -  - )/.test(atual)) break;
      if (/^\s*([-*+]|\d+[.)])\s+/.test(atual)) break;
      if (/^\s*>/.test(atual)) break;
      if (/^\s*\|.*\|\s*$/.test(atual) && i + 1 < linhas.length && /^\s*\|[\s:|-]+\|\s*$/.test(linhas[i + 1])) break;
      if (/^#{1,6}\s+/.test(atual)) break;
      paragrafo.push(atual);
      i += 1;
    }
    saida.push(`<p>${linhaInline(escapar(paragrafo.join('\n'))).replaceAll('\n', '<br>')}</p>`);
  }

  return saida.join('');
}

function celulas(linha) {
  return linha
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Transformações dentro de uma linha.
 *
 * O texto entra JÁ ESCAPADO pelo chamador. Trechos de código são isolados em
 * marcadores antes do resto para que negrito, link e itálico não entrem dentro
 * de `code`.
 */
function linhaInline(textoEscapado) {
  const guardados = [];
  let texto = String(textoEscapado).replace(/`([^`]+)`/g, (_m, conteudo) => {
    guardados.push(`<code>${conteudo}</code>`);
    return `\u0000${guardados.length - 1}\u0000`;
  });

  texto = texto
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)"']+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>');

  return texto.replace(/\u0000(\d+)\u0000/g, (_m, indice) => guardados[Number(indice)] ?? '');
}

/**
 * Atalho com o nome que o painel usa. O escape acontece dentro de `paraHtml`,
 * então não há escape duplo.
 * @param texto - markdown cru.
 */
export function markdown(texto) {
  return paraHtml(texto);
}
