/*
 * Estado do transcrito: transforma os quadros do `session/follow` em itens que a
 * interface sabe desenhar.
 *
 * Regras que valem a pena registrar, porque foram medidas na sessão real e não
 * são óbvias:
 *
 * 1. o texto ao vivo vem em `assistant-stream` (deltas por bloco) e o texto
 *    DURÁVEL vem em `assistant/message`. O raciocínio, porém, chega VAZIO no
 *    evento durável (o DSH não persiste reasoning no registro), então o
 *    raciocínio ao vivo é a única fonte: ele é transferido para o item quando o
 *    evento durável chega;
 * 2. a lista de ferramentas sai de `tool/call` e `tool/result`, e não dos blocos
 *    do `assistant/message`: os dois eventos já trazem nome, argumentos e
 *    resultado com o `callId` que casa um com o outro;
 * 3. as projeções (título, tokens, perguntas, permissões) NÃO vêm no fluxo
 *    depois do retrato inicial. Quem atualiza é uma chamada `session/projections`
 *    separada.
 *
 * @module painel/transcrito
 */

/** Estado inicial de uma conversa. */
export function novoEstado() {
  return {
    sessao: { id: null, titulo: '', cwd: '', preset: '', modelo: '', provider: '', permissoes: '' },
    itens: [],
    vivo: null,
    projecoes: null,
    perguntas: [],
    /** `ask_user_question` chamada e ainda sem resultado, em qualquer variante. */
    perguntaPendente: null,
    /** Versão global: a interface usa para saber se algo precisa ser redesenhado. */
    versao: 0,
  };
}

/** Cria um item com chave estável e versão própria. */
function novoItem(chave, tipo, extra = {}) {
  return { chave, tipo, versao: 0, ...extra };
}

function tocar(item) {
  item.versao += 1;
  return item;
}

/** Conta imagens num conteúdo de mensagem. */
function contarImagens(conteudo) {
  if (!Array.isArray(conteudo)) return 0;
  return conteudo.filter((bloco) => bloco?.type === 'image').length;
}

/** Junta os blocos de texto de um conteúdo. */
function textoDe(conteudo) {
  if (!Array.isArray(conteudo)) return '';
  return conteudo
    .filter((bloco) => bloco?.type === 'text' && typeof bloco.text === 'string')
    .map((bloco) => bloco.text)
    .join('\n')
    .trim();
}

/** Junta os blocos de raciocínio de um conteúdo. */
function raciocinioDe(conteudo) {
  if (!Array.isArray(conteudo)) return '';
  return conteudo
    .filter((bloco) => bloco?.type === 'reasoning' && typeof bloco.text === 'string')
    .map((bloco) => bloco.text)
    .join('\n')
    .trim();
}

/** Último item da lista, se for do tipo pedido. */
function ultimoDe(estado, tipo) {
  const ultimo = estado.itens.at(-1);
  return ultimo !== undefined && ultimo.tipo === tipo ? ultimo : undefined;
}

/**
 * Eco local que a mensagem durável pode substituir, olhando para trás.
 *
 * Não basta olhar o último item: entre o eco e a mensagem durável entram o
 * "turno N começou" e o prompt de sistema, e aí a pergunta aparecia duas vezes
 * na tela (medido no navegador em 17/10/2026). Para no primeiro item de usuário
 * encontrado, para nunca reaproveitar um eco antigo; o limite de 12 itens cobre
 * a chegada normal sem varrer o transcrito inteiro.
 * @param estado - estado do transcrito.
 * @returns o item de eco local ainda pendente, ou `undefined`.
 */
function ecoLocalPendente(estado) {
  const piso = Math.max(0, estado.itens.length - 12);
  for (let i = estado.itens.length - 1; i >= piso; i -= 1) {
    const item = estado.itens[i];
    if (item.tipo !== 'usuario') continue;
    return item.local === true ? item : undefined;
  }
  return undefined;
}

/** Acha o item de assistente de um (turno, passo). */
function itemDoPasso(estado, turno, passo) {
  for (let i = estado.itens.length - 1; i >= 0; i -= 1) {
    const item = estado.itens[i];
    if (item.tipo === 'assistente' && item.turno === turno && item.passo === passo) return item;
  }
  return undefined;
}

