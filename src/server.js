import { assertConfig, config } from './config.js';
import { createPool, migrate } from './db.js';
import { buildApp } from './app.js';
import { iniciarAgendador } from './fechamento.js';

assertConfig();
const pool = createPool();
const aplicadas = await migrate(pool);

const app = buildApp({ pool });
if (aplicadas.length) app.log.info(`Migrações aplicadas: ${aplicadas.join(', ')}`);

const pararAgendador = config.schedulerEnabled ? iniciarAgendador(pool, app.log) : () => {};
if (!config.smtp.host) app.log.warn('SMTP_HOST não configurado: os e-mails serão gravados em ' + config.outDir + ' (modo de teste).');

const encerrar = async () => { pararAgendador(); await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

await app.listen({ port: config.port, host: config.host });
