import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';

// numeric do PostgreSQL volta como número (custos e quantidades cabem em double sem perda relevante aqui)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// date volta como texto AAAA-MM-DD, sem conversão de fuso
pg.types.setTypeParser(1082, (v) => v);

export function createPool(url = config.databaseUrl) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function migrate(pool) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (nome text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas = [];
  for (const f of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE nome = $1', [f]);
    if (rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [f]);
      await client.query('COMMIT');
      aplicadas.push(f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Falha na migração ${f}: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return aplicadas;
}

export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(db, entidade, entidadeId, acao, usuario, detalhe) {
  await db.query(
    'INSERT INTO auditoria (entidade, entidade_id, acao, usuario, detalhe) VALUES ($1,$2,$3,$4,$5)',
    [entidade, String(entidadeId), acao, usuario || null, detalhe ? JSON.stringify(detalhe) : null]
  );
}

export async function getConfig(db) {
  const { rows } = await db.query('SELECT chave, valor FROM configuracao');
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}