/** Acha uma ferramenta pelo `callId`, de trás para frente. */
function acharFerramenta(estado, callId) {
  for (let i = estado.itens.length - 1; i >= 0; i -= 1) {
    const item = estado.itens[i];
    if (item.tipo !== 'assistente') continue;
    const ferramenta = item.ferramentas.find((f) => f.callId === callId);
    if (ferramenta !== undefined) return ferramenta;
  }
  return undefined;
}

/**
 * Lê o lote de perguntas dos argumentos crus de `ask_user_question`.
 *
 * É a mesma tradução que o próprio DSH faz: o schema model-facing usa
 * `multi_select` e o vocabulário interno usa `multiSelect`.
 *
 * Ler a pergunta do `tool/call` (em vez de só das projeções) é o que faz o
 * painel enxergar a pergunta nas DUAS variantes do `tool-ask-user`:
 *   - `mode: legacy` (o padrão do pacote, sem config): a pergunta NÃO entra em
 *     `userQuestions.active`, e o painel só consegue mostrar o cartão informativo;
 *   - `mode: timed` (o que este DSH usa desde 17/10/2026, via preset): entra com
 *     `state: 'open'`, e o painel responde com `userQuestions/answer`. Medido
 *     naquele dia: resposta "Azul" enviada com a pergunta `open`, pergunta saiu
 *     da projeção e o turno seguiu com o modelo respondendo "Azul.". O
 *     `continued` que existia aqui na primeira redação não era o estado
 *     respondível; era palpite.
 *
 * @param argumentos - texto JSON dos argumentos.
 * @returns lista no vocabulário interno, ou `null` quando não dá para ler.
 */
function lerPerguntas(argumentos) {
  if (typeof argumentos !== 'string' || argumentos.trim() === '') return null;
  let bruto;
  try {
    bruto = JSON.parse(argumentos);
  } catch {
    return null;
  }
  const lista = bruto?.questions;
  if (!Array.isArray(lista)) return null;
  return lista.map((pergunta) => ({
    id: String(pergunta?.id ?? ''),
    question: String(pergunta?.question ?? ''),
    ...(pergunta?.header === undefined ? {} : { header: String(pergunta.header) }),
    ...(pergunta?.options === undefined
      ? {}
      : { options: (pergunta.options ?? []).map((o) => ({ label: String(o?.label ?? ''), ...(o?.description === undefined ? {} : { description: String(o.description) }) })) }),
    ...(pergunta?.multi_select === undefined ? {} : { multiSelect: pergunta.multi_select === true }),
  }));
}

/**
 * Aplica um quadro do `session/follow`.
 * @param estado - estado mutável.
 * @param quadro - valor entregue pelo fluxo.
 * @returns lista de marcadores do que mudou (`sessao`, `itens`, `vivo`, `titulo`).
 */
export function aplicarQuadro(estado, quadro) {
  if (quadro === null || typeof quadro !== 'object') return [];
  if (quadro.type === 'snapshot') return aplicarRetrato(estado, quadro);
  if (quadro.type === 'event') return aplicarEvento(estado, quadro.event);
  if (quadro.type === 'assistant-stream') return aplicarAoVivo(estado, quadro.frame);
  if (quadro.type === 'error') throw new Error(quadro.error?.message ?? 'o fluxo da sessao falhou');
  return [];
}

/** Retrato inicial: zera o transcrito e reconstrói pelos eventos. */
function aplicarRetrato(estado, quadro) {
  estado.itens = [];
  estado.vivo = null;
  estado.perguntaPendente = null;
  estado.sessao.id = quadro.header?.id ?? estado.sessao.id;
  estado.sessao.cwd = quadro.header?.cwd ?? '';
  estado.sessao.preset = quadro.header?.agentPreset ?? '';
  estado.projecoes = quadro.projections?.values ?? null;
  if (estado.projecoes !== null) aplicarProjecoes(estado, estado.projecoes);
  // O retrato pode vir cortado (`hasMore`); os eventos seguintes fecham a conta
  // porque o fluxo continua exatamente do cursor dele.
  for (const registro of quadro.records ?? []) aplicarEvento(estado, registro.event);
  estado.versao += 1;
  return ['sessao', 'itens', 'vivo', 'titulo'];
}

