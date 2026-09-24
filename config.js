// Carrega o .env (Node 20.12+) sem depender de pacote extra.
try { process.loadEnvFile('.env'); } catch { /* sem .env: usa variáveis do ambiente */ }

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  databaseUrl: env.DATABASE_URL || 'postgres://estoque:estoque@localhost:5432/estoque',
  apiToken: env.API_TOKEN || '',
  // Fechamento diário
  schedulerEnabled: (env.SCHEDULER_ENABLED ?? 'true') !== 'false',
  schedulerTickMs: Number(env.SCHEDULER_TICK_MS || 30000),
  maxTentativas: Number(env.FECHAMENTO_MAX_TENTATIVAS || 5),
  intervaloRetentativaMin: Number(env.FECHAMENTO_INTERVALO_MIN || 10),
  // E-mail: sem SMTP_HOST o servidor grava o e-mail em ./out (modo de teste)
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: (env.SMTP_SECURE || 'false') === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || ''
  },
  mailFrom: env.MAIL_FROM || 'estoque@localhost',
  outDir: env.OUT_DIR || './out'
};

export function assertConfig() {
  if (!config.apiToken || config.apiToken.length < 16) {
    throw new Error('Defina API_TOKEN com pelo menos 16 caracteres (veja .env.example).');
  }
}
