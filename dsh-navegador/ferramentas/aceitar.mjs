/**
 * Aceitação do add-on `dsh-navegador` num comando só.
 *
 * Roda as verificações que existem, na ordem em que fazem sentido, e termina com um
 * veredito. Serve para duas coisas: o Ramses conferir a instalação depois de mexer
 * em algo, e eu ter um portão único antes de publicar.
 *
 * Uso:
 *   node aceitar.mjs            tudo
 *   node aceitar.mjs --rapido   pula a etapa que cria sessão de verdade (gasta token)
 *
 * Sai com código 0 só quando todas as etapas passam.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const ENDERECO = 'http://127.0.0.1:43129';
const RAPIDO = process.argv.includes('--rapido');

/** Roda um script da pasta de ferramentas herdando a saída, e devolve o código. */
function rodar(script, argumentos = []) {
  const resultado = spawnSync(process.execPath, [join(AQUI, script), ...argumentos], {
    stdio: 'inherit',
    cwd: AQUI,
  });
  return resultado.status ?? 1;
}

/** Título de etapa, para o log ficar legível. */
function etapa(indice, total, titulo) {
  console.log(`\n\x1b[1m[${indice}/${total}] ${titulo}\x1b[0m`);
}

/** A ponte responde? Devolve o `/ola` ou `null`. */
async function ola() {
  try {
    const resposta = await fetch(`${ENDERECO}/dsh-navegador/ola`, { signal: AbortSignal.timeout(2500) });
    if (!resposta.ok) return null;
    const dados = await resposta.json();
    return dados?.ok === true ? dados : null;
  } catch {
    return null;
  }
}

/** Versão declarada no pacote. */
function versaoDoPacote() {
  try {
    return JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')).version ?? 'desconhecida';
  } catch {
    return 'desconhecida';
  }
}

async function principal() {
  console.log('aceitação do add-on dsh-navegador');
  const info = await ola();
  const noDisco = versaoDoPacote();
  if (info === null) {
    console.log(`\n\x1b[33mAVISO\x1b[0m: a ponte não respondeu em ${ENDERECO}.`);
    console.log('Sem a ponte, as etapas que falam com o DSH são puladas. Abra o DSH e rode de novo.');
  }

  const etapas = [
    { titulo: 'conformidade estática da extensão', script: 'conferir-extensao.mjs', args: [] },
    { titulo: 'escolha da aba alvo (id, trecho e ambiguidade)', script: 'conferir-abas.mjs', args: [] },
    { titulo: 'quadros (iframe), rolagem e origem da cópia', script: 'testar-quadros.mjs', args: [] },
    { titulo: 'espera por aprovação e expiração dos pedidos', script: 'testar-pendencias.mjs', args: [] },
    { titulo: 'autoaprovação das ações (regra, armazenamento e fiação)', script: 'testar-autoaprovacao.mjs', args: [] },
    { titulo: 'Peer do gateway na ponte (DSH 0.12)', script: 'conferir-peer.mjs', args: [] },
    { titulo: 'projeção da aba no schema de saída', script: 'conferir-projecao-aba.mjs', args: [] },
    { titulo: 'projeção da pergunta respondível', script: 'conferir-pergunta-projecao.mjs', args: [] },
    { titulo: 'transcrito sintético', script: 'testar-transcrito.mjs', args: ['--sintetico'] },
  ];
  if (info !== null) {
    etapas.push({ titulo: 'diagnóstico da ponte', script: 'testar-ponte.mjs', args: ['diagnostico'] });
    etapas.push({ titulo: 'segurança da ponte', script: 'testar-ponte.mjs', args: ['seguranca'] });
    if (!RAPIDO) {
      etapas.push({ titulo: 'ponta a ponta (cria sessão, manda prompt, apaga)', script: 'testar-ponte.mjs', args: ['ponta-a-ponta'] });
      etapas.push({ titulo: 'transcrito com quadros reais', script: 'testar-transcrito.mjs', args: ['--meu'] });
    }
  }

  const falhas = [];
  const puladas = [];
  etapas.forEach((item, indice) => {
    etapa(indice + 1, etapas.length, item.titulo);
    const codigo = rodar(item.script, item.args);
    if (codigo !== 0) {
      falhas.push(item.titulo);
      console.log(`\x1b[31mETAPA FALHOU\x1b[0M (código ${codigo})`);
    }
  });
  if (info === null) puladas.push('tudo que depende da ponte');

  console.log('\n\x1b[1m== veredito ==\x1b[0m');
  const passaram = etapas.length - falhas.length;
  console.log(`${passaram} de ${etapas.length} etapa(s) passaram.`);
  for (const falha of falhas) console.log(`  \x1b[31mfalhou:\x1b[0m ${falha}`);
  for (const pulada of puladas) console.log(`  \x1b[33mpulado:\x1b[0m ${pulada}`);

  const pendencias = [];
  if (info !== null && info.ponte?.versao !== noDisco) {
    pendencias.push(
      `a ponte viva responde ${info.ponte?.versao} e o disco tem ${noDisco}: feche e reabra o DSH para a metade host nova entrar`,
    );
  }
  if (pendencias.length > 0) {
    console.log('\n\x1b[33mpendência(s)\x1b[0m');
    for (const pendencia of pendencias) console.log(`  - ${pendencia}`);
  }
  const ok = falhas.length === 0 && pendencias.length === 0;
  console.log(ok ? '\n\x1b[32mTUDO OK\x1b[0m' : falhas.length > 0 ? '\n\x1b[31mNAO PASSOU\x1b[0m' : '\n\x1b[33mPASSOU COM PENDÊNCIA\x1b[0m');
  process.exit(ok ? 0 : 1);
}

await principal();