/** Aplica um evento durável. */
export function aplicarEvento(estado, evento) {
  if (evento === null || typeof evento !== 'object') return [];
  const dados = evento.data ?? {};
  const hora = evento.time;
  const seq = evento.seq;

  switch (evento.type) {
    case 'user/message': {
      /*
       * Nem todo `user/message` foi escrito pelo usuário. O DSH guarda como
       * mensagem de usuário os blocos que ele mesmo injeta: as instruções do
       * AGENTS.md (`agent-instructions`), o retrato do ambiente
       * (`runtime-context`), o catálogo de skills (`skill-catalog`) e o aviso de
       * troca de modelo (`model-changed`). Mostrar tudo isso como se o Ramses
       * tivesse digitado enche o transcrito de texto que ele nunca escreveu, e
       * foi exatamente o que o teste no navegador mostrou em 16/10/2026.
       *
       * Regra: `user` é o usuário; `user-question-reply` é a resposta dele a uma
       * pergunta do agente (vira aviso); notícia (`model-changed`) vira aviso;
       * o resto é boilerplate e sai do transcrito.
       */
      const origem = dados.source?.kind ?? '';
      if (origem !== 'user' && origem !== 'user-question-reply' && origem !== 'model-changed') return [];

      if (origem === 'user-question-reply' || origem === 'model-changed') {
        const aviso = novoItem(`aviso-${seq}`, 'status', {
          seq,
          hora,
          texto: origem === 'model-changed' ? textoDe(dados.content) : 'voce respondeu a pergunta do agente',
        });
        estado.itens.push(aviso);
        estado.versao += 1;
        return ['itens'];
      }

      const texto = textoDe(dados.content);
      const anterior = ecoLocalPendente(estado);
      // O prompt local (eco da própria caixa de texto) cede lugar ao durável,
      // que carrega junto o bloco de contexto da aba. Sem isto, a pergunta
      // aparece duas vezes: a digitada e a que voltou do DSH com contexto.
      if (anterior !== undefined && anterior.texto !== '' && texto.includes(anterior.texto)) {
        anterior.texto = texto;
        anterior.imagens = contarImagens(dados.content);
        anterior.local = false;
        anterior.seq = seq;
        anterior.origem = origem;
        tocar(anterior);
        estado.versao += 1;
        return ['itens'];
      }

      const item = novoItem(`usuario-${seq}`, 'usuario', {
        seq,
        hora,
        texto,
        imagens: contarImagens(dados.content),
        origem,
      });
      // O mesmo prompt entra como `agent/inbox/spliced` e como `user/message`:
      // não duplicar quando o texto é idêntico ao último item.
      if (anterior !== undefined && anterior.texto === item.texto && anterior.imagens === item.imagens) return [];
      estado.itens.push(item);
      estado.versao += 1;
      return ['itens'];
    }

    case 'assistant/message': {
      const turno = dados.turn ?? 0;
      const passo = dados.step ?? 0;
      const existente = itemDoPasso(estado, turno, passo);
      const texto = textoDe(dados.message?.content);
      const raciocinio = raciocinioDe(dados.message?.content);
      const uso = dados.usage ?? null;
      if (existente !== undefined) {
        existente.texto = texto;
        // O raciocínio durável vem vazio: preserva o que foi capturado ao vivo.
        if (raciocinio !== '') existente.raciocinio = raciocinio;
        existente.uso = uso;
        existente.hora = hora;
        tocar(existente);
      } else {
        const aoVivo = estado.vivo !== null && estado.vivo.turno === turno && estado.vivo.passo === passo ? estado.vivo : null;
        estado.itens.push(
          novoItem(`assistente-${turno}-${passo}`, 'assistente', {
            seq,
            hora,
            turno,
            passo,
            texto,
            raciocinio: raciocinio !== '' ? raciocinio : (aoVivo?.raciocinio ?? ''),
            ferramentas: aoVivo?.ferramentas ?? [],
            uso,
          }),
        );
      }
      if (estado.vivo !== null && estado.vivo.turno === turno && estado.vivo.passo === passo) estado.vivo = null;
      estado.versao += 1;
      return ['itens', 'vivo'];
    }

    case 'tool/call': {
      const turno = dados.turn ?? 0;
      const passo = dados.step ?? 0;
      const callId = dados.callId ?? '';
      if (acharFerramenta(estado, callId) !== undefined) return [];
      let item = itemDoPasso(estado, turno, passo);
      if (item === undefined) {
        item = novoItem(`assistente-${turno}-${passo}`, 'assistente', {
          seq,
          hora,
          turno,
          passo,
          texto: '',
          raciocinio: '',
          ferramentas: [],
          uso: null,
        });
        estado.itens.push(item);
      }
      let argumentos = dados.arguments ?? '';
      if (typeof argumentos === 'string') {
        try {
          argumentos = JSON.stringify(JSON.parse(argumentos), null, 2);
        } catch {
          /* deixa o texto cru */
        }
      } else {
        argumentos = JSON.stringify(argumentos, null, 2);
      }
      item.ferramentas.push({
        callId,
        nome: dados.name ?? 'ferramenta',
        argumentos: String(argumentos ?? ''),
        resultado: '',
        erro: false,
        estado: 'rodando',
        hora,
      });
      if (dados.name === 'ask_user_question') {
        const perguntas = lerPerguntas(dados.arguments);
        if (perguntas !== null && perguntas.length > 0) {
          estado.perguntaPendente = { callId, perguntas, desde: hora, aba: estado.sessao.titulo };
        }
      }
      tocar(item);
      estado.versao += 1;
      return ['itens', 'pendencias'];
    }

    case 'tool/result': {
      const callId = dados.message?.toolCallId ?? '';
      const ferramenta = acharFerramenta(estado, callId);
      if (estado.perguntaPendente?.callId === callId) estado.perguntaPendente = null;
      if (ferramenta === undefined) return ['pendencias'];
      ferramenta.resultado = textoDe(dados.message?.content);
      ferramenta.erro = dados.message?.isError === true || dados.error !== undefined;
      ferramenta.estado = ferramenta.erro ? 'erro' : 'ok';
      for (const item of estado.itens) if (item.ferramentas?.includes(ferramenta)) tocar(item);
      estado.versao += 1;
      return ['itens', 'pendencias'];
    }

    case 'system/message': {
      // O prompt de sistema é enorme e se repete a cada passo: guarda o
      // primeiro de cada turno, recolhido.
      const turno = dados.turn ?? 0;
      if (estado.itens.some((item) => item.tipo === 'sistema' && item.turno === turno)) return [];
      estado.itens.push(
        novoItem(`sistema-${turno}`, 'sistema', { seq, hora, turno, texto: textoDe(dados.message?.content) }),
      );
      estado.versao += 1;
      return ['itens'];
    }

    case 'session/title': {
      if (typeof dados.title === 'string' && dados.title !== '') {
        estado.sessao.titulo = dados.title;
        return ['titulo', 'sessao'];
      }
      return [];
    }

    case 'request/context': {
      estado.sessao.provider = dados.provider ?? estado.sessao.provider;
      estado.sessao.modelo = dados.model ?? estado.sessao.modelo;
      return ['sessao'];
    }

    case 'permission/preset': {
      estado.sessao.permissoes = dados.preset ?? '';
      return ['sessao'];
    }

    case 'turn/start': {
      estado.itens.push(novoItem(`turno-${dados.turn}-${seq}`, 'status', { seq, hora, texto: `turno ${dados.turn} comecou` }));
      estado.versao += 1;
      return ['itens'];
    }

    case 'turn/end': {
      estado.itens.push(novoItem(`fimturno-${dados.turn}-${seq}`, 'status', { seq, hora, texto: motivoDoTurno(dados) }));
      estado.versao += 1;
      return ['itens'];
    }

    case 'compaction/prune': {
      estado.itens.push(novoItem(`compactacao-${seq}`, 'status', { seq, hora, texto: 'contexto compactado pelo DSH' }));
      estado.versao += 1;
      return ['itens'];
    }

    case 'goal/change': {
      const objetivo = dados.goal;
      estado.objetivo = objetivo === null || objetivo === undefined ? null : { texto: objetivo.text ?? objetivo.objective ?? '', estado: dados.operation ?? '' };
      return ['sessao'];
    }

    case 'session/end-seed': {
      estado.itens.push(novoItem(`seed-${seq}`, 'status', { seq, hora, texto: 'sessao marcada como semeada' }));
      estado.versao += 1;
      return ['itens'];
    }

    default:
      return [];
  }
}

