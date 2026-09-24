import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { audit, getConfig, tx } from './db.js';
import { round2, sha256 } from './util.js';
import { executarFechamento } from './fechamento.js';
import { carregarLinhas, gerarCsv } from './relatorio.js';

class HttpError extends Error {
  constructor(status, message, detalhe) { super(message); this.status = status; this.detalhe = detalhe; }
}

const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use o formato AAAA-MM-DD');
const opt = z.string().trim().max(200).optional();

const itemIn = z.object({
  item_seq: z.number().int().positive().optional(),
  referencia: z.string().trim().min(1).max(60),
  nome_material: z.string().trim().min(1).max(200),
  unidade: z.string().trim().min(1).max(10),
  qtd_solicitada: z.number().nonnegative(),
  custo_unitario: z.number().nonnegative().default(0),
  localizacao: opt,
  conta: opt
});

const meIn = z.object({
  numero_me: z.string().trim().min(1).max(30).optional(),
  tipo: z.enum(['SAIDA', 'ENTRADA']),
  data_me: dataIso,
  contrato: opt, setor: opt, frente_servico_equipamento: opt,
  ordem_servico: opt, ativo_fixo: opt, local_aplicacao: opt, origem: opt,
  itens: z.array(itemIn).min(1).max(2000)
});

const atendimentoIn = z.object({
  evento_id: z.string().min(8).max(100).optional(),
  atendido_por: opt,
  itens: z.array(z.object({
    item_seq: z.number().int().positive(),
    qtd_atendida: z.number().nonnegative(),
    justificativa: z.string().trim().max(500).optional()
  })),
  assinaturas: z.array(z.object({
    papel: z.enum(['REQUISITANTE', 'APROVADOR', 'RECEBEDOR']),
    nome: z.string().trim().min(1).max(120),
    matricula: opt,
    tracado_svg: z.string().max(300000).optional(),
    imagem_png_base64: z.string().max(1500000).optional()
  })).length(3)
});

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png'
};

const fusoValido = (tz) => { try { new Intl.DateTimeFormat('pt-BR', { timeZone: tz }); return true; } catch { return false; } };

