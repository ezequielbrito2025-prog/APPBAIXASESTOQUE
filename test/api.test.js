import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { config } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { tickAgendador } from '../src/fechamento.js';
import { agoraNoFuso } from '../src/util.js';

const URL_TESTE = process.env.TEST_DATABASE_URL || 'postgres://estoque:estoque@localhost:5432/estoque_test';
const TOKEN = 'token-de-teste-1234567890';
let pool, app;

const req = (method, url, payload, auth = true) =>
  app.inject({ method, url, payload, headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });

const assinaturas = () => ['REQUISITANTE', 'APROVADOR', 'RECEBEDOR'].map((papel, i) =>
  ({ papel, nome: ['Ana Souza', 'Bruno Lima', 'Carla Dias'][i], matricula: `M${i}`, tracado_svg: 'M0 0 L10 10' }));

const meBase = (numero) => ({
  numero_me: numero, tipo: 'SAIDA', data_me: '2026-09-18', local_aplicacao: 'Estoque Dois Irmãos',
  itens: [
    { referencia: 'OS0027V', nome_material: 'PNEU CONSERT 275/80R22.5', unidade: 'PC', qtd_solicitada: 35, custo_unitario: 173.59 },
    { referencia: 'AH003319511', nome_material: 'CABO AC GALV AIRCR 1/2', unidade: 'MT', qtd_solicitada: 3.38, custo_unitario: 26.32 }
  ]
});

before(async () => {
  config.apiToken = TOKEN;
  config.smtp.host = '';
  config.outDir = await mkdtemp(path.join(os.tmpdir(), 'estoque-out-'));
  pool = createPool(URL_TESTE);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  app = buildApp({ pool, logger: false });
});
after(async () => { await app.close(); await pool.end(); });

test('exige token', async () => {
  assert.equal((await req('GET', '/movimentacoes', undefined, false)).statusCode, 401);
  assert.equal((await req('GET', '/health', undefined, false)).statusCode, 200);
});

test('cria ME, gera número automático e recusa número repetido', async () => {
  const auto = await req('POST', '/movimentacoes', { ...meBase(undefined) });
  assert.equal(auto.statusCode, 201);
  assert.equal(auto.json().numero_me, '0001');
  const r = await req('POST', '/movimentacoes', meBase('0100'));
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().custo_total_estimado, 6164.61); // 35 x 173,59 + 3,38 x 26,32
  assert.equal((await req('POST', '/movimentacoes', meBase('0100'))).statusCode, 409);
});

test('valida dados de entrada', async () => {
  const r = await req('POST', '/movimentacoes', { tipo: 'X', data_me: 'ontem', itens: [] });
  assert.equal(r.statusCode, 400);
});

test('baixa exige justificativa quando passa do solicitado', async () => {
  await req('POST', '/movimentacoes', meBase('0200'));
  const r = await req('POST', '/movimentacoes/0200/atendimento', {
    itens: [{ item_seq: 1, qtd_atendida: 40 }], assinaturas: assinaturas()
  });
  assert.equal(r.statusCode, 422);
  assert.match(r.json().detalhes[0], /justificativa/);
});

test('baixa parcial é idempotente por evento_id e fecha a ME', async () => {
  await req('POST', '/movimentacoes', meBase('0300'));
  const corpo = { evento_id: 'evento-0300-aaaa', itens: [{ item_seq: 1, qtd_atendida: 30 }], assinaturas: assinaturas() };
  const a = await req('POST', '/movimentacoes/0300/atendimento', corpo);
  assert.equal(a.statusCode, 201);
  assert.equal(a.json().me.status, 'ATENDIDO_PARCIAL');
  assert.equal(a.json().me.custo_total_atendido, 5207.7); // 30 x 173,59
  const b = await req('POST', '/movimentacoes/0300/atendimento', corpo);
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().repetido, true);
  const c = await req('POST', '/movimentacoes/0300/atendimento', { ...corpo, evento_id: 'evento-0300-bbbb' });
  assert.equal(c.statusCode, 409);
  const sig = await req('GET', '/movimentacoes/0300/assinaturas/requisitante');
  assert.equal(sig.statusCode, 200);
  assert.match(sig.headers['content-type'], /svg/);
  assert.equal(a.json().me.assinaturas.length, 3);
});

test('fechamento sem destinatário falha e registra tentativa', async () => {
  const hoje = agoraNoFuso('America/Fortaleza').data;
  const r = await req('POST', `/fechamentos/${hoje}/executar`);
  assert.equal(r.statusCode, 502);
  assert.match(r.json().erro, /destinat/);
  const lista = (await req('GET', '/fechamentos')).json();
  assert.equal(lista[0].status, 'FALHA');
  assert.equal(lista[0].tentativas, 1);
  assert.ok(lista[0].proxima_tentativa);
});

