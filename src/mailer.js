import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

let transport;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
    });
  }
  return transport;
}

/**
 * Envia o e-mail. Sem SMTP_HOST configurado, grava o e-mail e os anexos em OUT_DIR
 * (modo de teste), para dar para conferir o resultado sem servidor de e-mail.
 */
export async function enviarEmail({ from, to, subject, text, html, attachments = [] }) {
  if (!config.smtp.host) {
    await mkdir(config.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(config.outDir, `email-${stamp}`);
    await writeFile(`${base}.json`, JSON.stringify({ from, to, subject, text, anexos: attachments.map((a) => a.filename) }, null, 2));
    for (const a of attachments) await writeFile(path.join(config.outDir, `${stamp}-${a.filename}`), a.content);
    return { modo: 'teste', arquivo: `${base}.json` };
  }
  const info = await getTransport().sendMail({ from, to, subject, text, html, attachments });
  return { modo: 'smtp', messageId: info.messageId, aceitos: info.accepted };
}
