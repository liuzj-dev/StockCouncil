/* ============================================================
 *  StockCouncil · 前端工作台（零依赖原生 JavaScript）
 *  与后端 /api/analyze（SSE）对接，实时渲染四阶段委员会流水线。
 *  10 个角色 → 可分别绑定不同模型端口 → 失败自动沿降级链重试。
 * ============================================================ */
(() => {
'use strict';

/* ---------------- 通用工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const fmt = (v, d = 2) => { const n = num(v); return n == null ? '—' : n.toFixed(d); };
const lots = (v) => { const n = num(v); return n == null ? '—' : n >= 1e4 ? (n / 1e4).toFixed(2) + ' 万手' : n + ' 手'; };
const money = (v) => { const n = num(v); return n == null ? '—' : n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : (n / 1e4).toFixed(0) + ' 万'; };
const cap = (v) => { const n = num(v); return n == null ? '—' : (n / 1e8).toFixed(0) + ' 亿'; };
const pctS = (v) => { const n = num(v); return n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; };
const cls = (v) => { const n = num(v); return n == null || n === 0 ? 'muted' : n > 0 ? 'up' : 'down'; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dur = (ms) => { const v = Number(ms) || 0; return v < 1000 ? v + 'ms' : (v / 1000).toFixed(1) + 's'; };

/* ---------------- 静态元数据 ---------------- */
const SAMPLES = [
  { code: '600519', label: '贵州茅台' },
  { code: '000001', label: '平安银行' },
  { code: '300750', label: '宁德时代' },
  { code: '601318', label: '中国平安' },
  { code: '002594', label: '比亚迪' },
  { code: '688981', label: '中芯国际' }
];
const ROLE_ICON = {
  MACRO: '🌏', INDUSTRY: '🏭', TECHNICAL: '📈', FUNDS: '💰', FUNDAMENTAL: '📊',
  MANAGER_FUNDAMENTAL: '🎯', MANAGER_MOMENTUM: '🚀', RISK_SYSTEM: '🛡️', RISK_PORTFOLIO: '⚖️', GM: '👑'
};
const STAGE_META = {
  1: { cls: 's1', badge: 'Stage 1' },
  2: { cls: 's2', badge: 'Stage 2' },
  3: { cls: 's3', badge: 'Stage 3' },
  4: { cls: 's4', badge: 'Stage 4' }
};
const LOCAL_STAGE_LABELS = {
  0: '数据层 · 多源行情采集与指标计算',
  1: '第一阶段 · 专业分析师团队（并行）',
  2: '第二阶段 · 总监整合层',
  3: '第三阶段 · 风险控制层',
  4: '第四阶段 · 最高决策层'
};
const ACTION_CLS = { '买入': 'buy', '卖出': 'sell', '观望': 'hold' };

/* ---------------- 运行状态 ---------------- */
const state = {
  running: false,
  providers: [],
  summary: null,
  nodes: [],
  cards: {},
  stages: {},
  stageLabels: { ...LOCAL_STAGE_LABELS },
  controller: null,
  quote: null,
  technicals: null,
  kline: []
};
/* ---------------- 轻量 Markdown → HTML ---------------- */
function mdInline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
function mdToHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r/g, '').split('\n');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }
    if (/^\s*```/.test(line)) continue;
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeList(); const lv = Math.min(m[1].length + 1, 4); out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>'); continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { closeList(); out.push('<hr/>'); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { closeList(); out.push('<blockquote>' + mdInline(m[1]) + '</blockquote>'); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + mdInline(m[1]) + '</li>'); continue; }
    closeList();
    out.push('<p>' + mdInline(line) + '</p>');
  }
  closeList();
  return out.join('');
}
/* ---------------- Canvas 图表（零依赖） ---------------- */
function prep(cv, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.parentElement.clientWidth || 320;
  const hh = h || 150;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.round(hh * dpr);
  cv.style.height = hh + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  return { ctx, w, h: hh };
}
function drawBar(cv, data) {
  const { ctx, w, h } = prep(cv, 150);
  if (!data || !data.length) return;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const n = data.length, gap = 8, bw = Math.max(6, (w - gap * (n + 1)) / n);
  data.forEach((d, i) => {
    const x = gap + i * (bw + gap);
    const bh = Math.abs(d.value) / max * (h - 48);
    const y = h - 24 - bh;
    ctx.fillStyle = d.value >= 0 ? 'rgba(240,82,95,.85)' : 'rgba(38,194,129,.85)';
    ctx.fillRect(x, y, bw, Math.max(1, bh));
    ctx.fillStyle = '#8ea0bd'; ctx.font = '10px Consolas,monospace'; ctx.textAlign = 'center';
    ctx.fillText(String(d.label).slice(0, 6), x + bw / 2, h - 9);
    ctx.fillStyle = '#e6edf7';
    ctx.fillText(String(d.value), x + bw / 2, Math.max(10, y - 4));
  });
}
function drawRadar(cv, axes) {
  const { ctx, w, h } = prep(cv, 180);
  if (!axes || !axes.length) return;
  const cx = w / 2, cy = h / 2 + 4, R = Math.min(w, h) / 2 - 28;
  const n = axes.length;
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + (i % n) * (2 * Math.PI / n);
      const r = R * ring / 4;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = 'rgba(148,163,184,.14)'; ctx.stroke();
  }
  ctx.beginPath();
  axes.forEach((ax, i) => {
    const a = -Math.PI / 2 + i * (2 * Math.PI / n);
    const r = R * clamp(ax.value, 0, 100) / 100;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(56,189,248,.22)'; ctx.fill();
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#8ea0bd'; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'center';
  axes.forEach((ax, i) => {
    const a = -Math.PI / 2 + i * (2 * Math.PI / n);
    const x = cx + (R + 14) * Math.cos(a), y = cy + (R + 14) * Math.sin(a) + 3;
    ctx.fillText(String(ax.label).slice(0, 5), x, y);
  });
}
function drawKline(cv, bars) {
  const { ctx, w, h } = prep(cv, 150);
  if (!bars || !bars.length) return;
  const volH = 30, top = 10, pad = 4;
  const priceH = h - volH - top - 18;
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  const rng = hi - lo || 1;
  const bw = w / bars.length;
  const maxVol = Math.max(...bars.map((b) => b.volume || 0), 1);
  bars.forEach((b, i) => {
    const x = i * bw;
    const col = b.close >= b.open ? '#f0525f' : '#26c281';
    const yO = top + priceH - ((b.open - lo) / rng) * priceH;
    const yC = top + priceH - ((b.close - lo) / rng) * priceH;
    const yH = top + priceH - ((b.high - lo) / rng) * priceH;
    const yL = top + priceH - ((b.low - lo) / rng) * priceH;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + bw / 2, yH); ctx.lineTo(x + bw / 2, yL); ctx.stroke();
    const bh = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x + bw * 0.2, Math.min(yO, yC), Math.max(1, bw * 0.6), bh);
    const vh = (b.volume || 0) / maxVol * volH;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x + bw * 0.2, h - 12 - vh, Math.max(1, bw * 0.6), vh);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = '#5f7391'; ctx.font = '10px Consolas,monospace'; ctx.textAlign = 'left';
  ctx.fillText(fmt(hi), pad, 10);
  ctx.fillText(fmt(lo), pad, top + priceH);
  ctx.fillText((bars[0].date || '') + ' → ' + (bars[bars.length - 1].date || ''), pad, h - 1);
}
/* ---------------- 数据层渲染 ---------------- */
function renderMarket(ev) {
  const q = ev.quote || {};
  state.quote = q;
  state.technicals = ev.technicals || null;
  state.kline = ev.kline || [];
  $('#marketPanel').hidden = false;
  $('#qName').textContent = q.name || '—';
  $('#qCode').textContent = (q.code || '') + '  ' + String(q.market || '').toUpperCase();
  const priceNode = $('#qPrice');
  priceNode.textContent = fmt(q.price);
  priceNode.className = cls(q.changePct);
  const ch = $('#qChange');
  ch.textContent = pctS(q.changePct) + '   ' + (num(q.change) >= 0 ? '+' : '') + fmt(q.change);
  ch.className = cls(q.changePct);
  $('#qWarn').hidden = !q.synthetic;
  renderOrderbook(q);
  renderTech(ev.technicals);
  if (state.kline.length) drawKline($('#klineCanvas'), state.kline);
  const prov = ev.provenance || {};
  const extra = (prov.fallbacks && prov.fallbacks.length) ? ' · 备用源 ' + prov.fallbacks.join('/') : '';
  $('#marketProvenance').textContent = '数据源：' + (prov.source || '—') + extra + ' · ' + (q.time || '');
}
function renderOrderbook(q) {
  const t = $('#obTable');
  const asks = (q.asks || []).slice().sort((a, b) => b.level - a.level);
  const bids = (q.bids || []).slice().sort((a, b) => b.level - a.level);
  if (!asks.length && !bids.length) {
    t.innerHTML = '<div class="muted" style="padding:8px 0">该数据源未提供五档盘口</div>';
    $('#obRatio').textContent = '';
    return;
  }
  const maxV = Math.max(...[...asks, ...bids].map((r) => r.volumeLots || 0), 1);
  const row = (r, side, tag) => {
    const p = (r.volumeLots || 0) / maxV * 100;
    const color = side === 'ask' ? 'rgba(240,82,95,.65)' : 'rgba(38,194,129,.65)';
    return '<div class="ob-row ' + side + '"><em>' + tag + '</em><div class="ob-bar"><i style="width:' + p.toFixed(1) + '%;background:' + color + '"></i></div><span>' + fmt(r.price) + ' / ' + lots(r.volumeLots) + '</span></div>';
  };
  t.innerHTML =
    asks.map((r) => row(r, 'ask', '卖' + r.level)).join('') +
    '<div class="ob-row mid"><em>现价</em><div></div><span style="font-weight:700">' + fmt(q.price) + '</span></div>' +
    bids.map((r) => row(r, 'bid', '买' + r.level)).join('');
  const sumB = (q.bids || []).reduce((a, r) => a + (r.volumeLots || 0), 0);
  const sumA = (q.asks || []).reduce((a, r) => a + (r.volumeLots || 0), 0);
  const ratio = sumA ? sumB / sumA : 0;
  const tone = ratio >= 1.15 ? '买盘承接更强，短线偏多承接' : ratio <= 0.85 ? '卖压相对更重，注意抛压' : '买卖力量接近均衡';
  $('#obRatio').innerHTML = '买卖盘比 <b class="' + (ratio >= 1 ? 'up' : 'down') + '">' + sumB + ' / ' + sumA + ' = ' + ratio.toFixed(2) + '</b> · ' + tone + '。';
}
function renderTech(t) {
  const box = $('#techChips');
  if (!t) { box.innerHTML = '<span class="muted">无 K 线数据，无法计算技术指标</span>'; return; }
  const chips = [
    ['MA5', fmt(t.ma5)], ['MA10', fmt(t.ma10)], ['MA20', fmt(t.ma20)], ['MA60', fmt(t.ma60)],
    ['60日分位', t.range60 ? t.range60.positionPct + '%' : '—'],
    ['250日回撤', t.range250 ? t.range250.drawdownPct + '%' : '—'],
    ['20日年化波动', t.vol20AnnualPct + '%'],
    ['5日均量', t.avgVolume5Lots ? lots(t.avgVolume5Lots) : '—'],
    ['20日均量', t.avgVolume20Lots ? lots(t.avgVolume20Lots) : '—'],
    ['近20日阳线', t.upDaysLast20 + ' 天']
  ];
  box.innerHTML = chips.map((c) => '<span class="tech-chip">' + c[0] + ' <b>' + c[1] + '</b></span>').join('');
}
/* Stage 0 卡片内的数据摘要条 */
function renderDataStrip(ev) {
  const rec = state.stages[0];
  if (!rec) return;
  const q = ev.quote || {}, t = ev.technicals || {}, prov = ev.provenance || {};
  const indCount = ['ma5', 'ma10', 'ma20', 'ma60', 'vol20AnnualPct', 'avgVolume5Lots', 'avgVolume20Lots', 'upDaysLast20']
    .filter((k) => t[k] != null).length + (t.range60 ? 1 : 0) + (t.range250 ? 1 : 0);
  const cells = [
    ['数据源', (prov.source || '—') + (q.synthetic ? ' ⚠️合成' : '') + (q.time ? ' · ' + q.time : '')],
    ['最新价', fmt(q.price) + '   ' + pctS(q.changePct)],
    ['日K样本', (ev.kline || []).length + ' 根'],
    ['五档盘口', ((q.bids || []).length + (q.asks || []).length) + ' 档'],
    ['派生指标', indCount + ' 项'],
    ['指数快照', ((ev.indices || []).length) + ' 个']
  ];
  let strip = rec.grid.querySelector('.data-strip');
  if (!strip) { strip = el('div', 'data-strip'); rec.grid.appendChild(strip); }
  strip.innerHTML = cells.map((c) => '<span class="ds-cell"><em>' + c[0] + '</em><b>' + esc(c[1]) + '</b></span>').join('');
}

/* ---------------- 决策层渲染 ---------------- */
function renderDecision(decision, agg, summary) {
  $('#decisionPanel').hidden = false;
  const d = decision || {}, a = agg || {};
  const act = d.action || '观望';
  const dAction = $('#dAction');
  dAction.textContent = act;
  dAction.className = 'dvalue ' + (ACTION_CLS[act] || 'hold');
  $('#dPosition').textContent = (d.position == null ? '—' : d.position + '%');
  $('#dConsistency').textContent = a.consistency || '—';
  $('#dBias').textContent = (a.biasIndex == null ? '—' : a.biasIndex) + '  /  ' + (a.avgScore == null ? '—' : a.avgScore);

  const counts = a.counts || {};
  const order = ['强多', '偏多', '中性', '偏空', '强空'];
  $('#verdictBar').innerHTML =
    order.map((k) => '<span class="vchip"><span class="vtag ' + k + '">' + k + '</span><small>' + (counts[k] || 0) + '</small></span>').join('') +
    '<span class="vchip"><small>规则引擎</small><b>' + (a.engineAction || '—') + '</b><small>' + (a.enginePosition == null ? '' : '/' + a.enginePosition + '%') + '</small></span>' +
    '<span class="vchip"><small>总经理</small><b>' + (a.gmAction || '—') + '</b><small>' + (a.gmPosition == null ? '' : '/' + a.gmPosition + '%') + '</small></span>';

  const alerts = [];
  if (a.strongBullStructure) alerts.push('🚀 动能三角（技术 / 资金 / 动能总监）一致偏多，结构性强势。');
  if (a.veto) alerts.push('🛡️ 系统性风险总监触发一票否决，最终仓位被强制压至 20% 以内。');
  if (a.conflict) alerts.push('⚠️ 总经理指令与规则引擎复核结果不一致，已以总经理为准并标注分歧。');
  if (summary && summary.mockedRoles && summary.mockedRoles.length) alerts.push('🧪 部分角色运行在 Mock 演示端口：' + summary.mockedRoles.join('、'));
  if (summary && summary.degradedRoles && summary.degradedRoles.length) alerts.push('🔻 发生端口降级的角色：' + summary.degradedRoles.join('、'));
  const al = $('#decisionAlert');
  al.hidden = !alerts.length;
  al.innerHTML = alerts.join('<br/>');

  if (summary) {
    const used = (summary.providersUsed || []).join('、') || '—';
    $('#decisionMeta').textContent = (summary.symbol || '') + ' · 耗时 ' + dur(summary.elapsedMs) + ' · 调用端口：' + used;
  }
}

/* ---------------- 流水线 & 角色卡片 ---------------- */
function ensureStage(stage, label) {
  if (state.stages[stage]) {
    if (label) { state.stageLabels[stage] = label; const h = $('.stage-head h3 span:last-child', state.stages[stage].sec); if (h) h.textContent = label; }
    return state.stages[stage];
  }
  if (label) state.stageLabels[stage] = label;
  const meta = STAGE_META[stage] || { cls: 's0', badge: 'Stage 0' };
  const sec = el('section', 'stage');
  const head = el('div', 'stage-head');
  const h3 = el('h3', null, '<span class="badge ' + meta.cls + '">' + meta.badge + '</span><span>' + esc(state.stageLabels[stage] || '') + '</span>');
  const st = el('span', 'stage-state', stage === 0 ? '采集中…' : '等待中…');
  head.appendChild(h3); head.appendChild(st);
  const grid = el('div', 'agents ' + (STAGE_META[stage] ? 's' + stage : 's0'));
  sec.appendChild(head); sec.appendChild(grid);
  $('#stages').appendChild(sec);
  const rec = { sec, grid, state: st };
  state.stages[stage] = rec;
  return rec;
}
function setStageState(stage, text, color) {
  const rec = state.stages[stage];
  if (!rec) return;
  rec.state.textContent = text;
  rec.state.style.color = color || '';
}
function addCard(role, stage) {
  if (state.cards[role]) return state.cards[role];
  const rec = ensureStage(stage, '');
  const card = el('article', 'agent running');
  card.id = 'agent-' + role;
  const node = state.nodes.find((n) => n.role === role) || {};
  card.innerHTML =
    '<div class="agent-head">' +
      '<div class="agent-icon">' + (ROLE_ICON[role] || '🤖') + '</div>' +
      '<div><div class="agent-title">' + esc(node.title || role) + '</div>' +
      '<div class="agent-name">' + esc(node.name || '') + '</div></div>' +
      '<span class="agent-flag">等待</span>' +
    '</div>' +
    '<div class="agent-body"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>';
  rec.grid.appendChild(card);
  const r = { card, body: $('.agent-body', card), flag: $('.agent-flag', card), pending: [] };
  state.cards[role] = r;
  return r;
}
function addPlaceholders() {
  ensureStage(0, LOCAL_STAGE_LABELS[0]);
  for (const stage of [1, 2, 3, 4]) {
    ensureStage(stage, LOCAL_STAGE_LABELS[stage]);
    state.nodes.filter((n) => n.stage === stage).forEach((n) => addCard(n.role, stage));
  }
}
function renderAgent(ev) {
  const rec = state.cards[ev.role] || addCard(ev.role, ev.stage || 1);
  const card = rec.card;
  card.classList.remove('running');
  if (ev.providerLabel) { rec.flag.textContent = ev.providerLabel; rec.flag.className = 'agent-flag' + (ev.mocked ? ' mock' : ''); }
  const v = ev.verdict || {};
  let html = '';
  if (v.key_point) html += '<blockquote>' + esc(v.key_point) + '</blockquote>';
  html += '<div class="md">' + mdToHtml(ev.text || '') + '</div>';
  const pending = [];
  (ev.charts || []).forEach((c) => {
    const cid = 'chart-' + ev.role + '-' + Math.random().toString(36).slice(2, 7);
    if (c.chartType === 'radar' || c.chartType === 'radar-chart') {
      const axes = (c.data || []).map((d) => ({ label: d.label || d.name || d.axis || '', value: Number(d.value != null ? d.value : (d.score != null ? d.score : 0)) }));
      html += '<canvas id="' + cid + '" height="180"></canvas>';
      pending.push({ cid, kind: 'radar', data: axes });
    } else {
      const data = (c.data || []).map((d) => ({ label: d.label || d.name || d.sector || '', value: Number(d.value != null ? d.value : (d.score != null ? d.score : (d.pct != null ? d.pct : 0))) }));
      html += '<canvas id="' + cid + '" height="150"></canvas>';
      pending.push({ cid, kind: 'bar', data });
    }
  });
  rec.body.innerHTML = html;
  pending.forEach((p) => { const cv = document.getElementById(p.cid); if (cv) { if (p.kind === 'radar') drawRadar(cv, p.data); else drawBar(cv, p.data); } });

  let foot = '<div class="agent-foot">';
  foot += '<span class="vtag ' + (v.stance || '中性') + '">' + (v.stance || '中性') + ' · ' + (v.score == null ? '—' : v.score) + '分</span>';
  foot += '<span class="meta-tag">置信 ' + (v.confidence == null ? '—' : Math.round(v.confidence * 100) + '%') + '</span>';
  if (v.horizon) foot += '<span class="meta-tag">' + esc(v.horizon) + '</span>';
  if (v.action) foot += '<span class="meta-tag">' + esc(v.action) + '</span>';
  if (v.veto) foot += '<span class="meta-tag deg">一票否决</span>';
  if (ev.provider) foot += '<span class="meta-tag">' + esc(ev.providerLabel || ev.provider) + (ev.model ? ' · ' + esc(ev.model) : '') + '</span>';
  if (ev.latencyMs) foot += '<span class="meta-tag">' + dur(ev.latencyMs) + '</span>';
  if (ev.degraded) foot += '<span class="meta-tag deg">已降级</span>';
  if (ev.mocked) foot += '<span class="meta-tag deg">Mock</span>';
  if (v.parseMode === 'fallback') foot += '<span class="meta-tag deg">非结构化</span>';
  foot += '</div>';
  card.insertAdjacentHTML('beforeend', foot);
  if (ev.error) card.classList.add('failed');
}
/* ---------------- 状态提示 ---------------- */
function setStatus(kind, text) {
  const pill = $('#statusPill');
  pill.className = 'pill' + (kind ? ' ' + kind : '');
  const span = pill.querySelector('span');
  if (span) span.textContent = text;
}
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div'); t.id = 'toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:rgba(240,82,95,.95);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.45);transition:opacity .35s;opacity:0;max-width:80vw;text-align:center';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = '0'; }, 3800);
}

/* ---------------- 事件分发 ---------------- */
function handleEvent(ev) {
  switch (ev.type) {
    case 'start':
      state.offlineDemo = !!ev.offlineDemo;
      break;
    case 'stage_start':
      ensureStage(ev.stage, ev.label);
      if (ev.stage > 0) {
        setStageState(ev.stage, '进行中…', 'var(--accent)');
        (ev.roles || []).forEach((role) => addCard(role, ev.stage));
      } else {
        setStageState(0, '采集中…', 'var(--accent)');
      }
      break;
    case 'market':
      renderMarket(ev);
      setStageState(0, '已完成', 'var(--down)');
      renderDataStrip(ev);
      break;
    case 'agent_start': {
      const rec = state.cards[ev.role];
      if (rec) rec.flag.textContent = ev.attempt ? '降级 #' + ev.attempt + ' · ' + ev.provider : '调用 ' + ev.provider;
      break;
    }
    case 'agent_done':
      renderAgent(ev);
      break;
    case 'agent_error': {
      const rec = state.cards[ev.role];
      if (rec) rec.flag.textContent = '端口 ' + ev.provider + ' 失败，降级中…';
      break;
    }
    case 'stage_done':
      if (ev.stage === 0) setStageState(0, '已完成', 'var(--down)');
      else setStageState(ev.stage, '已完成', 'var(--down)');
      break;
    case 'decision':
      renderDecision(ev.decision, ev.aggregation, ev.summary);
      // 结论出来后自动定位到 Stage 5 决策面板（DOM 中位于流水线之后）
      try { $('#decisionPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ }
      break;
    case 'done':
      setStatus('ok', '完成 · ' + dur(ev.elapsedMs));
      break;
    case 'fatal':
      setStatus('err', '中断');
      toast('⚠️ ' + (ev.error || '分析中断'));
      break;
  }
}

/* ---------------- SSE 分析主流程 ---------------- */
async function analyze(symbol) {
  if (state.running) return;
  symbol = String(symbol || '').trim();
  if (!symbol) { toast('请输入股票代码'); return; }
  reset();
  state.running = true;
  setStatus('run', '分析中…');
  $('#hero').hidden = true;
  $('#marketPanel').hidden = false;
  $('#decisionPanel').hidden = true;
  $('#btnReset').hidden = false;
  $('#btnAnalyze').disabled = true;
  addPlaceholders();
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* ignore */ }

  const ctrl = new AbortController();
  state.controller = ctrl;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
      signal: ctrl.signal
    });
    if (!res.ok || !res.body) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          const s = line.trim();
          if (!s || s.startsWith(':')) continue;
          if (s.startsWith('data:')) {
            const payload = s.slice(5).trim();
            if (!payload) continue;
            try { handleEvent(JSON.parse(payload)); } catch (e) { /* ignore bad frame */ }
          }
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      setStatus('err', '失败');
      toast('分析失败：' + (e.message || e));
      $('#hero').hidden = false;
    }
  } finally {
    state.running = false;
    state.controller = null;
    $('#btnAnalyze').disabled = false;
    const pill = $('#statusPill');
    if (pill.classList.contains('run')) setStatus('ok', '完成');
  }
}
/* ---------------- 抽屉 ---------------- */
function openDrawer(title) {
  $('#drawerTitle').textContent = title;
  $('#drawer').hidden = false;
  $('#drawerMask').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerMask').hidden = true; }

function statusText(s) { return s === 'ready' ? '就绪' : s === 'reserved' ? '预留' : '待配置'; }

function showProviders() {
  openDrawer('模型端口');
  const body = $('#drawerBody');
  body.innerHTML = '<div class="empty">加载中…</div>';
  fetch('/api/providers').then((r) => r.json()).then((p) => {
    state.providers = p.providers || [];
    state.summary = p.summary || null;
    const s = p.summary || { ready: [], missing: [], reserved: [], total: 0 };
    let html = '<div class="legend"><span>共 ' + s.total + ' 个端口</span><span>就绪 ' + (s.ready || []).length + '</span><span>待配置 ' + (s.missing || []).length + '</span><span>预留 ' + (s.reserved || []).length + '</span></div>';
    html += state.providers.map(provCard).join('');
    html += '<div class="legend"><span>提示：在项目根目录的 .env 中填入对应 API Key 后重启即可启用；ChatGPT 端口为预留插槽，需同时配置 CHATGPT_BASE_URL 与 CHATGPT_API_KEY。</span></div>';
    body.innerHTML = html;
    body.querySelectorAll('.prov').forEach((box) => {
      const id = box.getAttribute('data-id');
      const btn = box.querySelector('.ping');
      const out = box.querySelector('.ping-out');
      btn.addEventListener('click', async () => {
        const model = box.querySelector('.model') ? box.querySelector('.model').value : '';
        btn.disabled = true; out.className = 'ping-out'; out.textContent = '自检中…';
        try {
          const r = await fetch('/api/providers/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
          const j = await r.json();
          const res = (j.results || [])[0] || {};
          if (res.ok) { out.className = 'ping-out ok'; out.textContent = '✓ 连通 · ' + (res.latencyMs || 0) + 'ms · ' + (res.model || model) + (res.sample ? ' · “' + res.sample + '”' : ''); }
          else { out.className = 'ping-out bad'; out.textContent = '✗ ' + (res.error || '失败'); }
        } catch (e) { out.className = 'ping-out bad'; out.textContent = '✗ ' + (e.message || e); }
        btn.disabled = false;
      });
    });
  }).catch((e) => { body.innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + '</div>'; });
}

function provCard(p) {
  const models = (p.models || []).map((m) => '<option value="' + esc(m) + '"' + (m === p.defaultModel ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
  return '<div class="prov" data-id="' + esc(p.id) + '">' +
    '<div class="prov-head">' +
      '<span class="prov-label">' + esc(p.label) + '</span>' +
      '<span class="st ' + p.status + '">' + statusText(p.status) + '</span>' +
      '<span class="muted" style="font-size:11.5px">' + esc(p.tag || '') + '</span>' +
    '</div>' +
    '<div class="prov-note">' + esc(p.note || '') + '</div>' +
    '<div class="prov-row">' +
      '<span>ENV ' + esc(p.envKey || '—') + '</span>' +
      (p.keyHint ? '<span>KEY ' + esc(p.keyHint) + '</span>' : '') +
      '<span>' + esc(p.baseUrl || '未配置 BASE_URL') + '</span>' +
    '</div>' +
    '<div class="prov-actions">' +
      '<select class="sel model">' + models + '</select>' +
      '<button class="ghost ping">自检</button>' +
      '<span class="ping-out"></span>' +
    '</div>' +
  '</div>';
}

function showRouting() {
  openDrawer('角色路由');
  const body = $('#drawerBody');
  body.innerHTML = '<div class="empty">加载中…</div>';
  Promise.all([
    fetch('/api/nodes').then((r) => r.json()),
    fetch('/api/providers').then((r) => r.json())
  ]).then(([n, p]) => {
    state.nodes = n.nodes || [];
    state.providers = p.providers || [];
    let html = '<div class="legend"><span>为每个角色指定固定端口；选「自动（auto）」则按优先级挑选第一个就绪端口。</span></div>';
    html += '<div class="route-row" style="font-weight:700;color:var(--muted)"><span>角色</span><span>端口</span><span>模型</span></div>';
    html += state.nodes.map((n2) => routeRow(n2)).join('');
    html += '<div style="display:flex;gap:10px;margin-top:6px"><button class="primary" id="saveRouting">保存路由</button><span class="ping-out" id="routingOut"></span></div>';
    body.innerHTML = html;
    body.querySelectorAll('.route-row[data-role]').forEach((row) => {
      const provSel = row.querySelector('.rp');
      const modelSel = row.querySelector('.rm');
      provSel.addEventListener('change', () => {
        const id = provSel.value;
        const prov = state.providers.find((x) => x.id === id);
        const models = prov ? prov.models : [];
        modelSel.innerHTML = '<option value="">默认</option>' + models.map((m) => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
      });
    });
    $('#saveRouting').addEventListener('click', async () => {
      const routing = {};
      body.querySelectorAll('.route-row[data-role]').forEach((row) => {
        routing[row.getAttribute('data-role')] = { provider: row.querySelector('.rp').value, model: row.querySelector('.rm').value };
      });
      const out = $('#routingOut');
      out.className = 'ping-out'; out.textContent = '保存中…';
      try {
        const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routing }) });
        const j = await r.json();
        if (j.ok) { out.className = 'ping-out ok'; out.textContent = '✓ 已保存'; toast('路由配置已保存'); }
        else { out.className = 'ping-out bad'; out.textContent = '✗ ' + (j.error || '失败'); }
      } catch (e) { out.className = 'ping-out bad'; out.textContent = '✗ ' + (e.message || e); }
    });
  }).catch((e) => { body.innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + '</div>'; });
}

function routeRow(n) {
  const cur = n.routing || { provider: 'auto', model: '' };
  const opts = ['<option value="auto"' + (cur.provider === 'auto' ? ' selected' : '') + '>自动（auto）</option>']
    .concat(state.providers.map((p) => '<option value="' + esc(p.id) + '"' + (cur.provider === p.id ? ' selected' : '') + '>' + esc(p.label) + (p.status === 'missing-key' ? '（待配置）' : p.status === 'reserved' ? '（预留）' : '') + '</option>'))
    .join('');
  const prov = state.providers.find((p) => p.id === cur.provider);
  const models = ['<option value="">默认</option>'].concat((prov ? prov.models : []).map((m) => '<option value="' + esc(m) + '"' + (cur.model === m ? ' selected' : '') + '>' + esc(m) + '</option>')).join('');
  return '<div class="route-row" data-role="' + esc(n.role) + '">' +
    '<span>' + (ROLE_ICON[n.role] || '') + ' ' + esc(n.title) + '</span>' +
    '<select class="sel rp">' + opts + '</select>' +
    '<select class="sel rm">' + models + '</select>' +
  '</div>';
}

function showHistory() {
  openDrawer('历史记录');
  const body = $('#drawerBody');
  body.innerHTML = '<div class="empty">加载中…</div>';
  fetch('/api/history').then((r) => r.json()).then((j) => {
    const items = j.items || [];
    if (!items.length) { body.innerHTML = '<div class="empty">还没有历史记录，先跑一次分析吧。</div>'; return; }
    let html = '<div class="legend"><span>共 ' + items.length + ' 条（每条最多保留 100 条）</span><button class="ghost danger" id="clearHist" style="margin-left:auto">清空</button></div>';
    html += items.map((it) => histRow(it)).join('');
    body.innerHTML = html;
    body.querySelectorAll('.hist[data-id]').forEach((box) => {
      const id = box.getAttribute('data-id');
      box.querySelector('.replay').addEventListener('click', async () => {
        const r = await fetch('/api/history/' + encodeURIComponent(id));
        const jj = await r.json();
        if (jj.ok && jj.item) { closeDrawer(); replay(jj.item); }
        else toast('读取历史失败');
      });
      box.querySelector('.del').addEventListener('click', async () => {
        await fetch('/api/history/' + encodeURIComponent(id), { method: 'DELETE' });
        box.remove();
        if (!body.querySelector('.hist')) body.innerHTML = '<div class="empty">已清空。</div>';
      });
    });
    const clr = $('#clearHist');
    if (clr) clr.addEventListener('click', async () => {
      await fetch('/api/history', { method: 'DELETE' });
      body.innerHTML = '<div class="empty">已清空。</div>';
    });
  }).catch((e) => { body.innerHTML = '<div class="empty">加载失败：' + esc(e.message || e) + '</div>'; });
}

function histRow(it) {
  const actCls = ACTION_CLS[it.action] === 'buy' ? 'a-buy' : ACTION_CLS[it.action] === 'sell' ? 'a-sell' : 'a-hold';
  const d = new Date(it.timestamp);
  const time = d.toLocaleString('zh-CN', { hour12: false });
  return '<div class="hist" data-id="' + esc(it.id) + '">' +
    '<div class="hist-main">' +
      '<span class="hist-sym">' + esc(it.symbol) + ' <span class="muted" style="font-weight:400">' + esc(it.name || '') + '</span></span>' +
      '<span class="hist-sub">' + time + ' · <span class="' + actCls + '">' + esc(it.action || '—') + '</span> ' + (it.position == null ? '' : it.position + '%') + ' · ' + (it.consistency || '') + ' · ' + dur(it.elapsedMs) + (it.mocked ? ' · Mock' : '') + '</span>' +
    '</div>' +
    '<div class="hist-actions"><button class="ghost replay">回放</button><button class="ghost danger del">删除</button></div>' +
  '</div>';
}
/* ---------------- 历史回放 ---------------- */
function replay(item) {
  reset();
  $('#hero').hidden = true;
  $('#marketPanel').hidden = false;
  $('#decisionPanel').hidden = false;
  $('#btnReset').hidden = false;
  addPlaceholders();
  const m = item.market || {};
  if (m.quote) renderMarket({ quote: m.quote, technicals: m.technicals, kline: [], provenance: m.provenance || {} });
  setStageState(0, '历史数据', 'var(--muted)');
  const outs = item.outputs || {};
  for (const role of Object.keys(outs)) {
    const node = state.nodes.find((n) => n.role === role) || {};
    renderAgent(Object.assign({ role, stage: node.stage || 1 }, outs[role]));
  }
  for (const stage of [1, 2, 3, 4]) setStageState(stage, '已归档', 'var(--muted)');
  renderDecision(item.decision, item.aggregation, item.summary);
  setStatus('ok', '已回放历史记录');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------- 复位 ---------------- */
function reset() {
  try { if (state.controller) state.controller.abort(); } catch (e) { /* ignore */ }
  state.running = false;
  state.controller = null;
  state.cards = {};
  state.stages = {};
  state.quote = null;
  state.technicals = null;
  state.kline = [];
  $('#stages').innerHTML = '';
  $('#decisionPanel').hidden = true;
  $('#marketPanel').hidden = true;
  $('#decisionAlert').hidden = true;
  $('#verdictBar').innerHTML = '';
  $('#qKv').innerHTML = '';
  $('#obTable').innerHTML = '';
  $('#obRatio').innerHTML = '';
  $('#techChips').innerHTML = '';
  $('#marketProvenance').textContent = '';
  $('#btnReset').hidden = true;
  $('#btnAnalyze').disabled = false;
  setStatus('', '待机');
}

/* ---------------- 初始化 ---------------- */
async function loadMeta() {
  try {
    const st = await fetch('/api/status').then((r) => r.json());
    const p = await fetch('/api/providers').then((r) => r.json());
    const n = await fetch('/api/nodes').then((r) => r.json());
    state.providers = p.providers || [];
    state.summary = p.summary || null;
    state.nodes = n.nodes || [];
    $('#demoTag').hidden = !st.offlineDemo;
    updateProviderHint();
  } catch (e) {
    $('#providerHint').textContent = '无法连接后端服务，请确认已运行 node server/index.mjs';
  }
}
function updateProviderHint() {
  const s = state.summary || { ready: [], missing: [], reserved: [] };
  const ready = state.providers.filter((p) => p.status === 'ready' && p.id !== 'mock');
  if (ready.length) {
    $('#providerHint').textContent = '已就绪端口：' + ready.map((p) => p.label).join('、') + '（含 Mock 演示端口兜底）';
  } else {
    $('#providerHint').textContent = '未检测到真实模型端口，将使用 Mock 演示端口跑通全流程；在 .env 中配置 API Key 后重启即可接入真实模型。';
  }
  const reserved = state.providers.filter((p) => p.status === 'reserved');
  if (reserved.length) $('#providerHint').textContent += ' 预留端口：' + reserved.map((p) => p.label).join('、') + '。';
}

function boot() {
  const chips = $('#sampleChips');
  chips.innerHTML = SAMPLES.map((s) => '<button class="chip" data-code="' + s.code + '">' + s.label + ' ' + s.code + '</button>').join('');
  chips.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { $('#symbolInput').value = b.getAttribute('data-code'); analyze(b.getAttribute('data-code')); }));

  $('#btnAnalyze').addEventListener('click', () => analyze($('#symbolInput').value));
  $('#symbolInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze($('#symbolInput').value); });
  $('#btnReset').addEventListener('click', () => { reset(); $('#hero').hidden = false; window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#btnProviders').addEventListener('click', showProviders);
  $('#btnRouting').addEventListener('click', showRouting);
  $('#btnHistory').addEventListener('click', showHistory);
  $('#btnCloseDrawer').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  window.addEventListener('resize', () => {
    if (state.kline.length && !$('#marketPanel').hidden) drawKline($('#klineCanvas'), state.kline);
  });

  loadMeta();
}
document.addEventListener('DOMContentLoaded', boot);
})();