import { config } from './config.js';
import { audit, getConfig, tx } from './db.js';
import { agoraNoFuso, dataBR } from './util.js';
import { carregarLinhas, corpoEmail, gerarCsv, gerarXlsx, resumir } from './relatorio.js';
import { enviarEmail } from './mailer.js';

/**
 * Consolida as baixas e envia o relatório do dia.
 *
 * Entram as MEs Atendidas (total ou parcial) ainda não reportadas, com data de atendimento
 * até o dia consolidado. Assim, uma ME atendida offline e sincronizada depois do fechamento
 * aparece no relatório do dia seguinte e nunca fica de fora.
 *
 * Idempotente: só marca as MEs como reportadas depois que o e-mail foi aceito, e há uma linha
 * única por data em fechamento_diario. `reenvio` refaz o envio de um dia já enviado.
 */
export async function executarFechamento(pool, dataRef, { reenvio = false, usuario = 'sistema' } = {}) {
  const key = Number(dataRef.replaceAll('-', ''));
  const lock = await pool.connect();
  try {
    const { rows: [g] } = await lock.query('SELECT pg_try_advisory_lock(7001, $1) AS ok', [key]);
    if (!g.ok) return { ignorado: true, motivo: 'fechamento já em execução em outra instância' };
    return await rodar(pool, dataRef, reenvio, usuario);
  } finally {
    await lock.query('SELECT pg_advisory_unlock(7001, $1)', [key]).catch(() => {});
    lock.release();
  }
}

async function rodar(pool, dataRef, reenvio, usuario) {
  const cfg = await getConfig(pool);
  const tz = cfg.fuso || 'America/Fortaleza';

  const { rows: [f] } = await pool.query(
    `INSERT INTO fechamento_diario (data_ref, status, tentativas) VALUES ($1, 'EM_ANDAMENTO', 1)
     ON CONFLICT (data_ref) DO UPDATE
       SET status = 'EM_ANDAMENTO', tentativas = fechamento_diario.tentativas + 1,
           iniciado_em = now(), erro = NULL, proxima_tentativa = NULL
     RETURNING *`,
    [dataRef]
  );

  try {
    const { rows: mov } = reenvio
      ? await pool.query('SELECT id FROM movimentacao WHERE fechamento_id = $1', [f.id])
      : await pool.query(
          `SELECT id FROM movimentacao
            WHERE status IN ('ATENDIDO','ATENDIDO_PARCIAL') AND fechamento_id IS NULL
              AND (atendido_em AT TIME ZONE $1)::date <= $2::date`,
          [tz, dataRef]
        );
    const ids = mov.map((m) => m.id);
    const linhas = await carregarLinhas(pool, ids, tz);
    const r = resumir(linhas);

    const { rows: dest } = await pool.query('SELECT email FROM destinatario_relatorio WHERE ativo ORDER BY email');
    if (!dest.length) throw new Error('Nenhum destinatário ativo cadastrado para o relatório.');

    const anexos = [];
    let xlsx = null;
    if (linhas.length) {
      xlsx = await gerarXlsx(linhas, dataRef);
      anexos.push({ filename: `Movimentacao_Estoque_${dataRef}.xlsx`, content: xlsx });
      anexos.push({ filename: `Movimentacao_Estoque_${dataRef}.csv`, content: gerarCsv(linhas) });
    }
    const corpo = corpoEmail(dataRef, r, reenvio);
    const envio = await enviarEmail({
      from: `"${cfg.remetente_nome || 'Controle de Estoque'}" <${config.mailFrom}>`,
      to: dest.map((d) => d.email),
      subject: `Relatório Diário de Movimentação de Estoque - ${dataBR(dataRef)}${reenvio ? ' (reenvio)' : ''}`,
      ...corpo,
      attachments: anexos
    });

    await tx(pool, async (c) => {
      if (!reenvio && ids.length) await c.query('UPDATE movimentacao SET fechamento_id = $1 WHERE id = ANY($2::uuid[])', [f.id, ids]);
      await c.query(
        `UPDATE fechamento_diario
            SET status = 'ENVIADO', enviado_em = now(), qtd_movimentacoes = $2, qtd_linhas = $3,
                custo_saidas = $4, custo_entradas = $5, arquivo_xlsx = COALESCE($6, arquivo_xlsx),
                destinatarios = $7, erro = NULL, proxima_tentativa = NULL
          WHERE id = $1`,
        [f.id, r.mes, r.linhas, r.saidas, r.entradas, xlsx, dest.map((d) => d.email).join(', ')]
      );
      await audit(c, 'fechamento', dataRef, reenvio ? 'reenvio' : 'envio', usuario, { ...r, porLocal: undefined, envio });
    });
    return { ok: true, data_ref: dataRef, reenvio, mes: r.mes, linhas: r.linhas, saidas: r.saidas, entradas: r.entradas, envio };
  } catch (e) {
    const esgotou = f.tentativas >= config.maxTentativas;
    await pool.query(
      `UPDATE fechamento_diario SET status = 'FALHA', erro = $2,
              proxima_tentativa = CASE WHEN $3 THEN NULL ELSE now() + make_interval(mins => $4) END
        WHERE id = $1`,
      [f.id, String(e.message).slice(0, 500), esgotou, config.intervaloRetentativaMin]
    );
    await audit(pool, 'fechamento', dataRef, 'falha', usuario, { erro: e.message, tentativa: f.tentativas });
    return { ok: false, data_ref: dataRef, erro: e.message, tentativa: f.tentativas, tentaraNovamente: !esgotou };
  }
}

/** Verifica a cada tick se já passou do horário configurado e o dia ainda não foi enviado. */
export async function tickAgendador(pool, log = console, now = new Date()) {
  const cfg = await getConfig(pool);
  const { data, hora } = agoraNoFuso(cfg.fuso || 'America/Fortaleza', now);
  if (hora < (cfg.horario_fechamento || '18:00')) return { acao: 'aguardando' };

  const { rows: [f] } = await pool.query('SELECT * FROM fechamento_diario WHERE data_ref = $1', [data]);
  if (f) {
    if (f.status === 'ENVIADO') return { acao: 'ja-enviado' };
    if (f.status === 'EM_ANDAMENTO' && now - new Date(f.iniciado_em) < 15 * 60 * 1000) return { acao: 'em-andamento' };
    if (f.status === 'FALHA' && (!f.proxima_tentativa || new Date(f.proxima_tentativa) > now)) return { acao: 'falha-aguardando' };
  }
  log.info?.(`Fechamento diário de ${data} iniciado`);
  const r = await executarFechamento(pool, data);
  if (r.ok) log.info?.(`Fechamento de ${data} enviado: ${r.mes} MEs, ${r.linhas} linhas`);
  else if (!r.ignorado) log.error?.(`Fechamento de ${data} falhou (tentativa ${r.tentativa}): ${r.erro}`);
  return { acao: 'executado', ...r };
}

export function iniciarAgendador(pool, log = console) {
  let rodando = false;
  const timer = setInterval(async () => {
    if (rodando) return;
    rodando = true;
    try { await tickAgendador(pool, log); } catch (e) { log.error?.(`Agendador: ${e.message}`); } finally { rodando = false; }
  }, config.schedulerTickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
