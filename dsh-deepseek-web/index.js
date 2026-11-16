/**
 * Metade host do dsh-deepseek-web.
 *
 * Nao ha trabalho de host aqui, e isso e de proposito: o botao e um link, e
 * quem abre o navegador e a propria casca Electron do DSH. Toda janela do app
 * passa por `secureWindow`, cujo `setWindowOpenHandler` manda qualquer http/https
 * que nao seja o servidor local para `shell.openExternal`, ou seja, para o
 * navegador padrao do Windows.
 *
 * Esta metade existe por um motivo mecanico: e a linha da composicao, com um
 * `apply`, que faz `dsh-client-modules` enxergar o pacote e publicar o `./client`
 * no manifesto da pagina. Sem ela o bundle de cliente nunca chega ao navegador.
 *
 * Nao ha rota, nao ha credencial e nao ha dado saindo daqui.
 */

/** Identifica a versao viva desta metade (confere se o reload do patch pegou). */
export const VERSAO = 1

/**
 * Corpo do plugin no host: nada a montar.
 */
export function apply() {}
