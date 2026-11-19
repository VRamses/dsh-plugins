/**
 * `dsh-navegador` - porta fixa do painel.
 *
 * O DSH Desktop sorteia a porta do servidor web a cada boot (medido em 17 e
 * 19/11/2026: 43129, 59293 e 49391 na mesma máquina), e o painel do add-on não
 * tem como descobri-la: o endereço fica no `ponte.json` do harness, que um
 * navegador não abre, e a descoberta por origem de aba não alcança a GUI, que
 * roda no WebView2 do próprio app.
 *
 * Este módulo abre uma segunda escuta, em porta conhecida, e repassa byte a byte
 * para a porta viva do DSH. Como ele mora dentro do processo do harness, a
 * escuta nasce e morre junto com a ponte: não há processo auxiliar para manter
 * vivo, nem serviço para ressuscitar depois que o instalador do DSH mata tudo
 * que se chama `DSH Desktop.exe`.
 *
 * O que ele NÃO é: um servidor HTTP. Não interpreta pedido, não reescreve
 * cabeçalho e não conhece token. Toda a decisão continua nas rotas da metade
 * host, que recebem a conexão como se o painel tivesse falado direto com elas
 * (o `Host` continua `127.0.0.1:<porta fixa>`, que é loopback, então as cercas
 * de `auth.js` valem igual).
 *
 * A porta fixa é ocupada de propósito quando outro processo já a está servindo,
 * como a ferramenta externa `ferramentas/navegador-porta-fixa` das máquinas do
 * Ramses: em vez de brigar, espera e assume sozinho quando ela ficar livre.
 *
 * @module dsh-navegador/porta-fixa
 */

import { connect, createServer } from 'node:net';

/** Porta em que o painel procura a ponte quando não tem endereço salvo. */
export const PORTA_PADRAO = 43129;

/** Espera entre tentativas enquanto a porta estiver ocupada. */
const ESPERA_PADRAO_MS = 10_000;

/**
 * Abre a escuta fixa e a mantém viva.
 *
 * @param opcoes - opções da escuta.
 * @param opcoes.porta - porta conhecida pelo painel.
 * @param opcoes.destino - devolve a porta viva do DSH; é lido a cada conexão, não uma vez só.
 * @param opcoes.log - `(nivel, mensagem) => void`, com `info`, `warn` ou `debug`.
 * @param opcoes.esperaMs - espera entre tentativas com a porta ocupada.
 * @param opcoes.aoMudar - chamado com o retrato a cada mudança de estado; é por aqui que o `ponte.json` acompanha a escuta que só conseguiu a porta depois do boot.
 * @returns o identificador da escuta, com `fechar()` e `estado()`.
 */