export function buildApp({ pool, logger = true }) {
  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024 });

  // ---------- autenticação: Bearer token (troque por login de usuários na fase do app) ----------
  app.addHook('onRequest', async (req) => {
    const rota = req.url.split('?')[0];
    if (rota === '/health' || rota === '/' || rota === '/app' || rota.startsWith('/app/') || rota === '/painel' || rota.startsWith('/painel/')) return; // os arquivos estáticos (app e painel) são públicos; a API não
    const enviado = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const esperado = Buffer.from(config.apiToken);
    if (!config.apiToken || enviado.length !== esperado.length || !timingSafeEqual(enviado, esperado)) {
      throw new HttpError(401, 'Token inválido ou ausente. Envie o cabeçalho Authorization: Bearer <API_TOKEN>.');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ erro: 'Dados inválidos', detalhes: err.issues.map((i) => `${i.path.join('.') || '(corpo)'}: ${i.message}`) });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ erro: err.message, detalhes: err.detalhe });
    if (err.code === '23505') return reply.code(409).send({ erro: 'Registro duplicado', detalhes: err.detail });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ erro: err.message });
    req.log.error(err);
    return reply.code(500).send({ erro: 'Erro interno' });
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // ---------- App de celular (PWA), servido pelo próprio servidor ----------
  app.get('/', async (req, reply) => reply.redirect('/app/'));

  /** Serve uma pasta estática dentro de public/: /app (o app do operador) e /painel (o painel de conferência). */
  function servirEstatico(prefixo, raiz) {
    app.get(prefixo, async (req, reply) => reply.redirect(`${prefixo}/`));
    app.get(`${prefixo}/*`, async (req, reply) => {
      let rel = decodeURIComponent(req.params['*'] || '') || 'index.html';
      if (rel.endsWith('/')) rel += 'index.html';
      const arquivo = path.resolve(raiz, rel);
      if (!arquivo.startsWith(raiz + path.sep)) throw new HttpError(404, 'Não encontrado');
      let dados;
      try { dados = await readFile(arquivo); } catch { throw new HttpError(404, 'Não encontrado'); }
      return reply.header('Cache-Control', 'no-cache').type(MIME[path.extname(arquivo)] || 'application/octet-stream').send(dados);
    });
  }
  servirEstatico('/app', PUBLIC_DIR);
  servirEstatico('/painel', path.resolve(PUBLIC_DIR, 'painel'));

  // ---------- Sincronização do app ----------
  /** Tudo que o app precisa levar para o campo: MEs pendentes com itens, numa chamada só. */
  app.get('/sync/pull', async () => {
    const { rows: mes } = await pool.query(
      `SELECT id, numero_me, tipo, data_me, contrato, setor, frente_servico_equipamento, ordem_servico, ativo_fixo,
              local_aplicacao, status, custo_total_estimado
         FROM movimentacao WHERE status IN ('PENDENTE','EM_ATENDIMENTO')
        ORDER BY data_me DESC, numero_me DESC LIMIT 200`);
    const porMe = new Map();
    if (mes.length) {
      const { rows: itens } = await pool.query(
        `SELECT movimentacao_id, item_seq, referencia, nome_material, unidade, qtd_solicitada, custo_unitario, localizacao, conta
           FROM movimentacao_item WHERE movimentacao_id = ANY($1::uuid[]) ORDER BY item_seq`, [mes.map((m) => m.id)]);
      for (const i of itens) {
        if (!porMe.has(i.movimentacao_id)) porMe.set(i.movimentacao_id, []);
        porMe.get(i.movimentacao_id).push({ ...i, movimentacao_id: undefined });
      }
    }
    return { gerado_em: new Date().toISOString(), pendentes: mes.map((m) => ({ ...m, id: undefined, itens: porMe.get(m.id) || [] })) };
  });

  // ---------- Movimentações (ME) ----------
  app.post('/movimentacoes', async (req, reply) => {
    const b = meIn.parse(req.body);
    const seqs = b.itens.map((it, i) => it.item_seq ?? i + 1);
    if (new Set(seqs).size !== seqs.length) throw new HttpError(422, 'item_seq repetido na lista de itens');

    const r = await tx(pool, async (c) => {
      const numero = b.numero_me ?? String((await c.query("SELECT nextval('me_numero_seq') AS n")).rows[0].n).padStart(4, '0');
      const estimado = round2(b.itens.reduce((s, it) => s + it.qtd_solicitada * it.custo_unitario, 0));
      const { rows: [m] } = await c.query(
        `INSERT INTO movimentacao (numero_me, tipo, data_me, contrato, setor, frente_servico_equipamento,
                                   ordem_servico, ativo_fixo, local_aplicacao, origem, custo_total_estimado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, numero_me`,
        [numero, b.tipo, b.data_me, b.contrato, b.setor, b.frente_servico_equipamento, b.ordem_servico,
         b.ativo_fixo, b.local_aplicacao, b.origem, estimado]
      );
      for (let i = 0; i < b.itens.length; i++) {
        const it = b.itens[i];
        const { rows: [cat] } = await c.query(
          `INSERT INTO item (referencia, nome, unidade, custo_unitario_atual, localizacao, conta)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (referencia) DO UPDATE
             SET nome = EXCLUDED.nome, unidade = EXCLUDED.unidade, custo_unitario_atual = EXCLUDED.custo_unitario_atual,
                 localizacao = COALESCE(EXCLUDED.localizacao, item.localizacao), conta = COALESCE(EXCLUDED.conta, item.conta),
                 atualizado_em = now()
           RETURNING id`,
          [it.referencia, it.nome_material, it.unidade, it.custo_unitario, it.localizacao, it.conta]
        );
        await c.query(
          `INSERT INTO movimentacao_item (movimentacao_id, item_seq, item_id, referencia, nome_material, unidade,
                                          qtd_solicitada, custo_unitario, localizacao, conta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [m.id, seqs[i], cat.id, it.referencia, it.nome_material, it.unidade, it.qtd_solicitada, it.custo_unitario, it.localizacao, it.conta]
        );
      }
      await audit(c, 'movimentacao', m.numero_me, 'criada', 'api', { itens: b.itens.length, origem: b.origem });
      return { id: m.id, numero_me: m.numero_me, itens: b.itens.length, custo_total_estimado: estimado, qr: `me://${m.numero_me}` };
    });
    return reply.code(201).send(r);
  });

  async function carregarME(db, numero) {
    const { rows: [m] } = await db.query('SELECT * FROM movimentacao WHERE numero_me = $1', [numero]);
    if (!m) throw new HttpError(404, `ME ${numero} não encontrada`);
    const { rows: itens } = await db.query(
      `SELECT item_seq, referencia, nome_material, unidade, qtd_solicitada, qtd_atendida, custo_unitario,
              custo_total, localizacao, conta, justificativa
         FROM movimentacao_item WHERE movimentacao_id = $1 ORDER BY item_seq`, [m.id]);
    const { rows: assinaturas } = await db.query(
      `SELECT papel, nome, matricula, hash_sha256, assinado_em, (tracado_svg IS NOT NULL) AS tem_svg, (imagem_png IS NOT NULL) AS tem_png
         FROM assinatura WHERE movimentacao_id = $1 ORDER BY papel`, [m.id]);
    return { ...m, itens, assinaturas };
  }

  app.get('/movimentacoes', async (req) => {
    const q = z.object({ status: z.enum(['PENDENTE', 'EM_ATENDIMENTO', 'ATENDIDO', 'ATENDIDO_PARCIAL', 'CANCELADO']).optional(),
                         data_me: dataIso.optional(), limite: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const { rows } = await pool.query(
      `SELECT numero_me, tipo, data_me, status, local_aplicacao, custo_total_estimado, custo_total_atendido, atendido_em
         FROM movimentacao WHERE ($1::text IS NULL OR status = $1) AND ($2::date IS NULL OR data_me = $2::date)
        ORDER BY criado_em DESC LIMIT $3`, [q.status ?? null, q.data_me ?? null, q.limite]);
    return rows;
  });

  /**
   * Linhas de conferência de um dia: uma por item baixado, com quem liberou e o ativo fixo.
   * Usado pelo painel local (aba Conferência). Só leitura; não depende do fechamento diário.
   */
  app.get('/movimentacoes/conferencia', async (req) => {
    const { data } = z.object({ data: dataIso }).parse(req.query);
    const cfg = await getConfig(pool);
    const tz = cfg.fuso || 'America/Fortaleza';
    const { rows } = await pool.query(
      `SELECT m.numero_me, m.tipo, m.ativo_fixo, m.local_aplicacao, m.atendido_por,
              to_char((m.atendido_em AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS data_baixa,
              i.item_seq, i.referencia, i.nome_material, i.unidade, i.qtd_solicitada, i.qtd_atendida, i.custo_total
         FROM movimentacao m
         JOIN movimentacao_item i ON i.movimentacao_id = m.id
        WHERE i.qtd_atendida > 0 AND (m.atendido_em AT TIME ZONE $2)::date = $1::date
        ORDER BY m.atendido_em, m.numero_me, i.item_seq`,
      [data, tz]);
    return rows;
  });

  app.get('/movimentacoes/:numero', async (req) => carregarME(pool, req.params.numero));

  app.get('/movimentacoes/:numero/assinaturas/:papel', async (req, reply) => {
    const { rows: [a] } = await pool.query(
      `SELECT a.tracado_svg, a.imagem_png FROM assinatura a JOIN movimentacao m ON m.id = a.movimentacao_id
        WHERE m.numero_me = $1 AND a.papel = $2`, [req.params.numero, String(req.params.papel).toUpperCase()]);
    if (!a) throw new HttpError(404, 'Assinatura não encontrada');
    if (a.imagem_png) return reply.type('image/png').send(a.imagem_png);
    return reply.type('image/svg+xml').send(a.tracado_svg || '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  /**
   * Registra a baixa: quantidades atendidas + 3 assinaturas. Idempotente por evento_id,
   * para o app reenviar com segurança depois de ficar offline.
   */
  app.post('/movimentacoes/:numero/atendimento', async (req, reply) => {
    const b = atendimentoIn.parse(req.body);
    const papeis = new Set(b.assinaturas.map((a) => a.papel));
    if (papeis.size !== 3) throw new HttpError(422, 'Envie exatamente uma assinatura de cada papel: REQUISITANTE, APROVADOR e RECEBEDOR');
    for (const a of b.assinaturas) if (!a.tracado_svg && !a.imagem_png_base64) throw new HttpError(422, `Assinatura de ${a.papel} sem imagem`);

    const resultado = await tx(pool, async (c) => {
      const { rows: [m] } = await c.query('SELECT * FROM movimentacao WHERE numero_me = $1 FOR UPDATE', [req.params.numero]);
      if (!m) throw new HttpError(404, `ME ${req.params.numero} não encontrada`);
      if (b.evento_id && m.evento_atendimento_id === b.evento_id) return { repetido: true, me: await carregarME(c, m.numero_me) };
      if (!['PENDENTE', 'EM_ATENDIMENTO'].includes(m.status)) throw new HttpError(409, `ME ${m.numero_me} já está ${m.status} e não aceita nova baixa`);

      const { rows: itens } = await c.query('SELECT * FROM movimentacao_item WHERE movimentacao_id = $1 ORDER BY item_seq', [m.id]);
      const porSeq = new Map(itens.map((i) => [i.item_seq, i]));
      const enviados = new Map();
      for (const e of b.itens) {
        if (!porSeq.has(e.item_seq)) throw new HttpError(422, `item_seq ${e.item_seq} não existe na ME ${m.numero_me}`);
        if (enviados.has(e.item_seq)) throw new HttpError(422, `item_seq ${e.item_seq} repetido`);
        enviados.set(e.item_seq, e);
      }

      let total = 0, todosCompletos = true, algum = false;
      const problemas = [];
      const resumoItens = [];
      for (const it of itens) {
        const e = enviados.get(it.item_seq);
        const q = e ? e.qtd_atendida : 0;
        if (q > it.qtd_solicitada && !e?.justificativa) problemas.push(`item ${it.item_seq} (${it.referencia}): quantidade acima da solicitada exige justificativa`);
        if (q < it.qtd_solicitada) todosCompletos = false;
        if (q > 0) algum = true;
        const custo = round2(q * it.custo_unitario);
        total += custo;
        resumoItens.push({ it, q, custo, justificativa: e?.justificativa ?? null });
      }
      if (problemas.length) throw new HttpError(422, 'Baixa recusada', problemas);
      if (!algum) throw new HttpError(422, 'Nenhum item foi atendido. Cancele a ME em vez de registrar baixa zerada.');

      for (const r of resumoItens) {
        await c.query('UPDATE movimentacao_item SET qtd_atendida = $2, custo_total = $3, justificativa = $4 WHERE id = $1',
          [r.it.id, r.q, r.custo, r.justificativa]);
      }
      const base = JSON.stringify({ me: m.numero_me, itens: resumoItens.map((r) => [r.it.item_seq, r.q]) });
      for (const a of b.assinaturas) {
        const png = a.imagem_png_base64 ? Buffer.from(a.imagem_png_base64, 'base64') : null;
        const hash = sha256(base + JSON.stringify([a.papel, a.nome, a.matricula ?? '', a.tracado_svg ?? '', png ? sha256(png) : '']));
        await c.query(
          `INSERT INTO assinatura (movimentacao_id, papel, nome, matricula, tracado_svg, imagem_png, hash_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [m.id, a.papel, a.nome, a.matricula, a.tracado_svg, png, hash]);
      }
      const status = todosCompletos ? 'ATENDIDO' : 'ATENDIDO_PARCIAL';
      await c.query(
        `UPDATE movimentacao SET status = $2, custo_total_atendido = $3, atendido_por = $4, atendido_em = now(),
                evento_atendimento_id = $5, atualizado_em = now() WHERE id = $1`,
        [m.id, status, round2(total), b.atendido_por ?? b.assinaturas.find((a) => a.papel === 'REQUISITANTE')?.nome, b.evento_id ?? null]);
      await audit(c, 'movimentacao', m.numero_me, 'atendida', b.atendido_por, { status, custo: round2(total), evento_id: b.evento_id });
      return { repetido: false, me: await carregarME(c, m.numero_me) };
    });
    return reply.code(resultado.repetido ? 200 : 201).send(resultado);
  });

  app.post('/movimentacoes/:numero/cancelar', async (req) => {
    const { motivo } = z.object({ motivo: z.string().trim().min(3).max(300) }).parse(req.body);
    const r = await tx(pool, async (c) => {
      const { rows: [m] } = await c.query(
        `UPDATE movimentacao SET status = 'CANCELADO', atualizado_em = now()
          WHERE numero_me = $1 AND status IN ('PENDENTE','EM_ATENDIMENTO') RETURNING numero_me, status`, [req.params.numero]);
      if (!m) throw new HttpError(409, 'Só é possível cancelar uma ME pendente ou em atendimento');
      await audit(c, 'movimentacao', m.numero_me, 'cancelada', 'api', { motivo });
      return m;
    });
    return r;
  });

  // ---------- Configuração e destinatários ----------
  app.get('/configuracao', async () => getConfig(pool));

  app.put('/configuracao', async (req) => {
    const b = z.object({
      horario_fechamento: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM').optional(),
      fuso: z.string().optional(),
      remetente_nome: z.string().trim().min(1).max(80).optional()
    }).parse(req.body);
    if (b.fuso && !fusoValido(b.fuso)) throw new HttpError(422, `Fuso horário inválido: ${b.fuso}`);
    for (const [k, v] of Object.entries(b)) {
      if (v !== undefined) await pool.query('INSERT INTO configuracao (chave, valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor', [k, v]);
    }
    await audit(pool, 'configuracao', 'geral', 'alterada', 'api', b);
    return getConfig(pool);
  });

  app.get('/destinatarios', async () => (await pool.query('SELECT id, email, nome, grupo, ativo FROM destinatario_relatorio ORDER BY email')).rows);

  app.post('/destinatarios', async (req, reply) => {
    const b = z.object({ email: z.string().trim().toLowerCase().email().max(200), nome: opt, grupo: opt }).parse(req.body);
    const { rows: [d] } = await pool.query(
      `INSERT INTO destinatario_relatorio (email, nome, grupo) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome, grupo = EXCLUDED.grupo, ativo = true RETURNING id, email, nome, grupo, ativo`,
      [b.email, b.nome, b.grupo]);
    await audit(pool, 'destinatario', d.email, 'salvo', 'api', null);
    return reply.code(201).send(d);
  });

  app.delete('/destinatarios/:id', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM destinatario_relatorio WHERE id = $1', [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Destinatário não encontrado');
    return reply.code(204).send();
  });

  // ---------- Fechamento diário ----------
  app.get('/fechamentos', async () => (await pool.query(
    `SELECT data_ref, status, iniciado_em, enviado_em, qtd_movimentacoes, qtd_linhas, custo_saidas, custo_entradas,
            tentativas, proxima_tentativa, destinatarios, erro, (arquivo_xlsx IS NOT NULL) AS tem_arquivo
       FROM fechamento_diario ORDER BY data_ref DESC LIMIT 60`)).rows);

  app.get('/fechamentos/:data/arquivo', async (req, reply) => {
    const data = dataIso.parse(req.params.data);
    const { formato } = z.object({ formato: z.enum(['xlsx', 'csv']).default('xlsx') }).parse(req.query);
    const { rows: [f] } = await pool.query('SELECT id, arquivo_xlsx FROM fechamento_diario WHERE data_ref = $1', [data]);
    if (!f) throw new HttpError(404, `Não há fechamento para ${data}`);
    if (formato === 'xlsx') {
      if (!f.arquivo_xlsx) throw new HttpError(404, 'Este fechamento não gerou planilha (dia sem movimentações)');
      return reply.header('Content-Disposition', `attachment; filename="Movimentacao_Estoque_${data}.xlsx"`)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(f.arquivo_xlsx);
    }
    const cfg = await getConfig(pool);
    const { rows: ids } = await pool.query('SELECT id FROM movimentacao WHERE fechamento_id = $1', [f.id]);
    const linhas = await carregarLinhas(pool, ids.map((i) => i.id), cfg.fuso || 'America/Fortaleza');
    return reply.header('Content-Disposition', `attachment; filename="Movimentacao_Estoque_${data}.csv"`)
      .type('text/csv; charset=utf-8').send(gerarCsv(linhas));
  });

  app.post('/fechamentos/:data/executar', async (req, reply) => {
    const data = dataIso.parse(req.params.data);
    const { rows: [f] } = await pool.query('SELECT status FROM fechamento_diario WHERE data_ref = $1', [data]);
    if (f?.status === 'ENVIADO') throw new HttpError(409, `O fechamento de ${data} já foi enviado. Use /reenviar para mandar de novo.`);
    const r = await executarFechamento(pool, data, { usuario: 'api' });
    return reply.code(r.ok ? 200 : r.ignorado ? 409 : 502).send(r);
  });

  app.post('/fechamentos/:data/reenviar', async (req, reply) => {
    const data = dataIso.parse(req.params.data);
    const { rows: [f] } = await pool.query('SELECT status FROM fechamento_diario WHERE data_ref = $1', [data]);
    if (!f) throw new HttpError(404, `Não há fechamento para ${data}. Use /executar.`);
    const r = await executarFechamento(pool, data, { reenvio: f.status === 'ENVIADO', usuario: 'api' });
    return reply.code(r.ok ? 200 : r.ignorado ? 409 : 502).send(r);
  });

  return app;
}