test('fechamento envia e-mail com planilha correta e não duplica', async () => {
  const hoje = agoraNoFuso('America/Fortaleza').data;
  await req('POST', '/destinatarios', { email: 'Gerencia@Empresa.com', grupo: 'Gerência' });
  await req('POST', '/destinatarios', { email: 'almox@empresa.com', grupo: 'Almoxarifado' });

  const r = await req('POST', `/fechamentos/${hoje}/executar`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().mes, 1);
  assert.equal(r.json().linhas, 1);
  assert.equal(r.json().saidas, 5207.7);

  const arquivos = await readdir(config.outDir);
  const json = arquivos.find((f) => f.endsWith('.json'));
  const email = JSON.parse(await readFile(path.join(config.outDir, json), 'utf8'));
  assert.match(email.subject, /^Relatório Diário de Movimentação de Estoque - \d\d\/\d\d\/\d{4}$/);
  assert.deepEqual(email.to, ['almox@empresa.com', 'gerencia@empresa.com']);
  assert.equal(email.anexos.length, 2);

  const xlsx = await req('GET', `/fechamentos/${hoje}/arquivo?formato=xlsx`);
  assert.equal(xlsx.statusCode, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.rawPayload);
  const ws = wb.getWorksheet('Movimentação');
  assert.deepEqual(ws.getRow(1).values.slice(1), ['Data', 'Número da ME', 'Tipo', 'Referência do Item', 'Nome do Material', 'Unidade', 'Qtd Atendida', 'Custo Total', 'Requisitante', 'Local de Aplicação']);
  const l = ws.getRow(2).values.slice(1);
  assert.equal(l[1], '0300'); assert.equal(l[2], 'Saída'); assert.equal(l[3], 'OS0027V');
  assert.equal(l[6], 30); assert.equal(l[7], 5207.7); assert.equal(l[8], 'Ana Souza'); assert.equal(l[9], 'Estoque Dois Irmãos');
  assert.ok(wb.getWorksheet('Resumo'));

  const csv = await req('GET', `/fechamentos/${hoje}/arquivo?formato=csv`);
  const txt = csv.rawPayload.toString('utf8');
  assert.ok(txt.startsWith('﻿Data;Número da ME;Tipo;'));
  assert.match(txt, /;0300;Saída;OS0027V;PNEU CONSERT 275\/80R22.5;PC;30;5207,70;Ana Souza;Estoque Dois Irmãos/);

  assert.equal((await req('POST', `/fechamentos/${hoje}/executar`)).statusCode, 409);
  const re = await req('POST', `/fechamentos/${hoje}/reenviar`);
  assert.equal(re.statusCode, 200);
  assert.equal(re.json().reenvio, true);
  assert.equal(re.json().linhas, 1);
});

test('ME atendida em dia anterior entra no próximo fechamento e não fica de fora', async () => {
  await req('POST', '/movimentacoes', meBase('0400'));
  await req('POST', '/movimentacoes/0400/atendimento', {
    evento_id: 'evento-0400-aaaa', itens: [{ item_seq: 1, qtd_atendida: 35 }, { item_seq: 2, qtd_atendida: 3.38 }], assinaturas: assinaturas()
  });
  await pool.query(`UPDATE movimentacao SET atendido_em = now() - interval '1 day' WHERE numero_me = '0400'`);
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const r = await req('POST', `/fechamentos/${amanha}/executar`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().mes, 1);
  assert.equal(r.json().linhas, 2);
  assert.equal(r.json().saidas, 6164.61); // 6075,65 + 88,96
});

test('dia sem movimentações envia e-mail curto, sem anexo', async () => {
  const r = await req('POST', '/fechamentos/2030-01-15/executar');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().linhas, 0);
  const arquivos = (await readdir(config.outDir)).filter((f) => f.endsWith('.json'));
  const ultimo = JSON.parse(await readFile(path.join(config.outDir, arquivos.sort().at(-1)), 'utf8'));
  assert.equal(ultimo.anexos.length, 0);
  assert.match(ultimo.text, /Não houve movimentações/);
});

test('agendador espera o horário, executa uma vez e depois não repete', async () => {
  await pool.query('UPDATE movimentacao SET fechamento_id = NULL');
  await pool.query('DELETE FROM fechamento_diario');
  await req('POST', '/movimentacoes', meBase('0500'));
  await req('POST', '/movimentacoes/0500/atendimento', {
    evento_id: 'evento-0500-aaaa', itens: [{ item_seq: 1, qtd_atendida: 5 }], assinaturas: assinaturas()
  });
  const hoje = agoraNoFuso('America/Fortaleza').data;
  const noFuso = (hhmm) => new Date(`${hoje}T${hhmm}:00-03:00`);
  const log = { info() {}, error() {} };

  assert.equal((await tickAgendador(pool, log, noFuso('17:59'))).acao, 'aguardando');
  const r = await tickAgendador(pool, log, noFuso('18:00'));
  assert.equal(r.acao, 'executado');
  assert.equal(r.ok, true);
  assert.equal((await tickAgendador(pool, log, noFuso('18:01'))).acao, 'ja-enviado');

  await req('PUT', '/configuracao', { horario_fechamento: '19:30' });
  assert.equal((await req('GET', '/configuracao')).json().horario_fechamento, '19:30');
  assert.equal((await req('PUT', '/configuracao', { fuso: 'Marte/Olimpo' })).statusCode, 422);
});

test('pull entrega as MEs pendentes com itens e o app é servido sem token', async () => {
  await req('POST', '/movimentacoes', meBase('0600'));
  const r = await req('GET', '/sync/pull');
  assert.equal(r.statusCode, 200);
  const me = r.json().pendentes.find((m) => m.numero_me === '0600');
  assert.ok(me);
  assert.equal(me.itens.length, 2);
  assert.equal(me.itens[0].referencia, 'OS0027V');
  assert.equal(me.id, undefined);
  assert.equal((await req('GET', '/sync/pull', undefined, false)).statusCode, 401);

  const home = await req('GET', '/app/', undefined, false);
  assert.equal(home.statusCode, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  assert.notEqual((await req('GET', '/app/../src/config.js', undefined, false)).statusCode, 200);
  assert.notEqual((await req('GET', '/app/%2e%2e/package.json', undefined, false)).statusCode, 200);
  assert.notEqual((await req('GET', '/app/..%2Fpackage.json', undefined, false)).statusCode, 200);
});