export function abrirPortaFixa({ porta, destino, log = () => {}, esperaMs = ESPERA_PADRAO_MS, aoMudar = () => {} }) {
  /** Conexões em andamento, para poder cortar todas ao fechar. */
  const abertas = new Set();
  const retrato = { ativa: false, porta, motivo: 'subindo', conexoes: 0, destino: null };
  let servidor = null;
  let espera = null;
  let fechada = false;
  let avisouOcupada = false;

  /**
   * Registra o motivo num lugar só, para o `/ola` e o log contarem a mesma história.
   * @param motivo - estado legível.
   * @param nivel - nível do log.
   */
  function anotar(motivo, nivel = 'info') {
    retrato.motivo = motivo;
    log(nivel, `porta fixa ${porta}: ${motivo}`);
  }

  /**
   * Avisa quem acompanha a escuta, sem deixar erro de terceiro derrubar o relay.
   *
   * Existe porque o retrato em disco é escrito no boot, quando a porta ainda pode
   * estar ocupada: sem este aviso o `ponte.json` diria para sempre o que era
   * verdade nos primeiros milissegundos, e um diagnóstico futuro leria mentira.
   */
  function avisar() {
    try {
      aoMudar({ ...retrato });
    } catch (erro) {
      log('debug', `porta fixa ${porta}: o aviso de estado falhou: ${erro?.message ?? erro}`);
    }
  }

  /**
   * Responde 502 no lugar de uma conexão morta.
   *
   * O painel precisa de resposta HTTP para mostrar erro; conexão recusada vira
   * `Failed to fetch` sem causa, que foi exatamente a mensagem que custou horas
   * de diagnóstico em 19/11/2026.
   *
   * @param cliente - soquete do painel.
   * @param alvo - porta que não atendeu.
   * @param erro - causa.
   */
  function responderSemAlvo(cliente, alvo, erro) {
    if (cliente.destroyed || cliente.writableEnded) return;
    const detalhe = erro?.code ?? erro?.message ?? erro;
    const corpo = JSON.stringify({ ok: false, erro: `a ponte do DSH nao respondeu em 127.0.0.1:${alvo} (${detalhe})` });
    try {
      cliente.end(
        `HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json; charset=utf-8\r\n` +
          `content-length: ${Buffer.byteLength(corpo)}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n${corpo}`,
      );
    } catch {
      cliente.destroy();
    }
  }

  /**
   * Liga uma conexão do painel ao DSH.
   * @param cliente - soquete aceito na porta fixa.
   */
  function atender(cliente) {
    cliente.setNoDelay?.(true);
    retrato.conexoes += 1;
    const alvo = destino();
    if (!Number.isSafeInteger(alvo) || alvo <= 0) {
      anotar('sem porta viva do DSH para repassar', 'warn');
      responderSemAlvo(cliente, alvo, 'porta desconhecida');
      return;
    }
    const remoto = connect({ host: '127.0.0.1', port: alvo });
    remoto.setNoDelay?.(true);
    abertas.add(cliente);
    abertas.add(remoto);

    remoto.once('connect', () => {
      retrato.destino = alvo;
      cliente.pipe(remoto);
      remoto.pipe(cliente);
    });
    remoto.on('error', (erro) => {
      abertas.delete(remoto);
      responderSemAlvo(cliente, alvo, erro);
      log('debug', `porta fixa ${porta}: conexao para 127.0.0.1:${alvo} falhou: ${erro?.code ?? erro?.message ?? erro}`);
    });
    cliente.on('error', () => {
      abertas.delete(cliente);
      remoto.destroy();
    });
    cliente.on('close', () => {
      abertas.delete(cliente);
      remoto.destroy();
    });
    remoto.on('close', () => {
      abertas.delete(remoto);
      // `end` e não `destroy`: quando quem fecha é o DSH, o que ele mandou
      // ainda está no buffer e precisa sair antes do FIN.
      if (!cliente.destroyed) cliente.end();
    });
  }

  /** Agenda a próxima tentativa, uma só por vez. */
  function agendar() {
    if (fechada || espera !== null) return;
    espera = setTimeout(tentar, esperaMs);
    espera.unref?.();
  }

  /** Tenta escutar; se a porta estiver ocupada, tenta de novo depois. */
  function tentar() {
    espera = null;
    if (fechada) return;
    const s = createServer(atender);
    s.once('error', (erro) => {
      s.close(() => {});
      servidor = null;
      retrato.ativa = false;
      if (erro?.code === 'EADDRINUSE') {
        // Um aviso por sequência: esta é a situação normal enquanto a ferramenta
        // externa da máquina ainda estiver de pé, e repetir a cada 10 s polui o log.
        if (!avisouOcupada) {
          avisouOcupada = true;
          const intervalo = esperaMs >= 1000 ? `${Math.round(esperaMs / 1000)}s` : `${esperaMs}ms`;
          anotar(`ocupada por outro processo; assumo quando liberar (tentativa a cada ${intervalo})`, 'warn');
        } else {
          retrato.motivo = 'ocupada por outro processo';
        }
      } else {
        anotar(`nao consegui escutar: ${erro?.code ?? erro?.message ?? erro}`, 'warn');
      }
      avisar();
      agendar();
    });
    s.once('listening', () => {
      servidor = s;
      avisouOcupada = false;
      retrato.ativa = true;
      retrato.destino = destino();
      anotar(`escutando e repassando para 127.0.0.1:${retrato.destino}`, 'info');
      avisar();
    });
    s.listen(porta, '127.0.0.1');
  }

  tentar();

  return {
    porta,
    /** @returns retrato do estado, para `/ola` e para o `ponte.json`. */
    estado() {
      return { ...retrato };
    },
    /** Fecha a escuta e corta as conexões; usado na saída do plugin. */
    fechar() {
      if (fechada) return;
      fechada = true;
      if (espera !== null) {
        clearTimeout(espera);
        espera = null;
      }
      for (const soquete of abertas) {
        try {
          soquete.destroy();
        } catch {
          /* já foi */
        }
      }
      abertas.clear();
      if (servidor !== null) {
        try {
          servidor.close();
        } catch {
          /* já foi */
        }
        servidor = null;
      }
      retrato.ativa = false;
      retrato.motivo = 'fechada';
      avisar();
    },
  };
}