function motivoDoTurno(dados) {
  const motivo = dados.reason;
  const nome = typeof motivo === 'string' ? motivo : (motivo?.kind ?? '');
  const mapa = {
    completed: 'turno concluido',
    aborted: 'turno interrompido',
    'max-steps': 'turno parou no limite de passos',
    error: 'turno terminou com erro',
  };
  return mapa[nome] ?? `fim do turno ${dados.turn ?? ''}`.trim();
}

/** Aplica um quadro de texto ao vivo (`assistant-stream`). */
function aplicarAoVivo(estado, quadro) {
  if (quadro === null || typeof quadro !== 'object') return [];
  if (quadro.type === 'start') {
    estado.vivo = {
      turno: quadro.turn ?? 0,
      passo: quadro.step ?? 0,
      raciocinio: '',
      blocos: new Map(),
      ferramentas: [],
    };
    return ['vivo'];
  }
  if (estado.vivo === null) {
    // Um `end` de tentativa que nem vimos começar: nada a fazer.
    return [];
  }
  if (quadro.type === 'end') return ['vivo'];
  if (quadro.type !== 'chunk') return [];
  const chunk = quadro.chunk ?? {};
  const indice = chunk.index;
  switch (chunk.type) {
    case 'block-start': {
      estado.vivo.blocos.set(indice, { tipo: chunk.blockType ?? 'text', texto: '', nome: '', argumentos: '' });
      return ['vivo'];
    }
    case 'text-delta':
    case 'reasoning-delta': {
      const bloco = blocoDe(estado.vivo, indice, chunk.type === 'reasoning-delta' ? 'reasoning' : 'text');
      bloco.texto += chunk.text ?? '';
      if (bloco.tipo === 'reasoning') estado.vivo.raciocinio = raciocinioDoAoVivo(estado.vivo);
      return ['vivo'];
    }
    case 'tool-call-delta': {
      const bloco = blocoDe(estado.vivo, indice, 'tool-call');
      bloco.nome = chunk.name ?? bloco.nome;
      bloco.argumentos += chunk.argumentsDelta ?? '';
      return ['vivo'];
    }
    case 'block-end': {
      const bloco = blocoDe(estado.vivo, indice, chunk.block?.type ?? 'text');
      if (typeof chunk.block?.text === 'string') bloco.texto = chunk.block.text;
      if (chunk.block?.type === 'reasoning') estado.vivo.raciocinio = raciocinioDoAoVivo(estado.vivo);
      if (chunk.block?.type === 'tool-call' && bloco.nome !== '') {
        estado.vivo.ferramentas.push({ nome: bloco.nome, argumentos: bloco.argumentos, resultado: '', erro: false, estado: 'rodando' });
      }
      return ['vivo'];
    }
    default:
      return [];
  }
}

