/**
 * Metade host do add-on `dsh-colar-texto`.
 *
 * O add-on inteiro vive no navegador: ele intercepta o `paste` no composer e
 * troca o texto grande por um chip do próprio editor (`ReferenceChipNode`), com
 * o texto completo no `clipboardText` do nó. Não há rota, credencial nem estado
 * no servidor.
 *
 * Esta metade existe por um motivo técnico: quem publica o bundle de cliente é
 * o `dsh-client-modules`, e ele só enxerga um pacote que aparece nas entradas
 * do Loader declarando `dsh.client` no `package.json`. Sem esta metade (mesmo
 * vazia) o `./client` não entra no manifesto da página e o plugin não carrega.
 *
 * Ela também deixa um rastro de boot em `%TEMP%\dsh-colar-texto.log`, que é o
 * único jeito de responder "a metade host subiu?" sem abrir o navegador. Se o
 * arquivo não ganha linha nova depois de reiniciar o DSH, o problema está no
 * carregamento do plugin, e não no comportamento do composer.
 */
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Rastro de boot (uma linha por montagem do plugin no host). */
const LOG = join(tmpdir(), 'dsh-colar-texto.log')

/**
 * Corpo do plugin no host. Não faz nada além de registrar que subiu: a
 * funcionalidade toda é do lado do navegador.
 * @param ctx - contexto do host (não usado).
 */
export function apply(ctx) {
  void ctx
  try {
    appendFileSync(LOG, `${new Date().toISOString()} metade host montada (pid ${process.pid})\n`)
  } catch {
    /* sem rastro não é motivo para falhar o carregamento */
  }
}

/** Nenhum serviço de host é necessário antes deste plugin subir. */
export const inject = []
