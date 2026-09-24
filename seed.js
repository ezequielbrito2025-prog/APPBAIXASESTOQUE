// Cria uma ME de exemplo (itens reais do modelo de ME analisado) e, opcionalmente, destinatários.
// Uso: API_TOKEN=... npm run seed   (SEED_EMAILS="gerencia@x.com,almox@x.com" para cadastrar destinatários)
import { createPool, migrate } from '../src/db.js';
import '../src/config.js';

const pool = createPool();
await migrate(pool);

const hoje = new Date().toISOString().slice(0, 10);
const itens = [
  ['OR022101340102', 'ARRUELA LISA ACO CARB 12MM', 'PC', 105, 0.15, 'F02'],
  ['OR01229C4P1', 'PARAF ACO CARB M12X50 SEXT', 'PC', 42, 1.54, 'C26'],
  ['OS0027V', 'PNEU CONSERT 275/80R22.5', 'PC', 35, 173.59, 'GAIOLA'],
  ['OP4262890119', 'PORCA 2902203 - RODA', 'PC', 27, 6.64, 'C17'],
  ['PC131050380101', 'LAMP AUTOM 67X24V DIV SIST ELET', 'PC', 26, 3.13, 'A03'],
  ['KDS3R1', 'AMORTECEDOR DIANT', 'PC', 6, 453.75, 'B30'],
  ['KD9D10020201', 'INTERRUPTOR 2W0941521 VW DIV', 'PC', 2, 612.28, 'A37']
];

const { rowCount } = await pool.query('SELECT 1 FROM movimentacao WHERE numero_me = $1', ['0001']);
if (rowCount) {
  console.log('ME 0001 já existe; nada a fazer.');
} else {
  const { buildApp } = await import('../src/app.js');
  const app = buildApp({ pool, logger: false });
  const res = await app.inject({
    method: 'POST', url: '/movimentacoes', headers: { authorization: `Bearer ${process.env.API_TOKEN}` },
    payload: {
      numero_me: '0001', tipo: 'SAIDA', data_me: hoje, local_aplicacao: 'Estoque Dois Irmãos', origem: 'seed',
      itens: itens.map(([referencia, nome_material, unidade, qtd_solicitada, custo_unitario, localizacao]) =>
        ({ referencia, nome_material, unidade, qtd_solicitada, custo_unitario, localizacao }))
    }
  });
  console.log(res.statusCode, res.body);
  await app.close();
}

for (const email of (process.env.SEED_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  await pool.query('INSERT INTO destinatario_relatorio (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET ativo = true', [email.toLowerCase()]);
  console.log('Destinatário:', email);
}
await pool.end();
