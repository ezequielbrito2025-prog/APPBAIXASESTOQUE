import ExcelJS from 'exceljs';
import { round2, dataBR, brl } from './util.js';

const COLUNAS = [
  ['Data', 12], ['Número da ME', 14], ['Tipo', 10], ['Referência do Item', 20],
  ['Nome do Material', 42], ['Unidade', 9], ['Qtd Atendida', 14], ['Custo Total', 16],
  ['Requisitante', 24], ['Local de Aplicação', 26]
];

const tipoTxt = (t) => (t === 'SAIDA' ? 'Saída' : 'Entrada');
const isoToDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

/** Linhas da planilha: uma por item efetivamente movimentado. */
export async function carregarLinhas(db, movIds, tz) {
  if (!movIds.length) return [];
  const { rows } = await db.query(
    `SELECT m.numero_me, m.tipo, m.local_aplicacao,
            to_char((m.atendido_em AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS data_baixa,
            (SELECT a.nome FROM assinatura a WHERE a.movimentacao_id = m.id AND a.papel = 'REQUISITANTE') AS requisitante,
            i.item_seq, i.referencia, i.nome_material, i.unidade, i.qtd_atendida, i.custo_total
       FROM movimentacao m
       JOIN movimentacao_item i ON i.movimentacao_id = m.id
      WHERE m.id = ANY($1::uuid[]) AND i.qtd_atendida > 0
      ORDER BY m.atendido_em, m.numero_me, i.item_seq`,
    [movIds, tz]
  );
  return rows;
}

export function resumir(linhas) {
  const mes = new Set(linhas.map((l) => l.numero_me));
  const soma = (tipo) => round2(linhas.filter((l) => l.tipo === tipo).reduce((s, l) => s + Number(l.custo_total || 0), 0));
  const porLocal = new Map();
  for (const l of linhas) {
    const k = `${l.local_aplicacao || '(sem local)'}|${l.tipo}`;
    porLocal.set(k, round2((porLocal.get(k) || 0) + Number(l.custo_total || 0)));
  }
  return { mes: mes.size, linhas: linhas.length, saidas: soma('SAIDA'), entradas: soma('ENTRADA'), porLocal };
}

export async function gerarXlsx(linhas, dataRef) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Controle de Estoque';
  wb.created = new Date();

  const ws = wb.addWorksheet('Movimentação', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUNAS.map(([header, width]) => ({ header, width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E5A45' } }; });

  for (const l of linhas) {
    ws.addRow([
      isoToDate(l.data_baixa), l.numero_me, tipoTxt(l.tipo), l.referencia, l.nome_material, l.unidade,
      Number(l.qtd_atendida), Number(l.custo_total), l.requisitante || '', l.local_aplicacao || ''
    ]);
  }
  ws.getColumn(1).numFmt = 'dd/mm/yyyy';
  ws.getColumn(7).numFmt = '#,##0.###';
  ws.getColumn(8).numFmt = '"R$" #,##0.00';
  ws.getColumn(2).numFmt = '@';
  ws.getColumn(4).font = { name: 'Consolas' };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUNAS.length } };

  const r = resumir(linhas);
  const rs = wb.addWorksheet('Resumo');
  rs.columns = [{ width: 34 }, { width: 18 }, { width: 18 }];
  rs.addRow([`Movimentações de ${dataBR(dataRef)}`]).font = { bold: true, size: 14 };
  rs.addRow([]);
  rs.addRow(['Movimentações de estoque (MEs)', r.mes]);
  rs.addRow(['Linhas (itens movimentados)', r.linhas]);
  rs.addRow(['Custo total das saídas', r.saidas]).getCell(2).numFmt = '"R$" #,##0.00';
  rs.addRow(['Custo total das entradas', r.entradas]).getCell(2).numFmt = '"R$" #,##0.00';
  rs.addRow([]);
  const h = rs.addRow(['Local de Aplicação', 'Saídas (R$)', 'Entradas (R$)']);
  h.font = { bold: true };
  const locais = [...new Set([...r.porLocal.keys()].map((k) => k.split('|')[0]))].sort();
  for (const loc of locais) {
    const row = rs.addRow([loc, r.porLocal.get(`${loc}|SAIDA`) || 0, r.porLocal.get(`${loc}|ENTRADA`) || 0]);
    row.getCell(2).numFmt = '"R$" #,##0.00';
    row.getCell(3).numFmt = '"R$" #,##0.00';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV com ponto e vírgula, vírgula decimal e BOM UTF-8: abre certo no Excel em português. */
export function gerarCsv(linhas) {
  const q = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const num = (n, d) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
  const out = [COLUNAS.map((c) => c[0]).join(';')];
  for (const l of linhas) {
    out.push([
      dataBR(l.data_baixa), l.numero_me, tipoTxt(l.tipo), l.referencia, l.nome_material, l.unidade,
      num(l.qtd_atendida, Number.isInteger(Number(l.qtd_atendida)) ? 0 : 3), num(l.custo_total, 2), l.requisitante || '', l.local_aplicacao || ''
    ].map(q).join(';'));
  }
  return Buffer.from('﻿' + out.join('\r\n') + '\r\n', 'utf8');
}

export function corpoEmail(dataRef, r, reenvio) {
  const linhasTxt = [
    `Segue o consolidado das movimentações de estoque de ${dataBR(dataRef)}${reenvio ? ' (reenvio)' : ''}.`,
    '',
    `MEs atendidas: ${r.mes}`,
    `Itens movimentados: ${r.linhas}`,
    `Custo das saídas: ${brl(r.saidas)}`,
    `Custo das entradas: ${brl(r.entradas)}`,
    '',
    r.linhas ? 'A planilha completa está em anexo (Excel e CSV).' : 'Não houve movimentações neste dia.',
    '',
    'Mensagem automática do sistema de controle de estoque.'
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#17211D">
<p>Segue o consolidado das movimentações de estoque de <b>${dataBR(dataRef)}</b>${reenvio ? ' (reenvio)' : ''}.</p>
<table cellpadding="6" style="border-collapse:collapse;border:1px solid #DDD8CB">
<tr><td>MEs atendidas</td><td align="right"><b>${r.mes}</b></td></tr>
<tr><td>Itens movimentados</td><td align="right"><b>${r.linhas}</b></td></tr>
<tr><td>Custo das saídas</td><td align="right"><b>${brl(r.saidas)}</b></td></tr>
<tr><td>Custo das entradas</td><td align="right"><b>${brl(r.entradas)}</b></td></tr></table>
<p>${r.linhas ? 'A planilha completa está em anexo (Excel e CSV).' : 'Não houve movimentações neste dia.'}</p>
<p style="color:#5E6A64;font-size:12px">Mensagem automática do sistema de controle de estoque.</p></div>`;
  return { text: linhasTxt.join('\n'), html };
}
