import { createHash } from 'node:crypto';

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Data (AAAA-MM-DD) e hora (HH:MM) atuais no fuso informado. */
export function agoraNoFuso(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

export const dataBR = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
