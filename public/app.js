'use strict';
/*
 * App de baixa de estoque (PWA). Fala com a API do próprio servidor.
 * - Lê QR Code/código de barras pela câmera (BarcodeDetector ou jsQR) ou por digitação/leitor USB.
 * - Guarda MEs, rascunhos e a fila de envio no IndexedDB: funciona sem internet e sincroniza depois.
 */
(function () {
  window.addEventListener('error', function (e) {
    var a = document.getElementById('app');
    if (a && !S.booted) a.innerHTML = '<div style="padding:24px;color:#A8281F"><b>O app não conseguiu abrir.</b><br>' + esc(e.message) + '</div>';
  });

  var ROLES = [['req', 'Requisitante', 'REQUISITANTE'], ['apr', 'Aprovador', 'APROVADOR'], ['rec', 'Recebedor', 'RECEBEDOR']];

  var S = {
    booted: false, screen: 'login', token: '', mes: {}, outbox: [], drafts: {}, lastSync: null,
    online: navigator.onLine, syncing: false, loginErr: '', code: '', manual: '', toast: '', toastErr: false,
    current: null, ate: {}, just: {}, filter: 'todos',
    sheet: null, sheetVia: 'list', val: '', justVal: '',
    pad: null, strokes: [], stroke: '', padName: '', drawing: false, signed: {}, paths: {}, names: {},
    lastEvent: null
  };

  /* ---------- utilidades ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function qty(n) { return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 }); }
  function money(n) { return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function hhmm(t) { return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  function dataBR(iso) { var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.random() * 256; });
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function el(id) { return document.getElementById(id); }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* sem vibração */ } }

  /* ---------- armazenamento local (IndexedDB, com plano B em memória) ---------- */
  var mem = {}, dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      try {
        var r = indexedDB.open('estoque-app', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  function kvGet(k) {
    return openDb().then(function (d) {
      return new Promise(function (res, rej) {
        var q = d.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    }).catch(function () { return mem[k]; });
  }
  function kvSet(k, v) {
    mem[k] = v;
    return openDb().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () { /* sem armazenamento: segue só em memória */ });
  }
  function persist() {
    return kvSet('state', JSON.parse(JSON.stringify({ token: S.token, mes: S.mes, outbox: S.outbox, drafts: S.drafts, lastSync: S.lastSync })));
  }

  /* ---------- rede ---------- */
  function api(path, opts) {
    opts = opts || {};
    var headers = { Authorization: 'Bearer ' + S.token };
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .catch(function () { return { network: true, status: 0 }; });
  }

  function pull() {
    return api('/sync/pull').then(function (r) {
      if (r.network) { S.online = false; return r; }
      S.online = true;
      if (r.status === 401) { S.token = ''; S.screen = 'login'; S.loginErr = 'Código de acesso recusado. Digite de novo.'; return r; }
      if (!r.ok) return r;
      var novos = {};
      r.data.pendentes.forEach(function (m) { novos[m.numero_me] = m; });
      // MEs já baixadas neste aparelho e ainda na fila continuam guardadas; a ME aberta também
      S.outbox.forEach(function (ev) { if (S.mes[ev.numero]) novos[ev.numero] = S.mes[ev.numero]; });
      if (S.current && S.mes[S.current] && !novos[S.current]) novos[S.current] = S.mes[S.current];
      S.mes = novos;
      S.lastSync = Date.now();
      return persist().then(function () { return r; });
    });
  }

  function sync() {
    if (S.syncing || !S.token) return Promise.resolve();
    S.syncing = true;
    var chain = Promise.resolve();
    S.outbox.slice().forEach(function (ev) {
      chain = chain.then(function (parar) {
        if (parar || ev.status === 'conflito' || ev.status === 'recusado') return parar;
        return api('/movimentacoes/' + encodeURIComponent(ev.numero) + '/atendimento', { method: 'POST', body: ev.body }).then(function (r) {
          if (r.network) { S.online = false; return true; }
          S.online = true;
          if (r.status === 401) { S.token = ''; S.screen = 'login'; S.loginErr = 'Código de acesso recusado. Digite de novo.'; return true; }
          if (r.ok) { S.outbox = S.outbox.filter(function (x) { return x.id !== ev.id; }); if (!(S.screen === 'done' && S.current === ev.numero)) delete S.mes[ev.numero]; return false; }
          var msg = (r.data && r.data.erro) || 'Erro ' + r.status;
          if (r.data && r.data.detalhes && r.data.detalhes.length) msg += ': ' + [].concat(r.data.detalhes).join('; ');
          if (r.status === 409) { ev.status = 'conflito'; ev.msg = msg; return false; }
          if (r.status >= 400 && r.status < 500) { ev.status = 'recusado'; ev.msg = msg; return false; }
          ev.msg = msg; return true; // erro do servidor: tenta de novo depois
        });
      });
    });
    return chain.then(function () { return persist(); })
      .then(function () { return S.online && S.token ? pull() : null; })
      .then(function () { S.syncing = false; render(); }, function () { S.syncing = false; render(); });
  }

  /* ---------- avisos ---------- */
  var toastTimer = null;
  function toast(msg, erro) {
    S.toast = msg; S.toastErr = !!erro;
    if (erro) vibrate([80, 60, 80]);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { S.toast = ''; render(); }, 3200);
    render();
  }

  /* ---------- cálculo da ME aberta ---------- */
  function M() { return S.mes[S.current] || null; }
  function calc() {
    var m = M(), done = 0, partial = 0, est = 0, ate = 0, anyPos = false;
    var rows = (m ? m.itens : []).map(function (it) {
      var a = S.ate[it.item_seq], d = a !== undefined;
      var p = d && a < it.qtd_solicitada, o = d && a > it.qtd_solicitada;
      var line = d ? Math.round(a * it.custo_unitario * 100) / 100 : 0;
      if (d) done++; if (p) partial++; if (d && a > 0) anyPos = true;
      est += it.qtd_solicitada * it.custo_unitario; ate += line;
      var r = { it: it, done: d, a: a, line: line, tag: 'Pendente', bg: '#E8E4D8', fg: '#3E4A44', dot: '#B8B2A2', qc: '#17211D' };
      if (d) { r.tag = 'Atendido'; r.bg = '#DCEBE4'; r.fg = '#0E5A45'; r.dot = '#0E5A45'; }
      if (p) { r.tag = 'Parcial'; r.bg = '#FBEBCB'; r.fg = '#7A4A00'; r.dot = '#D68A00'; r.qc = '#7A4A00'; }
      if (o) { r.tag = 'Acima'; r.bg = '#F8DEDB'; r.fg = '#A8281F'; r.dot = '#A8281F'; r.qc = '#A8281F'; }
      return r;
    });
    return { rows: rows, done: done, partial: partial, pending: rows.length - done, est: est, ate: ate, anyPos: anyPos, total: rows.length };
  }

  /* ---------- ícones ---------- */
  var ICON = {
    back: '<svg class="i" width="24" height="24" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    scan: '<svg class="i" width="22" height="22" viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16"/></svg>',
    pen: '<svg class="i" width="22" height="22" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
    check: '<svg class="i" width="22" height="22" viewBox="0 0 24 24" style="stroke-width:2.2"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    del: '<svg class="i" width="26" height="26" viewBox="0 0 24 24" style="stroke-width:1.8"><path d="M9 5h10a1 1 0 011 1v12a1 1 0 01-1 1H9l-6-7 6-7zM12 9.5l5 5M17 9.5l-5 5"/></svg>'
  };

  /* ---------- telas ---------- */
  function bar() {
    var m = M(), t, sub = '';
    if (S.screen === 'login') t = 'Baixa de estoque';
    else if (S.screen === 'home') { t = 'Baixa de estoque'; sub = S.lastSync ? 'Atualizado às ' + hhmm(S.lastSync) : 'Ainda não atualizado'; }
    else if (S.screen === 'queue') t = 'Fila de envio';
    else { t = m ? 'ME Nº ' + esc(m.numero_me) : ''; sub = { items: 'Itens', summary: 'Resumo da baixa', sign: 'Assinaturas', done: 'Concluído' }[S.screen] || ''; }
    var back = { items: 1, summary: 1, sign: 1, queue: 1 }[S.screen];
    var n = S.outbox.length;
    var pill = S.screen === 'login' ? '' :
      '<button class="pill ' + (S.online ? 'on' : 'off') + '" data-act="queue" aria-label="Estado da conexão e fila de envio"><i></i>' + (S.online ? 'Online' : 'Offline') + (n ? ' · ' + n : '') + '</button>';
    return '<div class="bar">' + (back ? '<button class="back" data-act="back" aria-label="Voltar">' + ICON.back + '</button>' : '<div style="width:8px"></div>') +
      '<div class="t"><b>' + t + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>' + pill + '</div>';
  }

  function loginScreen() {
    return '<div class="scroll" style="padding:24px 20px;display:flex;flex-direction:column;gap:16px">' +
      '<div><div style="font-size:26px;font-weight:700;letter-spacing:-.02em">Entrar</div>' +
      '<div style="font-size:14px;color:#5E6A64;margin-top:4px">Digite o código de acesso fornecido pelo almoxarifado. Ele fica guardado neste aparelho.</div></div>' +
      '<input class="inp" id="code" type="password" autocomplete="off" placeholder="Código de acesso" aria-label="Código de acesso" value="' + esc(S.code) + '">' +
      (S.loginErr ? '<div style="padding:10px 12px;border-radius:10px;background:#F8DEDB;color:#A8281F;font-size:14px;font-weight:600">' + esc(S.loginErr) + '</div>' : '') +
      '<button class="btn p" style="flex:none" data-act="login">Entrar</button></div>';
  }

  function homeScreen() {
    var nums = Object.keys(S.mes).filter(function (n) { return !S.outbox.some(function (e) { return e.numero === n; }); }).sort().reverse();
    var lista = nums.map(function (n) {
      var m = S.mes[n], est = m.itens.reduce(function (s, i) { return s + i.qtd_solicitada * i.custo_unitario; }, 0);
      var rasc = S.drafts[n] && Object.keys(S.drafts[n].ate || {}).length;
      return '<button class="row" data-act="openme" data-n="' + esc(n) + '" style="flex-direction:column;align-items:stretch;gap:6px">' +
        '<span style="display:flex;align-items:center;gap:8px"><b style="font-size:16px">ME ' + esc(n) + '</b>' +
        '<span class="tag" style="background:#DCEBE4;color:#0E5A45">' + (m.tipo === 'ENTRADA' ? 'ENTRADA' : 'SAÍDA') + '</span>' +
        (rasc ? '<span class="tag" style="background:#FBEBCB;color:#7A4A00">Em andamento</span>' : '') +
        '<span style="flex-grow:1"></span><span style="font-size:12px;color:#5E6A64">' + dataBR(m.data_me) + '</span></span>' +
        '<span style="font-size:13px;color:#3E4A44">' + esc(m.local_aplicacao || 'Local não informado') + '</span>' +
        '<span style="font-size:12px;color:#5E6A64">' + m.itens.length + ' itens · custo estimado ' + money(est) + '</span></button>';
    }).join('');
    var fila = S.outbox.length ? '<button class="row" data-act="queue" style="background:#FBEBCB;border-color:#E9CF9A"><span style="flex-grow:1"><b>' + S.outbox.length + (S.outbox.length === 1 ? ' baixa aguardando envio' : ' baixas aguardando envio') + '</b><br><span style="font-size:12px;color:#7A4A00">Toque para ver a fila</span></span></button>' : '';
    return '<div class="scroll" style="padding:8px 16px 20px;display:flex;flex-direction:column;gap:14px">' +
      '<button class="btn p" style="flex:none;width:100%" data-act="scanme">' + ICON.scan + 'Ler QR Code da ME</button>' +
      '<div style="display:flex;gap:10px"><input class="inp" id="manual" inputmode="numeric" placeholder="Ou digite o nº da ME" aria-label="Número da ME" value="' + esc(S.manual) + '">' +
      '<button data-act="openmanual" style="flex-shrink:0;height:52px;padding:0 20px;border:1.5px solid #0E5A45;border-radius:14px;background:transparent;color:#0E5A45;font-size:16px;font-weight:600">Abrir</button></div>' +
      fila +
      '<div class="lbl" style="margin-top:4px">MEs neste aparelho (' + nums.length + ')</div>' +
      (lista || '<div style="padding:16px;border-radius:14px;background:#FBFAF6;border:1px dashed #B8B2A2;color:#5E6A64;font-size:14px">Nenhuma ME pendente. Com internet, o app busca sozinho as MEs criadas pelo almoxarifado.</div>') +
      '</div>';
  }

  function itemsScreen(c) {
    var m = M();
    var fld = function (l, v) { return '<div style="display:flex;flex-direction:column;min-width:0"><span style="font-size:10.5px;font-weight:600;letter-spacing:.06em;color:#5E6A64">' + l + '</span><span style="font-size:13px;color:' + (v ? '#17211D' : '#8A938E') + '">' + esc(v || 'Não informado') + '</span></div>'; };
    var list = c.rows.filter(function (r) { return S.filter === 'todos' || !r.done; }).map(function (r) {
      return '<button class="row" data-act="item" data-seq="' + r.it.item_seq + '"><span class="dot" style="background:' + r.dot + '"></span>' +
        '<span style="flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:4px"><span style="font-weight:600;font-size:14px;line-height:1.25">' + esc(r.it.nome_material) + '</span>' +
        '<span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="mono" style="font-size:12px;color:#5E6A64">' + esc(r.it.referencia) + '</span>' + (r.it.localizacao ? '<span class="chip">' + esc(r.it.localizacao) + '</span>' : '') + '</span></span>' +
        '<span style="flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:2px"><span style="font-weight:700;font-size:16px;color:' + r.qc + '">' + (r.done ? qty(r.a) : '—') + '</span>' +
        '<span style="font-size:11px;color:#5E6A64">de ' + qty(r.it.qtd_solicitada) + ' ' + esc(r.it.unidade) + '</span></span></button>';
    }).join('');
    var review = c.done > 0 && c.pending > 0;
    return '<div class="body">' +
      '<div class="card" style="flex-shrink:0;margin:0 16px;padding:12px 14px;display:flex;flex-direction:column;gap:8px">' +
      '<div style="display:flex;align-items:center;gap:10px"><span style="padding:3px 10px;border-radius:8px;background:#DCEBE4;color:#0E5A45;font-size:12px;font-weight:700;letter-spacing:.06em">' + (m.tipo === 'ENTRADA' ? 'ENTRADA' : 'SAÍDA') + '</span><span style="flex-grow:1;font-size:13px;color:#5E6A64">' + dataBR(m.data_me) + '</span></div>' +
      '<div style="display:flex;flex-direction:column"><span class="lbl">Local de aplicação</span><span style="font-size:16px;font-weight:700">' + esc(m.local_aplicacao || 'Não informado') + '</span></div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 10px">' + fld('CONTRATO', m.contrato) + fld('SETOR', m.setor) + fld('FRENTE / EQUIP.', m.frente_servico_equipamento) + fld('ORDEM DE SERVIÇO', m.ordem_servico) + fld('ATIVO FIXO (AF)', m.ativo_fixo) + '</div></div>' +
      '<div style="flex-shrink:0;padding:12px 16px 6px;display:flex;flex-direction:column;gap:8px">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between"><span style="font-size:14px;font-weight:600">' + c.done + ' de ' + c.total + ' itens conferidos</span><span style="font-size:12px;color:#5E6A64">Custo estimado ' + money(c.est) + '</span></div>' +
      '<div style="height:8px;border-radius:4px;background:#DDD8CB;overflow:hidden"><div style="height:8px;border-radius:4px;background:#0E5A45;width:' + (c.total ? Math.round(c.done / c.total * 100) : 0) + '%"></div></div>' +
      '<div style="display:flex;gap:8px;align-items:center"><button class="fchip ' + (S.filter === 'todos' ? 'a' : '') + '" data-act="fall">Todos (' + c.total + ')</button><button class="fchip ' + (S.filter === 'pend' ? 'a' : '') + '" data-act="fpend">Pendentes (' + c.pending + ')</button>' +
      '<input class="inp" id="itemcode" style="height:36px;font-size:13px;border-radius:18px;padding:0 12px" placeholder="Código do item (leitor)" autocomplete="off" autocapitalize="characters" aria-label="Código do item lido por leitor ou digitado"></div></div>' +
      '<div class="scroll" style="padding:4px 16px 12px">' + list + '</div>' +
      '<div class="foot">' + (review ? '<button class="btn o" data-act="summary">Revisar</button>' : '') +
      '<button class="btn p" data-act="scanitem">' + ICON.scan + (c.pending > 0 ? 'Bipar próximo item' : 'Revisar e assinar') + '</button></div></div>';
  }

  function summaryScreen(c) {
    var list = c.rows.map(function (r) {
      return '<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid #E8E4D8">' +
        '<span style="flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:3px"><span style="font-weight:600;font-size:14px;line-height:1.25">' + esc(r.it.nome_material) + '</span>' +
        '<span style="display:flex;align-items:center;gap:8px"><span class="mono" style="font-size:12px;color:#5E6A64">' + esc(r.it.referencia) + '</span><span class="tag" style="background:' + r.bg + ';color:' + r.fg + '">' + r.tag + '</span></span></span>' +
        '<span style="flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:2px"><span style="font-weight:700;font-size:15px">' + (r.done ? qty(r.a) : '—') + ' <span style="font-size:11px;font-weight:500;color:#5E6A64">' + esc(r.it.unidade) + '</span></span>' +
        '<span style="font-size:12px;color:#5E6A64">' + (r.done ? money(r.line) : '—') + '</span></span></div>';
    }).join('');
    return '<div class="body"><div class="scroll" style="padding:4px 16px 12px;display:flex;flex-direction:column;gap:12px">' +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">' +
      '<div class="card" style="padding:14px"><div class="lbl">Itens atendidos</div><div style="font-size:26px;font-weight:700;letter-spacing:-.02em">' + c.done + ' <span style="font-size:15px;font-weight:500;color:#5E6A64">de ' + c.total + '</span></div></div>' +
      '<div style="padding:14px;background:#0E5A45;color:#fff;border-radius:16px"><div class="lbl" style="color:#CFE5DB">Custo total</div><div style="font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.5">' + money(c.ate) + '</div></div></div>' +
      '<div style="font-size:12.5px;color:#5E6A64">Custo estimado da solicitação: ' + money(c.est) + '. O custo total é calculado sobre a quantidade atendida.</div>' +
      (c.anyPos ? '' : '<div style="padding:10px 12px;border-radius:10px;background:#FBEBCB;color:#7A4A00;font-size:14px;font-weight:600">Nenhum item foi atendido ainda. Bipe pelo menos um item para continuar.</div>') +
      '<div class="card" style="overflow:hidden">' + list + '</div></div>' +
      '<div class="foot"><button class="btn p" data-act="sign"' + (c.anyPos ? '' : ' disabled') + '>' + ICON.pen + 'Coletar assinaturas</button></div></div>';
  }

  function signScreen() {
    var n = ROLES.filter(function (r) { return S.signed[r[0]]; }).length, miss = 3 - n;
    var cards = ROLES.map(function (r) {
      var k = r[0], t = S.signed[k];
      return '<div class="card" style="padding:14px;display:flex;flex-direction:column;gap:12px;border-color:' + (t ? '#0E5A45' : '#DDD8CB') + '">' +
        '<div style="display:flex;align-items:center;gap:10px"><span style="flex-grow:1;font-size:16px;font-weight:700">' + r[1] + '</span>' +
        '<span style="font-size:12px;font-weight:700;padding:3px 9px;border-radius:8px;background:' + (t ? '#DCEBE4' : '#E8E4D8') + ';color:' + (t ? '#0E5A45' : '#3E4A44') + '">' + (t ? 'Assinado' : 'Aguardando') + '</span></div>' +
        (t ? '<div style="display:flex;flex-direction:column;gap:6px"><div style="height:84px;border-radius:10px;background:#fff;border:1px solid #E8E4D8;display:flex;align-items:center;justify-content:center"><svg width="140" height="75" viewBox="0 0 300 160"><path d="' + esc(S.paths[k]) + '" fill="none" stroke="#17211D" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
          '<span style="font-size:12px;color:#5E6A64">' + esc(S.names[k]) + ' · ' + dataBR(new Date().toISOString()) + ' às ' + esc(t) + '</span></div>' : '') +
        '<button data-act="pad" data-k="' + k + '" style="height:48px;border:1.5px solid #0E5A45;border-radius:14px;background:transparent;color:#0E5A45;font-size:15px;font-weight:600">' + (t ? 'Refazer assinatura' : 'Assinar') + '</button></div>';
    }).join('');
    return '<div class="body"><div class="scroll" style="padding:4px 16px 12px;display:flex;flex-direction:column;gap:12px">' +
      '<span style="font-size:14px;color:#5E6A64">Entregue o aparelho a cada pessoa. A assinatura é feita com o dedo e guardada com nome, data, hora e um código de integridade.</span>' + cards + '</div>' +
      '<div class="foot" style="flex-direction:column;gap:8px"><span style="font-size:12.5px;color:#5E6A64;text-align:center">' + (miss === 0 ? 'Tudo pronto para finalizar.' : (miss === 1 ? 'Falta 1 assinatura.' : 'Faltam ' + miss + ' assinaturas.')) + '</span>' +
      '<button class="btn p" style="flex:none;width:100%" data-act="finish"' + (miss ? ' disabled' : '') + '>' + ICON.check + 'Finalizar movimentação</button></div></div>';
  }

  function doneScreen(c) {
    var notFull = c.pending > 0 || c.partial > 0;
    var noFila = S.outbox.some(function (e) { return e.id === S.lastEvent; });
    var falha = S.outbox.find(function (e) { return e.id === S.lastEvent && (e.status === 'conflito' || e.status === 'recusado'); });
    var cor = falha ? ['#F8DEDB', '#A8281F', '#A8281F'] : noFila ? ['#FBEBCB', '#5C3800', '#D68A00'] : ['#DCEBE4', '#0B4636', '#0E5A45'];
    var titulo = falha ? 'O servidor recusou esta baixa' : noFila ? (S.online ? 'Enviando ao servidor…' : 'Salvo neste aparelho') : 'Enviado ao servidor';
    var corpo = falha ? falha.msg : noFila ? (S.online ? 'A baixa está na fila e segue em instantes.' : 'Sem conexão: a baixa entra na fila e segue assim que a internet voltar.') : 'Esta ME entra no relatório diário das 18:00.';
    var line = function (a, b, last) { return '<div style="display:flex;justify-content:space-between;padding:11px 0;' + (last ? '' : 'border-bottom:1px solid #E8E4D8;') + 'font-size:14px"><span style="color:#5E6A64">' + a + '</span><span style="font-weight:700">' + b + '</span></div>'; };
    return '<div class="body"><div class="scroll" style="padding:16px 20px;display:flex;flex-direction:column;align-items:center;gap:14px">' +
      '<div style="width:84px;height:84px;border-radius:50%;background:#0E5A45;color:#fff;display:flex;align-items:center;justify-content:center"><svg class="i" width="44" height="44" viewBox="0 0 24 24" style="stroke-width:2.4"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>' +
      '<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><span style="font-size:24px;font-weight:700;letter-spacing:-.02em">ME ' + esc(S.current) + ' registrada</span>' +
      '<span style="padding:4px 12px;border-radius:9px;background:' + (notFull ? '#FBEBCB' : '#DCEBE4') + ';color:' + (notFull ? '#7A4A00' : '#0E5A45') + ';font-size:13px;font-weight:700">' + (notFull ? 'Atendido parcial' : 'Atendido') + '</span></div>' +
      '<div class="card" style="align-self:stretch;padding:4px 14px">' + line('Itens atendidos', c.done + ' de ' + c.total) + line('Custo total', money(c.ate)) + line('Assinaturas', '3 de 3', true) + '</div>' +
      '<div style="align-self:stretch;padding:14px;border-radius:16px;background:' + cor[0] + ';display:flex;gap:12px;align-items:flex-start;color:' + cor[1] + '"><span class="dot" style="margin-top:5px;background:' + cor[2] + '"></span><span style="display:flex;flex-direction:column;gap:2px"><b style="font-size:14px">' + titulo + '</b><span style="font-size:13px">' + esc(corpo) + '</span></span></div></div>' +
      '<div class="foot"><button class="btn p" data-act="home">' + ICON.scan + 'Voltar ao início</button></div></div>';
  }

  function queueScreen() {
    var lista = S.outbox.map(function (ev) {
      var st = { conflito: ['Conflito', '#F8DEDB', '#A8281F'], recusado: ['Recusada', '#F8DEDB', '#A8281F'] }[ev.status] || ['Aguardando envio', '#FBEBCB', '#7A4A00'];
      var flag = ev.status === 'conflito' || ev.status === 'recusado';
      return '<div class="card" style="padding:14px;display:flex;flex-direction:column;gap:8px"><div style="display:flex;align-items:center;gap:8px"><b>ME ' + esc(ev.numero) + '</b><span class="tag" style="background:' + st[1] + ';color:' + st[2] + '">' + st[0] + '</span><span style="flex-grow:1"></span><span style="font-size:12px;color:#5E6A64">' + hhmm(ev.criado_em) + '</span></div>' +
        (ev.msg ? '<div style="font-size:13px;color:' + (flag ? '#A8281F' : '#5E6A64') + '">' + esc(ev.msg) + '</div>' : '') +
        (flag ? '<button data-act="discard" data-id="' + esc(ev.id) + '" style="height:44px;border:1.5px solid #A8281F;border-radius:12px;background:transparent;color:#A8281F;font-size:14px;font-weight:600">Descartar esta baixa</button>' : '') + '</div>';
    }).join('');
    return '<div class="body"><div class="scroll" style="padding:4px 16px 16px;display:flex;flex-direction:column;gap:12px">' +
      '<div class="card" style="padding:14px;display:flex;flex-direction:column;gap:4px"><div style="display:flex;align-items:center;gap:8px"><span class="dot" style="background:' + (S.online ? '#0E5A45' : '#D68A00') + '"></span><b>' + (S.online ? 'Conectado ao servidor' : 'Sem conexão com o servidor') + '</b></div>' +
      '<span style="font-size:13px;color:#5E6A64">' + (S.lastSync ? 'Última atualização às ' + hhmm(S.lastSync) : 'Ainda não atualizou') + '</span></div>' +
      (lista || '<div style="padding:16px;border-radius:14px;background:#FBFAF6;border:1px dashed #B8B2A2;color:#5E6A64;font-size:14px">Nenhuma baixa aguardando envio.</div>') +
      '<button class="btn p" style="flex:none" data-act="syncnow"' + (S.syncing ? ' disabled' : '') + '>' + (S.syncing ? 'Atualizando…' : 'Atualizar agora') + '</button>' +
      '<button data-act="logout" style="height:48px;border:1.5px solid #B8B2A2;border-radius:14px;background:transparent;font-size:14px;font-weight:600"' + (S.outbox.length ? ' disabled' : '') + '>Sair (trocar código de acesso)</button>' +
      (S.outbox.length ? '<span style="font-size:12px;color:#5E6A64;text-align:center">Só é possível sair depois que a fila for enviada.</span>' : '') + '</div></div>';
  }

  /* ---------- folhas ---------- */
  function parseVal() { var n = parseFloat((S.val || '').replace(',', '.')); return { n: n, has: S.val !== '' && !isNaN(n) }; }

  function qtySheet() {
    var m = M(), it = m && m.itens.filter(function (x) { return x.item_seq === S.sheet; })[0];
    if (!it) return '';
    var p = parseVal(), n = p.n, has = p.has, over = has && n > it.qtd_solicitada;
    var hint = 'Informe a quantidade atendida', hb = '#E8E4D8', hf = '#3E4A44';
    if (has) {
      if (over) { hint = 'Acima do solicitado: escreva a justificativa'; hb = '#F8DEDB'; hf = '#A8281F'; }
      else if (n < it.qtd_solicitada) { hint = 'Atendimento parcial: faltam ' + qty(Math.round((it.qtd_solicitada - n) * 1000) / 1000) + ' ' + it.unidade; hb = '#FBEBCB'; hf = '#7A4A00'; }
      else { hint = 'Igual ao solicitado'; hb = '#DCEBE4'; hf = '#0E5A45'; }
    }
    var ok = has && (!over || S.justVal.trim().length >= 3);
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'del'].map(function (k) {
      return '<button class="key" data-act="key" data-k="' + k + '" aria-label="' + (k === 'del' ? 'Apagar' : k === ',' ? 'Vírgula' : k) + '">' + (k === 'del' ? ICON.del : k) + '</button>';
    }).join('');
    return '<div class="overlay"><div class="sheet">' +
      '<div style="display:flex;align-items:flex-start;gap:10px"><span style="flex-grow:1;display:flex;flex-direction:column;gap:4px"><span style="font-size:16px;font-weight:700;line-height:1.25">' + esc(it.nome_material) + '</span>' +
      '<span style="display:flex;align-items:center;gap:8px"><span class="mono" style="font-size:12.5px;color:#5E6A64">' + esc(it.referencia) + '</span>' + (it.localizacao ? '<span class="chip">' + esc(it.localizacao) + '</span>' : '') + '</span></span>' +
      '<span style="flex-shrink:0;font-size:12px;font-weight:700;padding:3px 9px;border-radius:8px;background:#DCEBE4;color:#0E5A45">' + (S.sheetVia === 'scan' ? 'QR lido' : S.sheetVia === 'code' ? 'Código lido' : 'Da lista') + '</span></div>' +
      '<div style="display:flex;align-items:flex-end;justify-content:space-between;padding:4px 4px 0"><span style="display:flex;flex-direction:column"><span class="lbl">Qtd. atendida</span>' +
      '<span style="font-size:42px;font-weight:700;letter-spacing:-.02em;line-height:1.1;color:' + (S.val === '' ? '#B8B2A2' : '#17211D') + '">' + (S.val === '' ? '0' : esc(S.val)) + ' <span style="font-size:16px;font-weight:500;color:#5E6A64">' + esc(it.unidade) + '</span></span></span>' +
      '<span style="display:flex;flex-direction:column;align-items:flex-end"><span class="lbl">Solicitada</span><span style="font-size:20px;font-weight:600">' + qty(it.qtd_solicitada) + ' ' + esc(it.unidade) + '</span></span></div>' +
      '<div style="padding:8px 12px;border-radius:10px;background:' + hb + ';color:' + hf + ';font-size:13px;font-weight:600">' + hint + '</div>' +
      (over ? '<input class="inp" id="just" style="height:46px;font-size:15px" placeholder="Justificativa (obrigatória)" autocomplete="off" aria-label="Justificativa" value="' + esc(S.justVal) + '">' : '') +
      '<button data-act="fill" style="height:44px;border:1.5px solid #0E5A45;border-radius:12px;background:transparent;color:#0E5A45;font-size:14px;font-weight:600">Atender tudo: ' + qty(it.qtd_solicitada) + ' ' + esc(it.unidade) + '</button>' +
      '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">' + keys + '</div>' +
      '<div style="display:flex;gap:10px"><button class="cancel" data-act="closesheet">Cancelar</button><button class="ok" data-act="confirmqty"' + (ok ? '' : ' disabled') + '>Confirmar quantidade</button></div></div></div>';
  }

  function padSheet() {
    var role = ROLES.filter(function (r) { return r[0] === S.pad; })[0];
    var d = S.strokes.concat(S.stroke ? [S.stroke] : []).join(' ');
    var ok = d && S.padName.trim().length >= 2;
    return '<div class="overlay"><div class="sheet">' +
      '<span style="font-size:18px;font-weight:700">Assinatura do ' + role[1] + '</span>' +
      '<label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:12px;font-weight:600;color:#5E6A64">Nome e matrícula (obrigatório)</span>' +
      '<input class="inp" id="padName" style="height:48px;font-size:16px;border-radius:12px" value="' + esc(S.padName) + '" placeholder="Digite o nome" autocomplete="off"></label>' +
      '<div style="position:relative;border-radius:16px;background:#fff;border:1.5px solid #B8B2A2;overflow:hidden">' +
      '<svg id="pad" viewBox="0 0 300 160" style="display:block;width:100%;height:auto;touch-action:none;cursor:crosshair"><path d="M20 124 L280 124" fill="none" stroke="#DDD8CB" stroke-width="1.5" stroke-dasharray="4 4"/>' +
      '<path id="padPath" d="' + esc(d) + '" fill="none" stroke="#17211D" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      (d ? '' : '<span id="padHint" style="position:absolute;left:0;right:0;top:60px;text-align:center;font-size:14px;color:#8A938E;pointer-events:none">Assine aqui com o dedo</span>') + '</div>' +
      '<div style="display:flex;justify-content:flex-start"><button class="ghost" data-act="padclear">Limpar</button></div>' +
      '<div style="display:flex;gap:10px"><button class="cancel" data-act="padcancel">Cancelar</button><button class="ok" id="padok" data-act="padconfirm"' + (ok ? '' : ' disabled') + '>Confirmar assinatura</button></div></div></div>';
  }

  /* ---------- render ---------- */
  var app = el('app');
  function render() {
    var c = calc(), body;
    if (S.screen === 'login') body = '<div class="body">' + loginScreen() + '</div>';
    else if (S.screen === 'home') body = '<div class="body">' + homeScreen() + '</div>';
    else if (S.screen === 'queue') body = queueScreen();
    else if (!M()) body = '<div class="body">' + homeScreen() + '</div>';
    else if (S.screen === 'items') body = itemsScreen(c);
    else if (S.screen === 'summary') body = summaryScreen(c);
    else if (S.screen === 'sign') body = signScreen();
    else body = doneScreen(c);
    app.innerHTML = bar() + body + (S.sheet !== null ? qtySheet() : '') + (S.pad !== null ? padSheet() : '') +
      (S.toast ? '<div class="toast' + (S.toastErr ? ' err' : '') + '" role="status">' + esc(S.toast) + '</div>' : '');
    bindPad();
  }

  /* ---------- fluxo ---------- */
  function normNum(text) {
    var t = String(text || '').trim().replace(/^me:\/\//i, '');
    return t.split('/')[0].trim();
  }

  function enterME(m) {
    var d = S.drafts[m.numero_me] || {};
    S.current = m.numero_me; S.ate = d.ate || {}; S.just = d.just || {}; S.filter = 'todos';
    S.signed = {}; S.paths = {}; S.names = {}; S.sheet = null; S.pad = null; S.screen = 'items';
    render();
  }

  function openME(text) {
    var n = normNum(text);
    if (!n) { toast('Digite ou leia o número da ME', true); return; }
    var cands = [n];
    if (/^\d+$/.test(n) && n.length < 4) cands.unshift(('0000' + n).slice(-4));
    var jaBaixada = S.outbox.some(function (e) { return cands.indexOf(e.numero) >= 0; });
    if (jaBaixada) { toast('Esta ME já foi baixada neste aparelho e está aguardando envio.', true); return; }
    var achada = cands.map(function (c) { return S.mes[c]; }).filter(Boolean)[0];
    if (achada) { enterME(achada); return; }
    if (!S.online) { toast('A ME ' + n + ' não está neste aparelho e não há conexão para buscá-la.', true); return; }
    var i = 0;
    (function tenta() {
      api('/movimentacoes/' + encodeURIComponent(cands[i])).then(function (r) {
        if (r.network) { S.online = false; toast('Sem conexão com o servidor.', true); return; }
        if (r.status === 401) { S.token = ''; S.screen = 'login'; render(); return; }
        if (r.ok) {
          var m = r.data;
          if (m.status !== 'PENDENTE' && m.status !== 'EM_ATENDIMENTO') { toast('A ME ' + m.numero_me + ' já está ' + m.status.replace('_', ' ').toLowerCase() + '.', true); return; }
          S.mes[m.numero_me] = m; persist(); enterME(m); return;
        }
        if (++i < cands.length) return tenta();
        toast('ME ' + n + ' não encontrada.', true);
      });
    })();
  }

  function handleItemCode(text, via) {
    var m = M(); if (!m) return;
    var code = String(text || '').trim().replace(/^item:\/\//i, '').toUpperCase();
    if (!code) return;
    var it = m.itens.filter(function (x) { return String(x.referencia).toUpperCase() === code; })[0];
    if (!it) { toast('O item ' + code + ' não faz parte desta ME.', true); return; }
    vibrate(50);
    S.sheet = it.item_seq; S.sheetVia = via; S.justVal = S.just[it.item_seq] || '';
    S.val = S.ate[it.item_seq] !== undefined ? String(S.ate[it.item_seq]).replace('.', ',') : '';
    render();
  }

  function openSheetSeq(seq) {
    S.sheet = seq; S.sheetVia = 'list'; S.justVal = S.just[seq] || '';
    S.val = S.ate[seq] !== undefined ? String(S.ate[seq]).replace('.', ',') : '';
    render();
  }

  function press(k) {
    var v = S.val;
    if (k === 'del') v = v.slice(0, -1);
    else if (k === ',') { if (v.indexOf(',') === -1) v = (v === '' ? '0' : v) + ','; }
    else if (v === '0') v = k;
    else if (v.length < 9) v += k;
    S.val = v; render();
  }

  function saveDraft() { S.drafts[S.current] = { ate: S.ate, just: S.just }; persist(); }

  function svgOf(d) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 160"><path d="' + d + '" fill="none" stroke="#17211D" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function finish() {
    var m = M(), c = calc();
    if (!m || !c.anyPos || !ROLES.every(function (r) { return S.signed[r[0]]; })) return;
    var id = uuid();
    var itens = m.itens.filter(function (it) { return S.ate[it.item_seq] !== undefined; }).map(function (it) {
      var o = { item_seq: it.item_seq, qtd_atendida: S.ate[it.item_seq] };
      if (S.just[it.item_seq] && S.ate[it.item_seq] > it.qtd_solicitada) o.justificativa = S.just[it.item_seq];
      return o;
    });
    var assinaturas = ROLES.map(function (r) { return { papel: r[2], nome: S.names[r[0]], tracado_svg: svgOf(S.paths[r[0]]) }; });
    S.outbox.push({ id: id, numero: m.numero_me, criado_em: Date.now(), status: 'aguardando', body: { evento_id: id, atendido_por: S.names.req, itens: itens, assinaturas: assinaturas } });
    delete S.drafts[m.numero_me];
    S.lastEvent = id; S.screen = 'done';
    persist().then(function () { render(); sync(); });
  }

  function doLogin() {
    var v = (el('code') ? el('code').value : S.code).trim();
    S.code = v;
    if (!v) { S.loginErr = 'Digite o código de acesso.'; render(); return; }
    S.token = v; S.loginErr = '';
    pull().then(function (r) {
      if (r && r.network) { S.token = ''; S.loginErr = 'Sem conexão com o servidor. Conecte-se à internet para entrar.'; }
      else if (r && !r.ok && r.status !== 401) { S.token = ''; S.loginErr = 'O servidor respondeu com erro ' + r.status + '.'; }
      else if (S.token) { S.screen = 'home'; S.code = ''; persist(); }
      render();
    });
  }

  /* ---------- eventos ---------- */
  var ACT = {
    back: function () { S.screen = { items: 'home', summary: 'items', sign: 'summary', queue: S.current && M() && S.outbox.every(function (e) { return e.numero !== S.current; }) && S.lastFrom || 'home' }[S.screen] || 'home'; if (S.screen === 'home') S.current = null; },
    queue: function () { if (S.screen !== 'queue') S.lastFrom = S.screen; S.screen = 'queue'; },
    login: function () { doLogin(); return 'skip'; },
    scanme: function () { openScanner('me'); return 'skip'; },
    openmanual: function () { openME(S.manual); return 'skip'; },
    openme: function (t) { var m = S.mes[t.getAttribute('data-n')]; if (m) { enterME(m); return 'skip'; } },
    fall: function () { S.filter = 'todos'; },
    fpend: function () { S.filter = 'pend'; },
    item: function (t) { openSheetSeq(+t.getAttribute('data-seq')); return 'skip'; },
    scanitem: function () {
      var c = calc();
      if (c.pending === 0) { S.screen = 'summary'; return; }
      openScanner('item'); return 'skip';
    },
    summary: function () { S.screen = 'summary'; },
    sign: function () { S.screen = 'sign'; },
    key: function (t) { press(t.getAttribute('data-k')); return 'skip'; },
    fill: function () {
      var m = M(), it = m && m.itens.filter(function (x) { return x.item_seq === S.sheet; })[0];
      if (it) S.val = String(it.qtd_solicitada).replace('.', ',');
    },
    closesheet: function () { S.sheet = null; S.val = ''; S.justVal = ''; },
    confirmqty: function () {
      var p = parseVal(), m = M(), it = m && m.itens.filter(function (x) { return x.item_seq === S.sheet; })[0];
      if (!p.has || !it) return;
      var over = p.n > it.qtd_solicitada;
      if (over && S.justVal.trim().length < 3) return;
      S.ate[it.item_seq] = p.n;
      if (over) S.just[it.item_seq] = S.justVal.trim(); else delete S.just[it.item_seq];
      S.sheet = null; S.val = ''; S.justVal = '';
      saveDraft();
    },
    pad: function (t) { var k = t.getAttribute('data-k'); S.pad = k; S.strokes = []; S.stroke = ''; S.padName = S.names[k] || ''; },
    padclear: function () { S.strokes = []; S.stroke = ''; },
    padcancel: function () { S.pad = null; S.strokes = []; S.stroke = ''; S.padName = ''; },
    padconfirm: function () {
      var d = S.strokes.join(' ');
      if (!d || S.padName.trim().length < 2 || !S.pad) return;
      S.signed[S.pad] = hhmm(Date.now()); S.paths[S.pad] = d; S.names[S.pad] = S.padName.trim();
      S.pad = null; S.strokes = []; S.stroke = ''; S.padName = '';
    },
    finish: function () { finish(); return 'skip'; },
    home: function () {
      if (S.screen === 'done' && S.current && S.outbox.every(function (e) { return e.numero !== S.current; })) { delete S.mes[S.current]; persist(); }
      S.screen = 'home'; S.current = null; S.lastEvent = null;
    },
    syncnow: function () { sync(); return 'skip'; },
    discard: function (t) {
      var id = t.getAttribute('data-id');
      if (!window.confirm('Descartar esta baixa? Os dados dela serão perdidos.')) return 'skip';
      S.outbox = S.outbox.filter(function (e) { return e.id !== id; }); persist();
    },
    logout: function () {
      if (S.outbox.length) return;
      S.token = ''; S.mes = {}; S.drafts = {}; S.screen = 'login'; persist();
    }
  };

  app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var r = ACT[t.getAttribute('data-act')](t);
    if (r !== 'skip') render();
  });
  app.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'code') S.code = e.target.value;
    else if (id === 'manual') S.manual = e.target.value;
    else if (id === 'padName') { S.padName = e.target.value; var b = el('padok'); if (b) b.disabled = !(S.strokes.length && S.padName.trim().length >= 2); }
    else if (id === 'just') {
      S.justVal = e.target.value;
      var ok = document.querySelector('[data-act="confirmqty"]'); if (ok) ok.disabled = !(parseVal().has && S.justVal.trim().length >= 3);
    }
  });
  app.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var id = e.target.id;
    if (id === 'code') doLogin();
    else if (id === 'manual') openME(S.manual);
    else if (id === 'itemcode') {
      var v = e.target.value; handleItemCode(v, 'code');
      setTimeout(function () { var i = el('itemcode'); if (i && S.sheet === null) i.focus(); }, 30);
    }
  });

  /* assinatura: desenha direto no SVG, sem refazer a tela */
  function bindPad() {
    var svg = el('pad'); if (!svg) return;
    var path = el('padPath');
    function pt(e) {
      var r = svg.getBoundingClientRect();
      return { x: Math.round((e.clientX - r.left) * 300 / (r.width || 300) * 10) / 10, y: Math.round((e.clientY - r.top) * 160 / (r.height || 160) * 10) / 10 };
    }
    function paint() { path.setAttribute('d', S.strokes.concat(S.stroke ? [S.stroke] : []).join(' ')); }
    svg.addEventListener('pointerdown', function (e) {
      var p = pt(e);
      try { svg.setPointerCapture(e.pointerId); } catch (x) { /* ok */ }
      S.drawing = true; S.stroke = 'M' + p.x + ' ' + p.y + ' L' + (p.x + 0.1) + ' ' + p.y; paint();
      var h = el('padHint'); if (h) h.hidden = true;
    });
    svg.addEventListener('pointermove', function (e) {
      if (!S.drawing) return;
      var p = pt(e); S.stroke += ' L' + p.x + ' ' + p.y; paint();
    });
    function up() {
      if (!S.drawing) return;
      S.drawing = false;
      if (S.stroke) S.strokes.push(S.stroke);
      S.stroke = '';
      var b = el('padok'); if (b) b.disabled = !(S.strokes.length && S.padName.trim().length >= 2);
    }
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  }

  /* ---------- leitor de câmera ---------- */
  var scan = { stream: null, timer: null, detector: null, mode: '', busy: false, last: '', lastAt: 0, canvas: null };

  function openScanner(mode) {
    scan.mode = mode;
    el('scanner').hidden = false;
    el('scanHint').textContent = mode === 'me' ? 'Aponte para o QR Code da ME' : 'Aponte para o QR Code do item';
    el('scanManual').value = '';
    startCamera();
  }
  function closeScanner() {
    stopCamera();
    el('scanner').hidden = true;
  }
  function stopCamera() {
    clearInterval(scan.timer); scan.timer = null;
    if (scan.stream) { scan.stream.getTracks().forEach(function (t) { t.stop(); }); scan.stream = null; }
    var v = el('cam'); if (v) v.srcObject = null;
  }
  function startCamera() {
    var v = el('cam');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      el('scanHint').textContent = 'A câmera só funciona em página segura (HTTPS). Digite o código abaixo.'; return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (st) {
        scan.stream = st; v.srcObject = st; return v.play();
      })
      .then(function () {
        if (!scan.detector && 'BarcodeDetector' in window) {
          try { scan.detector = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'itf'] }); } catch (e) { scan.detector = null; }
        }
        scan.timer = setInterval(tickScan, 220);
      })
      .catch(function (e) {
        el('scanHint').textContent = 'Não consegui abrir a câmera (' + ((e && e.name) || 'erro') + '). Libere a permissão ou digite o código abaixo.';
      });
  }
  function tickScan() {
    var v = el('cam');
    if (scan.busy || !v || v.readyState < 2 || !v.videoWidth) return;
    scan.busy = true;
    var done = function (text) { scan.busy = false; if (text) onScanned(text); };
    if (scan.detector) {
      scan.detector.detect(v).then(function (r) { done(r && r[0] && r[0].rawValue); }, function () { done(null); });
      return;
    }
    try {
      if (!window.jsQR) { scan.busy = false; return; }
      var w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
      if (!scan.canvas) scan.canvas = document.createElement('canvas');
      scan.canvas.width = w; scan.canvas.height = h;
      var ctx = scan.canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, w, h);
      var img = ctx.getImageData(0, 0, w, h);
      var q = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
      done(q && q.data);
    } catch (e) { scan.busy = false; }
  }
  function onScanned(text) {
    var now = Date.now();
    if (text === scan.last && now - scan.lastAt < 1800) return;
    scan.last = text; scan.lastAt = now;
    vibrate(60);
    var mode = scan.mode;
    closeScanner();
    if (mode === 'me') openME(text); else handleItemCode(text, 'scan');
  }
  el('scanClose').addEventListener('click', closeScanner);
  el('scanOk').addEventListener('click', function () { var v = el('scanManual').value; if (v.trim()) onScanned(v.trim() + ''); });
  el('scanManual').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var v = e.target.value; if (v.trim()) onScanned(v.trim()); } });

  /* ---------- início ---------- */
  window.addEventListener('online', function () { S.online = true; render(); sync(); });
  window.addEventListener('offline', function () { S.online = false; render(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.token) sync(); });
  setInterval(function () { if (S.token && !document.hidden) sync(); }, 20000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () { /* sem SW: o app funciona online */ });
  }

  kvGet('state').then(function (st) {
    if (st) {
      S.token = st.token || ''; S.mes = st.mes || {}; S.outbox = st.outbox || []; S.drafts = st.drafts || {}; S.lastSync = st.lastSync || null;
    }
    S.screen = S.token ? 'home' : 'login';
    S.booted = true;
    render();
    if (S.token) sync();
  });

  // Ganchos para teste automatizado
  window.__estoque = { S: S, sync: sync, pull: pull };
})();
