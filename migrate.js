import { createPool, migrate } from '../src/db.js';
import '../src/config.js';

const pool = createPool();
const aplicadas = await migrate(pool);
console.log(aplicadas.length ? `Migrações aplicadas: ${aplicadas.join(', ')}` : 'Banco já está atualizado.');
await pool.end();