function blocoDe(vivo, indice, tipo) {
  let bloco = vivo.blocos.get(indice);
  if (bloco === undefined) {
    bloco = { tipo, texto: '', nome: '', argumentos: '' };
    vivo.blocos.set(indice, bloco);
  }
  return bloco;
}

function raciocinioDoAoVivo(vivo) {
  const partes = [];
  for (const bloco of [...vivo.blocos.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
    if (bloco.tipo === 'reasoning') partes.push(bloco.texto);
  }
  return partes.join('\n').trim();
}

/** Aplica as projeções da sessão (do retrato ou de `session/projections`). */
export function aplicarProjecoes(estado, valores) {
  if (valores === null || typeof valores !== 'object') return [];
  const antes = estado.sessao.titulo;
  if (typeof valores.title === 'string') estado.sessao.titulo = valores.title;
  if (typeof valores.agentPreset === 'string' && valores.agentPreset !== '') estado.sessao.preset = valores.agentPreset;
  if (typeof valores.permissions?.currentValue === 'string') estado.sessao.permissoes = valores.permissions.currentValue;
  if (typeof valores.modelSelection?.next?.model === 'string') {
    estado.sessao.modelo = valores.modelSelection.next.model;
    estado.sessao.provider = valores.modelSelection.next.provider ?? estado.sessao.provider;
  }
  estado.perguntas = Array.isArray(valores.userQuestions?.active) ? valores.userQuestions.active : [];
  estado.objetivo =
    valores.goal === null || valores.goal === undefined
      ? null
      : { texto: valores.goal.text ?? valores.goal.objective ?? '', estado: valores.goal.status ?? '' };
  estado.todos = valores.todos ?? null;
  estado.plano = valores.plan ?? null;
  estado.transbordo = valores.contextPressure ?? null;
  estado.tokens = valores.tokenUsage ?? null;
  estado.estatisticas = valores.sessionStats ?? null;
  estado.versao += 1;
  return estado.sessao.titulo !== antes ? ['sessao', 'titulo'] : ['sessao'];
}

/** Lê as projeções de uma resposta de `session/projections`. */
export function valoresDeProjecoes(resposta) {
  if (resposta === null || typeof resposta !== 'object') return null;
  if (resposta.values !== undefined) return resposta.values;
  if (resposta.projections?.values !== undefined) return resposta.projections.values;
  return null;
}
