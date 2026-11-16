/**
 * Área de transferência pelo HOST, como último recurso.
 *
 * Existe porque clique sintético não conta como ativação de usuário: quando o
 * agente pede para copiar, `navigator.clipboard` pode recusar mesmo na página da
 * extensão. A ordem do add-on é: painel (API do clipboard com a permissão da
 * extensão), painel por `execCommand`, e por fim o host, que escreve na área de
 * transferência do Windows pela `Set-Clipboard` do PowerShell. É a mesma área de
 * transferência da sessão do usuário, que é onde o Chrome está rodando.
 *
 * O texto vai por STDIN, nunca por argv: acento, quebra de linha e `$` no
 * conteúdo morrem em argumento de linha de comando.
 *
 * @module dsh-navegador/plugin/transferencia
 */

import { spawn } from 'node:child_process';

/** Teto de tamanho do texto copiado pelo host (igual ao do painel). */
const TETO_TEXTO = 200_000;

/**
 * Roda um script do PowerShell sem janela, com o texto na entrada padrão.
 * @param script - script win32; recebe o texto em `[Console]::In.ReadToEnd()`.
 * @param texto - conteúdo a enviar na entrada padrão, em UTF-8.
 * @returns `{ok, saida, erro}`.
 */
function rodarPowerShell(script, texto) {
  return new Promise((resolve) => {
    let processo;
    try {
      processo = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (erro) {
      resolve({ ok: false, erro: String(erro?.message ?? erro) });
      return;
    }
    let saida = '';
    let erro = '';
    const prazo = setTimeout(() => {
      try {
        processo.kill();
      } catch {
        /* já saiu */
      }
      resolve({ ok: false, erro: 'o PowerShell nao respondeu em 10s' });
    }, 10_000);
    prazo.unref?.();
    processo.stdout?.on('data', (pedaco) => {
      saida += String(pedaco);
    });
    processo.stderr?.on('data', (pedaco) => {
      erro += String(pedaco);
    });
    processo.on('error', (falha) => {
      clearTimeout(prazo);
      resolve({ ok: false, erro: String(falha?.message ?? falha) });
    });
    processo.on('close', (codigo) => {
      clearTimeout(prazo);
      resolve({ ok: codigo === 0, saida, erro: erro.trim() || (codigo === 0 ? '' : `codigo ${codigo}`) });
    });
    try {
      processo.stdin?.end(String(texto ?? ''), 'utf8');
    } catch (falha) {
      clearTimeout(prazo);
      resolve({ ok: false, erro: String(falha?.message ?? falha) });
    }
  });
}

/**
 * Escreve o texto na área de transferência do sistema.
 * @param texto - conteúdo a copiar.
 * @returns `{ok, metodo, erro}`.
 */
export async function copiarTextoHost(texto) {
  const valor = String(texto ?? '');
  if (valor === '') return { ok: false, erro: 'nada para copiar' };
  if (valor.length > TETO_TEXTO) return { ok: false, erro: `texto acima do teto de ${TETO_TEXTO} caracteres` };
  const script =
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
    '$texto = [Console]::In.ReadToEnd(); ' +
    'if ([string]::IsNullOrEmpty($texto)) { exit 2 }; ' +
    'Set-Clipboard -Value $texto';
  const resultado = await rodarPowerShell(script, valor);
  if (resultado.ok !== true) {
    return { ok: false, erro: resultado.erro || 'a Set-Clipboard falhou' };
  }
  return { ok: true, metodo: 'host-set-clipboard' };
}

/**
 * Lê a área de transferência do sistema (diagnóstico e conferência).
 * @returns `{ok, texto, erro}`.
 */
export async function lerTextoHost() {
  const script =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'Get-Clipboard -Raw';
  const resultado = await rodarPowerShell(script, '');
  if (resultado.ok !== true) return { ok: false, erro: resultado.erro || 'a Get-Clipboard falhou' };
  return { ok: true, texto: String(resultado.saida ?? '').replace(/\r\n$/, '') };
}
