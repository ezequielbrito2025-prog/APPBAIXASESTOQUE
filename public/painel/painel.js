/* Painel de conferência (local): consulta o servidor, mas guarda o catálogo de produtos
   só neste navegador (localStorage). Sem service worker, sem fila offline — é uma ferramenta
   de escritório, não o app de campo. */
(function () {
  'use strict';

  var LS_TOKEN = 'painel_token', LS_CAT = 'painel_catalogo', LS_CAT_META = 'painel_catalogo_meta';
  var PAPEIS = [['REQUISITANTE', 'Requisitante'], ['APROVADOR', 'Aprovador'], ['RECEBEDOR', 'Recebedor']];

  function hoje() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dataBR(iso) { if (!iso) return ''; var p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; }
  function dataHoraBR(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return iso; return dataBR(iso) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function money(n) { return 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function qty(n) { var v = Number(n || 0); return v.toLocaleString('pt-BR', { maximumFractionDigits: 3 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(id) { return document.getElementById(id); }
  function norm(s) { return String(s || '').trim().toUpperCase(); }
  function baixar(blob, nome) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = nome; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  var S = {
    token: localStorage.getItem(LS_TOKEN) || '',
    loginVal: '', loginErr: '',
    tab: 'conferencia',
    toast: '', toastErr: false, toastTimer: null,
    conf: { data: hoje(), linhas: null, carregando: false, erro: '', fechando: false },
    cat: carregarCatalogo(),
    catMeta: JSON.parse(localStorage.getItem(LS_CAT_META) || 'null'),
    prodFiltro: '', prodSubstituir: false, prodConfirmLimpar: false,
    pdf: { numero: '', gerando: '', erro: '', recentes: null }
  };

  function carregarCatalogo() {
    try { return JSON.parse(localStorage.getItem(LS_CAT) || '{}') || {}; } catch (e) { return {}; }
  }
  function salvarCatalogo() {
    localStorage.setItem(LS_CAT, JSON.stringify(S.cat));
    localStorage.setItem(LS_CAT_META, JSON.stringify(S.catMeta));
  }
  function nomeProduto(referencia, nomeServidor) {
    var e = S.cat[norm(referencia)];
    return { nome: (e && e.nome) || nomeServidor || '(sem nome)', doCatalogo: !!e };
  }

  function toast(msg, erro) {
    S.toast = msg; S.toastErr = !!erro; render();
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { S.toast = ''; render(); }, 4200);
  }

  /* ---------- API ---------- */
  function api(caminho, opts) {
    opts = opts || {};
    var headers = Object.assign({ Authorization: 'Bearer ' + S.token }, opts.headers || {});
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch(caminho, init).then(function (r) {
      if (r.status === 401) { S.token = ''; localStorage.removeItem(LS_TOKEN); render(); return Promise.reject(new Error('sessão expirada')); }
      return r;
    }, function (err) { throw new Error('Sem conexão com o servidor.'); });
  }
  function apiJson(caminho, opts) {
    return api(caminho, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.erro) || ('Erro ' + r.status));
        return data;
      });
    });
  }

  /* ---------- login ---------- */
  function doLogin() {
    var v = (el('token') ? el('token').value : S.loginVal).trim();
    if (!v) { S.loginErr = 'Digite o código de acesso.'; render(); return; }
    S.token = v; S.loginErr = '';
    apiJson('/configuracao').then(function () {
      localStorage.setItem(LS_TOKEN, v); toast('Conectado.'); carregarConferencia();
    }).catch(function (e) {
      S.token = ''; S.loginErr = /sessão|401|inválido/i.test(e.message) ? 'Código de acesso recusado.' : e.message; render();
    });
  }
  function logout() { S.token = ''; localStorage.removeItem(LS_TOKEN); render(); }

  /* ---------- aba conferência ---------- */
  function carregarConferencia() {
    S.conf.carregando = true; S.conf.erro = ''; render();
    apiJson('/movimentacoes/conferencia?data=' + encodeURIComponent(S.conf.data)).then(function (linhas) {
      S.conf.linhas = linhas; S.conf.carregando = false; render();
    }).catch(function (e) { S.conf.erro = e.message; S.conf.carregando = false; render(); });
  }

  function baixarPlanilhaDia() {
    var data = S.conf.data;
    S.conf.fechando = 'baixando'; render();
    api('/fechamentos/' + encodeURIComponent(data) + '/arquivo?formato=xlsx').then(function (r) {
      if (r.status === 404) { S.conf.fechando = false; S.conf.fechamentoAusente = true; render(); return; }
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.erro || ('Erro ' + r.status)); });
      return r.blob().then(function (b) { baixar(b, 'Movimentacao_Estoque_' + data + '.xlsx'); S.conf.fechando = false; S.conf.fechamentoAusente = false; render(); });
    }).catch(function (e) { S.conf.fechando = false; toast(e.message, true); render(); });
  }
  function fecharEBaixar() {
    var data = S.conf.data;
    S.conf.fechando = 'fechando'; render();
    apiJson('/fechamentos/' + encodeURIComponent(data) + '/executar', { method: 'POST', body: {} }).then(function () {
      toast('Fechamento concluído. Baixando a planilha…'); S.conf.fechamentoAusente = false; baixarPlanilhaDia();
    }).catch(function (e) { S.conf.fechando = false; toast(e.message, true); render(); });
  }

  function confTotais(linhas) {
    var mes = {}, itens = 0, custo = 0;
    (linhas || []).forEach(function (l) { mes[l.numero_me] = true; itens++; custo += Number(l.custo_total || 0); });
    return { mes: Object.keys(mes).length, itens: itens, custo: custo };
  }

  function confScreen() {
    var c = S.conf, t = confTotais(c.linhas);
    var linhas = (c.linhas || []).map(function (l) {
      var p = nomeProduto(l.referencia, l.nome_material);
      return '<tr><td>' + esc(dataBR(l.data_baixa)) + '</td>' +
        '<td class="mono">' + esc(l.referencia) + '</td>' +
        '<td' + (p.doCatalogo ? '' : ' class="muted"') + ' title="' + (p.doCatalogo ? 'Nome do catálogo importado' : 'Nome enviado na ME (sem correspondência no catálogo local)') + '">' + esc(p.nome) + '</td>' +
        '<td class="num">' + qty(l.qtd_atendida) + ' ' + esc(l.unidade) + '</td>' +
        '<td>' + esc(l.atendido_por || '—') + '</td>' +
        '<td>' + esc(l.ativo_fixo || '—') + '</td>' +
        '<td class="mono">' + esc(l.numero_me) + '</td>' +
        '<td>' + (l.tipo === 'ENTRADA' ? 'Entrada' : 'Saída') + '</td>' +
        '<td class="num">' + qty(l.qtd_solicitada) + '</td>' +
        '<td class="num">' + money(l.custo_total) + '</td>' +
        '<td>' + esc(l.local_aplicacao || '—') + '</td></tr>';
    }).join('');
    var tabela = c.linhas === null ? '<div class="empty">Escolha uma data e toque em Atualizar.</div>'
      : c.carregando ? '<div class="empty">Carregando…</div>'
      : !c.linhas.length ? '<div class="empty">Nenhuma baixa registrada nesta data.</div>'
      : '<div class="tablewrap"><table><thead><tr><th>Data</th><th>Código</th><th>Produto</th><th class="num">Quantidade</th><th>Funcionário que liberou</th><th>Ativo Fixo</th><th>ME</th><th>Tipo</th><th class="num">Qtd Solicitada</th><th class="num">Custo Total</th><th>Local</th></tr></thead><tbody>' + linhas + '</tbody></table></div>';

    var avisoFechamento = c.fechamentoAusente ? '<div class="note warn">O fechamento deste dia ainda não foi feito (roda sozinho às 18:00). <button class="btn d sm" data-act="fechar" style="margin-left:8px;color:#7A4A00;border-color:#E9CF9A">Fechar agora e enviar o e-mail</button></div>' : '';

    return '<div class="panel">' +
      '<div class="row"><div class="field"><label>Data</label><input class="inp" id="confData" type="date" value="' + esc(c.data) + '"></div>' +
      '<button class="btn p" data-act="atualizar">Atualizar</button>' +
      '<button class="btn o" data-act="baixarplanilha"' + (c.fechando ? ' disabled' : '') + '>' + (c.fechando === 'baixando' ? 'Baixando…' : 'Baixar planilha do dia') + '</button></div>' +
      (c.erro ? '<div class="note err">' + esc(c.erro) + '</div>' : '') +
      avisoFechamento +
      '<div class="stats"><div class="stat"><span>MEs no dia</span><b>' + t.mes + '</b></div><div class="stat"><span>Itens baixados</span><b>' + t.itens + '</b></div><div class="stat"><span>Custo total</span><b>' + money(t.custo) + '</b></div></div>' +
      tabela +
      '<div class="note">A coluna Produto usa o nome do catálogo importado na aba Produtos quando o código bate; senão mostra o nome que veio com a ME (em cinza). A planilha baixada é o mesmo relatório diário enviado por e-mail às 18:00.</div>' +
      '</div>';
  }

  /* ---------- aba produtos ---------- */
  function importarArquivo(file) {
    var reader = new FileReader();
    reader.onerror = function () { toast('Não foi possível ler o arquivo.', true); };
    reader.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        if (!linhas.length) throw new Error('Planilha vazia.');
        var iCod = 0, iNome = 1, comeco = 0;
        var cab = linhas[0].map(function (v) { return String(v || '').trim().toLowerCase(); });
        var achouCod = cab.findIndex(function (h) { return /c[oó]d/.test(h) || /refer[eê]ncia/.test(h); });
        var achouNome = cab.findIndex(function (h) { return /nome/.test(h) || /descri[cç][aã]o/.test(h) || /produto|material/.test(h); });
        if (achouCod >= 0 || achouNome >= 0) { iCod = achouCod >= 0 ? achouCod : 0; iNome = achouNome >= 0 ? achouNome : 1; comeco = 1; }
        var novo = {}, n = 0;
        for (var i = comeco; i < linhas.length; i++) {
          var codigo = String(linhas[i][iCod] || '').trim(), nome = String(linhas[i][iNome] || '').trim();
          if (!codigo) continue;
          novo[norm(codigo)] = { nome: nome || '(sem nome)', codigoOriginal: codigo };
          n++;
        }
        if (!n) throw new Error('Nenhuma linha com código foi encontrada. Confira se a planilha tem uma coluna de código e uma de nome.');
        S.cat = S.prodSubstituir ? novo : Object.assign({}, S.cat, novo);
        S.catMeta = { arquivo: file.name, importado_em: new Date().toISOString(), linhas: n, total: Object.keys(S.cat).length };
        salvarCatalogo();
        toast(n + ' produtos importados de "' + file.name + '". Catálogo agora tem ' + Object.keys(S.cat).length + ' itens.');
      } catch (e) { toast('Erro ao importar: ' + e.message, true); }
      render();
    };
    reader.readAsArrayBuffer(file);
  }

  function limparCatalogo() {
    if (!S.prodConfirmLimpar) { S.prodConfirmLimpar = true; render(); return; }
    S.cat = {}; S.catMeta = null; S.prodConfirmLimpar = false; salvarCatalogo(); toast('Catálogo apagado deste navegador.'); render();
  }

  function exportarCatalogoCsv() {
    var linhas = ['Codigo;Nome'];
    Object.keys(S.cat).sort().forEach(function (k) {
      var e = S.cat[k];
      linhas.push([e.codigoOriginal || k, e.nome].map(function (v) { var s = String(v || ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';'));
    });
    baixar(new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'catalogo-produtos.csv');
  }

  function prodScreen() {
    var termo = norm(S.prodFiltro);
    var chaves = Object.keys(S.cat).sort();
    if (termo) chaves = chaves.filter(function (k) { return k.indexOf(termo) >= 0 || norm(S.cat[k].nome).indexOf(termo) >= 0; });
    var linhas = chaves.slice(0, 500).map(function (k) {
      var e = S.cat[k];
      return '<tr><td class="mono">' + esc(e.codigoOriginal || k) + '</td><td>' + esc(e.nome) + '</td>' +
        '<td><button class="btn d sm" data-act="delprod" data-k="' + esc(k) + '">Remover</button></td></tr>';
    }).join('');
    var meta = S.catMeta ? '<div class="note">Última importação: "' + esc(S.catMeta.arquivo) + '" em ' + dataHoraBR(S.catMeta.importado_em) + ' (' + S.catMeta.linhas + ' linhas lidas).</div>' : '<div class="note">Nenhuma planilha importada ainda neste navegador.</div>';
    return '<div class="panel">' +
      '<div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">' +
      '<b style="font-size:15px">Importar catálogo (Excel ou CSV)</b>' +
      '<span class="note">Uma coluna com o código do produto (o mesmo que está no QR Code da etiqueta) e outra com o nome. Se a planilha tiver cabeçalho, ele é detectado sozinho; senão, a 1ª coluna é o código e a 2ª é o nome.</span>' +
      '<div class="row"><input type="file" id="arquivoImport" accept=".xlsx,.xls,.csv">' +
      '<label class="checkline"><input type="checkbox" id="substituir"' + (S.prodSubstituir ? ' checked' : '') + '> Substituir todo o catálogo (em vez de somar)</label></div>' +
      meta + '</div>' +
      '<div class="row"><div class="searchbox field"><label>Buscar</label><input class="inp" id="prodFiltro" placeholder="Código ou nome" value="' + esc(S.prodFiltro) + '"></div>' +
      '<div class="sp" style="flex-grow:1"></div>' +
      '<button class="btn o" data-act="exportarcat"' + (chaves.length ? '' : ' disabled') + '>Exportar catálogo (.csv)</button>' +
      '<button class="btn d" data-act="limparcat"' + (Object.keys(S.cat).length ? '' : ' disabled') + '>' + (S.prodConfirmLimpar ? 'Confirmar: apagar tudo?' : 'Limpar catálogo') + '</button></div>' +
      (chaves.length ? '<div class="tablewrap"><table><thead><tr><th>Código</th><th>Nome</th><th></th></tr></thead><tbody>' + linhas + '</tbody></table></div>' +
        (chaves.length > 500 ? '<div class="note">Mostrando 500 de ' + chaves.length + '. Refine a busca para ver outros.</div>' : '')
        : '<div class="empty">Nenhum produto cadastrado' + (termo ? ' para esta busca' : '') + '.</div>') +
      '</div>';
  }

  /* ---------- aba PDF da ME ---------- */
  function carregarRecentes() {
    apiJson('/movimentacoes?limite=15').then(function (rows) { S.pdf.recentes = rows; render(); }).catch(function () { S.pdf.recentes = []; render(); });
  }

  function svgParaPng(svgText, wPt, hPt) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
      img.onload = function () {
        var escala = 3, cv = document.createElement('canvas');
        cv.width = wPt * escala; cv.height = hPt * escala;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/png'));
      };
      img.onerror = function () { reject(new Error('não foi possível desenhar a assinatura')); };
      img.src = url;
    });
  }

  function buscarAssinaturaImagem(numero, papel) {
    return api('/movimentacoes/' + encodeURIComponent(numero) + '/assinaturas/' + papel).then(function (r) {
      if (!r.ok) return null;
      var tipo = r.headers.get('content-type') || '';
      if (tipo.indexOf('svg') >= 0) return r.text().then(function (svg) { return svgParaPng(svg, 300, 160); });
      return r.blob().then(function (b) { return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.readAsDataURL(b); }); });
    }).catch(function () { return null; });
  }

  function gerarPdf(numero) {
    S.pdf.gerando = numero; S.pdf.erro = ''; render();
    var me;
    apiJson('/movimentacoes/' + encodeURIComponent(numero)).then(function (m) {
      me = m;
      return Promise.all(PAPEIS.map(function (p) {
        var tem = (m.assinaturas || []).some(function (a) { return a.papel === p[0]; });
        return tem ? buscarAssinaturaImagem(numero, p[0]) : Promise.resolve(null);
      }));
    }).then(function (imagens) {
      montarPdf(me, imagens);
      S.pdf.gerando = ''; toast('PDF da ME ' + numero + ' gerado.'); render();
    }).catch(function (e) {
      S.pdf.gerando = ''; S.pdf.erro = /não encontrada|404/i.test(e.message) ? 'ME ' + numero + ' não encontrada.' : e.message; render();
    });
  }

  function montarPdf(m, imagensAssinatura) {
    var doc = new jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    var W = doc.internal.pageSize.getWidth(), M = 40, y = 0;
    function novaPagina() { doc.addPage(); cabecalhoTopo(); }
    function espaco(precisa) { if (y + precisa > doc.internal.pageSize.getHeight() - M) { novaPagina(); return true; } return false; }
    function texto(s, x, yy, opt) { doc.text(String(s == null ? '' : s), x, yy, opt); }
    function caber(s, larguraPt) {
      s = String(s == null ? '' : s);
      if (doc.getTextWidth(s) <= larguraPt) return s;
      var cortado = s;
      while (cortado.length > 1 && doc.getTextWidth(cortado + '…') > larguraPt) cortado = cortado.slice(0, -1);
      return cortado + '…';
    }
    function cabecalhoTopo() {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(94, 106, 100);
      texto('Movimentação de Estoque — ME ' + m.numero_me, M, 24);
      doc.setDrawColor(221, 216, 203); doc.line(M, 30, W - M, 30);
      y = 46;
    }

    y = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(19); doc.setTextColor(23, 33, 29);
    texto('ME ' + m.numero_me, M, y); y += 4;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(94, 106, 100);
    var statusTxt = { PENDENTE: 'Pendente', EM_ATENDIMENTO: 'Em atendimento', ATENDIDO: 'Atendido', ATENDIDO_PARCIAL: 'Atendido parcial', CANCELADO: 'Cancelado' }[m.status] || m.status;
    texto((m.tipo === 'ENTRADA' ? 'Entrada' : 'Saída') + ' · ' + statusTxt + ' · ME datada de ' + dataBR(m.data_me), M, y + 16);
    y += 34;

    var campos = [
      ['Contrato', m.contrato], ['Setor', m.setor], ['Frente / Equipamento', m.frente_servico_equipamento],
      ['Ordem de Serviço', m.ordem_servico], ['Ativo Fixo (AF)', m.ativo_fixo], ['Local de Aplicação', m.local_aplicacao],
      ['Atendido por', m.atendido_por], ['Atendido em', m.atendido_em ? dataHoraBR(m.atendido_em) : '—']
    ];
    doc.setFontSize(9.5);
    var col = 0, colW = (W - 2 * M) / 2, rowY = y;
    campos.forEach(function (c, i) {
      var x = M + (i % 2) * colW, yy = rowY + Math.floor(i / 2) * 30;
      doc.setFont('helvetica', 'bold'); doc.setTextColor(94, 106, 100); texto(c[0].toUpperCase(), x, yy);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(23, 33, 29); texto(c[1] ? String(c[1]) : 'Não informado', x, yy + 13);
    });
    y = rowY + Math.ceil(campos.length / 2) * 30 + 14;

    // ---- itens ----
    var larguras = [64, 106, 24, 40, 46, 54, 60, 0], cabs = ['Referência', 'Produto', 'Un.', 'Qtd Sol.', 'Qtd Atend.', 'Custo Unit.', 'Custo Total', 'Justificativa'];
    larguras[7] = (W - 2 * M) - larguras.slice(0, 7).reduce(function (a, b) { return a + b; }, 0);
    function linhaCabecalho() {
      doc.setFillColor(14, 90, 69); doc.rect(M, y, W - 2 * M, 20, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(255, 255, 255);
      var x = M;
      cabs.forEach(function (c, i) { texto(caber(c, (larguras[i] || 100) - 6), x + 5, y + 13); x += larguras[i]; });
      y += 20;
    }
    espaco(60); linhaCabecalho();
    var custoTotal = 0;
    (m.itens || []).forEach(function (it, idx) {
      var prod = nomeProduto(it.referencia, it.nome_material).nome;
      var just = it.justificativa || '';
      var linhasJust = doc.setFontSize(8).splitTextToSize(just, larguras[7] - 8);
      var alturaLinha = Math.max(18, 10 + linhasJust.length * 9);
      if (espaco(alturaLinha + 4)) linhaCabecalho(); // reimprime cabeçalho após quebra de página
      if (idx % 2 === 1) { doc.setFillColor(247, 245, 238); doc.rect(M, y, W - 2 * M, alturaLinha, 'F'); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(23, 33, 29);
      var x = M, yy = y + 12;
      texto(caber(it.referencia, larguras[0] - 8), x + 5, yy); x += larguras[0];
      texto(caber(prod, larguras[1] - 8), x + 5, yy); x += larguras[1];
      texto(caber(it.unidade || '', larguras[2] - 6), x + 5, yy); x += larguras[2];
      texto(qty(it.qtd_solicitada), x + larguras[3] - 5, yy, { align: 'right' }); x += larguras[3];
      texto(qty(it.qtd_atendida), x + larguras[4] - 5, yy, { align: 'right' }); x += larguras[4];
      texto(money(it.custo_unitario).replace('R$ ', ''), x + larguras[5] - 5, yy, { align: 'right' }); x += larguras[5];
      texto(money(it.custo_total).replace('R$ ', ''), x + larguras[6] - 5, yy, { align: 'right' }); x += larguras[6];
      doc.setFontSize(8); doc.text(linhasJust, x + 5, y + 10);
      custoTotal += Number(it.custo_total || 0);
      y += alturaLinha;
      doc.setDrawColor(232, 228, 216); doc.line(M, y, W - M, y);
    });
    y += 8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(23, 33, 29);
    texto('Custo total atendido: ' + money(m.custo_total_atendido != null ? m.custo_total_atendido : custoTotal), W - M, y, { align: 'right' });
    y += 28;

    // ---- assinaturas ----
    espaco(150);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(23, 33, 29);
    texto('Assinaturas coletadas', M, y); y += 14;
    var boxW = (W - 2 * M - 20) / 3, boxH = 150, x0 = M;
    PAPEIS.forEach(function (p, i) {
      var ass = (m.assinaturas || []).find(function (a) { return a.papel === p[0]; });
      var x = x0 + i * (boxW + 10);
      doc.setDrawColor(ass ? 14 : 216, ass ? 90 : 216, ass ? 69 : 216);
      if (!ass) doc.setLineDashPattern([3, 2], 0); else doc.setLineDashPattern([], 0);
      doc.roundedRect(x, y, boxW, boxH, 8, 8);
      doc.setLineDashPattern([], 0);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(23, 33, 29);
      texto(p[1], x + 10, y + 18);
      if (!ass) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(154, 148, 132);
        texto('Aguardando assinatura', x + 10, y + 40);
        return;
      }
      var img = imagensAssinatura[i];
      if (img) { try { doc.addImage(img, 'PNG', x + 10, y + 24, boxW - 20, 55); } catch (e) { /* ignora */ } }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(23, 33, 29);
      texto(ass.nome + (ass.matricula ? ' · ' + ass.matricula : ''), x + 10, y + 92);
      doc.setTextColor(94, 106, 100); doc.setFontSize(8);
      texto(dataHoraBR(ass.assinado_em), x + 10, y + 104);
      texto('hash ' + (ass.hash_sha256 || '').slice(0, 16) + '…', x + 10, y + 116);
    });
    y += boxH + 20;

    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(154, 148, 132);
    texto('PDF gerado pelo painel de conferência em ' + dataHoraBR(new Date().toISOString()) + '. O hash de cada assinatura garante que o traçado guardado no servidor não foi alterado.', M, doc.internal.pageSize.getHeight() - 20);

    doc.save('ME_' + m.numero_me + '.pdf');
  }

  function pdfScreen() {
    if (S.pdf.recentes === null) carregarRecentes();
    var recentes = (S.pdf.recentes || []).map(function (m) {
      var st = { PENDENTE: 'Pendente', EM_ATENDIMENTO: 'Em atendimento', ATENDIDO: 'Atendido', ATENDIDO_PARCIAL: 'Atendido parcial', CANCELADO: 'Cancelado' }[m.status] || m.status;
      return '<tr class="pdfrow" data-act="usarme" data-n="' + esc(m.numero_me) + '"><td class="mono">' + esc(m.numero_me) + '</td><td>' + (m.tipo === 'ENTRADA' ? 'Entrada' : 'Saída') + '</td><td>' + st + '</td><td>' + esc(dataBR(m.data_me)) + '</td><td>' + esc(m.local_aplicacao || '—') + '</td></tr>';
    }).join('');
    return '<div class="panel">' +
      '<div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">' +
      '<b style="font-size:15px">Gerar PDF de uma ME</b>' +
      '<span class="note">Traz os dados da requisição e as assinaturas já coletadas (Requisitante, Aprovador e Recebedor). O que ainda não foi assinado aparece como "Aguardando assinatura".</span>' +
      '<div class="row"><div class="field"><label>Número da ME</label><input class="inp" id="pdfNumero" placeholder="ex.: 0001" value="' + esc(S.pdf.numero) + '"></div>' +
      '<button class="btn p" data-act="gerarpdf"' + (S.pdf.gerando ? ' disabled' : '') + '>' + (S.pdf.gerando ? 'Gerando…' : 'Gerar PDF') + '</button></div>' +
      (S.pdf.erro ? '<div class="note err">' + esc(S.pdf.erro) + '</div>' : '') + '</div>' +
      '<div>' +
      '<b style="font-size:13px;color:#5E6A64">MEs recentes — toque para preencher o número</b>' +
      (S.pdf.recentes === null ? '<div class="empty">Carregando…</div>' :
        !S.pdf.recentes.length ? '<div class="empty">Nenhuma ME cadastrada ainda.</div>' :
        '<div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>ME</th><th>Tipo</th><th>Status</th><th>Data</th><th>Local</th></tr></thead><tbody>' + recentes + '</tbody></table></div>') +
      '</div></div>';
  }

  /* ---------- render ---------- */
  var acts = {
    login: doLogin, logout: logout,
    atualizar: function () { S.conf.data = el('confData') ? el('confData').value : S.conf.data; carregarConferencia(); },
    baixarplanilha: function () { S.conf.data = el('confData') ? el('confData').value : S.conf.data; baixarPlanilhaDia(); },
    fechar: fecharEBaixar,
    delprod: function (t) { delete S.cat[t.getAttribute('data-k')]; S.catMeta && (S.catMeta.total = Object.keys(S.cat).length); salvarCatalogo(); render(); },
    limparcat: limparCatalogo,
    exportarcat: exportarCatalogoCsv,
    gerarpdf: function () { var n = (el('pdfNumero') ? el('pdfNumero').value : S.pdf.numero).trim(); if (!n) { toast('Digite o número da ME.', true); return; } S.pdf.numero = n; gerarPdf(n); },
    usarme: function (t) { S.pdf.numero = t.getAttribute('data-n'); render(); var i = el('pdfNumero'); if (i) i.focus(); }
  };

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var fn = acts[t.getAttribute('data-act')];
    if (fn) fn(t);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'token') doLogin();
    if (e.target.id === 'pdfNumero') acts.gerarpdf();
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'token') S.loginVal = e.target.value;
    else if (e.target.id === 'prodFiltro') { S.prodFiltro = e.target.value; render(); }
    else if (e.target.id === 'substituir') { S.prodSubstituir = e.target.checked; }
    else if (e.target.id === 'pdfNumero') S.pdf.numero = e.target.value;
    else if (e.target.id === 'arquivoImport' && e.target.files[0]) { importarArquivo(e.target.files[0]); }
  });

  function loginScreen() {
    return '<div class="login"><b>Painel de Conferência</b>' +
      '<span class="note">Use o mesmo código de acesso (API_TOKEN) do servidor de estoque.</span>' +
      '<input class="inp" id="token" type="password" placeholder="Código de acesso" value="' + esc(S.loginVal) + '">' +
      (S.loginErr ? '<div class="note err">' + esc(S.loginErr) + '</div>' : '') +
      '<button class="btn p" data-act="login">Entrar</button></div>';
  }

  function render() {
    if (!S.token) { el('app').innerHTML = loginScreen(); return; }
    var abas = [['conferencia', 'Conferência'], ['produtos', 'Produtos'], ['pdf', 'PDF da ME']];
    var tabsHtml = abas.map(function (a) { return '<button class="tab' + (S.tab === a[0] ? ' a' : '') + '" data-act="tab" data-t="' + a[0] + '">' + a[1] + '</button>'; }).join('');
    var corpo = S.tab === 'conferencia' ? confScreen() : S.tab === 'produtos' ? prodScreen() : pdfScreen();
    el('app').innerHTML =
      '<div class="topbar"><b>Painel de Conferência</b><span>Baixa de Estoque</span><div class="sp"></div><button class="linkbtn" data-act="logout">Sair</button></div>' +
      '<div class="tabs">' + tabsHtml + '</div>' + corpo +
      (S.toast ? '<div class="toast' + (S.toastErr ? ' err' : '') + '" role="status">' + esc(S.toast) + '</div>' : '');
  }
  acts.tab = function (t) { S.tab = t.getAttribute('data-t'); render(); };

  if (S.token) carregarConferencia();
  render();
})();
