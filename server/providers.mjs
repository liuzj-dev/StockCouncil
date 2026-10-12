/**
 * providers.mjs —— 统一模型端口适配层（LLM Gateway）
 *
 *   ┌────────────┐   chat({system,user,...})   ┌──────────────┐
 *   │ orchestrator│ ─────────────────────────► │  providers   │ ──► Gemini 原生协议
 *   └────────────┘                            │  统一适配器   │ ──► OpenAI 兼容协议 (Grok / OpenAI / ChatGPT / DeepSeek / Qwen / 自定义)
 *                                             └──────────────┘ ──► Mock 离线
 * 所有端口返回完全一致的结构，编排层不需要知道底层是谁。
 */
import { providerStatus, providerBaseUrl, providerById } from './config.mjs';

const DEFAULT_TIMEOUT = 120000;

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时 (${ms}ms)`)), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function errorMessage(provider, res, body) {
  const detail =
    body?.error?.message ||
    body?.error ||
    body?.message ||
    (body?._raw ? String(body._raw).slice(0, 300) : '') ||
    res.statusText;
  return `[${provider}] HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Gemini 原生协议                                                     */
/* ------------------------------------------------------------------ */
async function callGemini(prov, opts) {
  const key = process.env[prov.envKey];
  const base = providerBaseUrl(prov);
  const model = opts.model || prov.defaultModel;
  const body = {
    contents: [{ role: 'user', parts: [{ text: opts.user }] }],
    generationConfig: { temperature: opts.temperature ?? 0.4 },
    ...(opts.jsonMode ? { generationConfig: { temperature: opts.temperature ?? 0.4, responseMimeType: 'application/json' } } : {})
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (opts.webSearch !== false) body.tools = [{ googleSearch: {} }];

  const t = withTimeout(opts.timeoutMs || DEFAULT_TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: t.signal
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(prov.label, res, data));
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new Error(`[${prov.label}] 返回内容为空 (finishReason=${cand?.finishReason || 'unknown'})`);
    return {
      text,
      model,
      provider: prov.id,
      latencyMs: Date.now() - started,
      usage: data.usageMetadata || null,
      grounded: !!(cand?.groundingMetadata)
    };
  } finally { t.done(); }
}

/* ------------------------------------------------------------------ */
/* OpenAI 兼容协议（Grok / OpenAI / ChatGPT / DeepSeek / Qwen / 自定义） */
/* ------------------------------------------------------------------ */
async function callOpenAICompatible(prov, opts) {
  const key = process.env[prov.envKey];
  const base = providerBaseUrl(prov);
  const model = opts.model || prov.defaultModel;

  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const body = { model, messages, stream: false };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
    messages[0].content += '\n\n只输出 JSON，不要输出任何其它文字。';
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const t = withTimeout(opts.timeoutMs || DEFAULT_TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: t.signal
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(prov.label, res, data));
    const text = (data.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error(`[${prov.label}] 返回内容为空`);
    return {
      text,
      model: data.model || model,
      provider: prov.id,
      latencyMs: Date.now() - started,
      usage: data.usage || null
    };
  } finally { t.done(); }
}

/* ------------------------------------------------------------------ */
/* Mock 离线端口：无需任何密钥即可跑通全流程（演示 / 自检）              */
/*                                                                     */
/* 不调用任何外部服务。若数据层已取得真实行情，则用「规则化演示打分」    */
/* 生成多空分布，使离线演示的裁决方向与真实技术面保持自洽；无行情时      */
/* 退回固定模板。输出始终带有「演示文本」标记，绝不可当作投资依据。      */
/* ------------------------------------------------------------------ */
const MOCK_FACTOR = {
  '宏观政策分析师':   { A: 0.6, B: 0.2, C: 0.2, D: 0.1, cap: 20, off: 0 },
  '行业轮动分析师':   { A: 0.7, B: 0.4, C: 0.3, D: 0.2, cap: 22, off: 0 },
  '技术分析专家':     { A: 1.0, B: 0.5, C: 0.4, D: 0.2, cap: 26, off: 0 },
  '资金流向分析师':   { A: 0.3, B: 0.2, C: 0.5, D: 1.0, cap: 24, off: 0 },
  '基本面估值分析师': { A: 0.4, B: 0.9, C: 0.1, D: 0.1, cap: 22, off: 0 },
  '基本面研究总监':   { A: 0.5, B: 0.7, C: 0.2, D: 0.2, cap: 20, off: 0 },
  '市场动能总监':     { A: 0.9, B: 0.3, C: 0.5, D: 0.4, cap: 24, off: 0 },
  '系统性风险总监':   { A: 0.5, B: 0.6, C: 0.3, D: 0.3, cap: 22, off: 0, risk: true },
  '组合风险总监':     { A: 0.4, B: 0.5, C: 0.2, D: 0.3, cap: 20, off: 0, risk: true },
  '投资决策总经理':   { A: 0.7, B: 0.5, C: 0.3, D: 0.3, cap: 22, off: 0 }
};
const MOCK_DEFAULT_PROFILE = { A: 0.6, B: 0.4, C: 0.3, D: 0.2, cap: 20, off: 0 };
const mockClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function mockStanceOf(score) {
  if (score >= 68) return '强多';
  if (score >= 56) return '偏多';
  if (score >= 44) return '中性';
  if (score >= 32) return '偏空';
  return '强空';
}

/** 依据真实行情与技术指标做规则化演示打分；无行情返回 null。 */
function mockRuleScore(role, q, t) {
  if (!q || q.price == null) return null;
  const price = Number(q.price);
  const ma20 = t && t.ma20 != null ? Number(t.ma20) : null;
  const ma60 = t && t.ma60 != null ? Number(t.ma60) : null;
  const pos60 = t && t.range60 && t.range60.positionPct != null ? Number(t.range60.positionPct) : null;
  const dd250 = t && t.range250 && t.range250.drawdownPct != null ? Number(t.range250.drawdownPct) : null;
  const vol20 = t && t.vol20AnnualPct != null ? Number(t.vol20AnnualPct) : null;
  const chg = q.changePct != null ? Number(q.changePct) : 0;
  const bidSum = (q.bids || []).reduce((a, b) => a + (b.volumeLots || 0), 0);
  const askSum = (q.asks || []).reduce((a, b) => a + (b.volumeLots || 0), 0);

  const A1 = ma20 ? mockClamp((price / ma20 - 1) * 20, -1, 1) : 0;
  const A2 = ma60 ? mockClamp((price / ma60 - 1) * 14, -1, 1) : A1;
  const A = A1 * 0.7 + A2 * 0.3;
  const B = pos60 != null ? mockClamp((pos60 - 50) / 35, -1, 1) : 0;
  const C = mockClamp(chg / 2.2, -1, 1);
  const D = askSum ? mockClamp((bidSum / askSum - 1) / 0.8, -1, 1) : 0;

  const p = MOCK_FACTOR[role] || MOCK_DEFAULT_PROFILE;
  const wsum = Math.abs(p.A) + Math.abs(p.B) + Math.abs(p.C) + Math.abs(p.D) || 1;
  const raw = (p.A * A + p.B * B + p.C * C + p.D * D) / wsum;
  const riskPenalty = p.risk
    ? -((dd250 != null ? mockClamp(dd250 / 40, 0, 1.5) : 0) * 7 + (vol20 != null ? mockClamp((vol20 - 15) / 30, 0, 1) : 0) * 5)
    : 0;
  const score = Math.round(mockClamp(50 + raw * p.cap + (p.off || 0) + riskPenalty, 5, 95));
  return { score, price, ma20, ma60, pos60, dd250, vol20, chg, A, B, C, D, bidSum, askSum };
}

function mockNarrative(role, m) {
  const f = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
  const trend = m.A > 0.25 ? '现价站上 MA20，均线结构偏强'
    : m.A < -0.25 ? '现价位于 MA20 之下，短期均线走弱'
    : '现价贴近 MA20，方向尚未选择';
  const pos = m.pos60 == null ? '60 日分位缺失'
    : m.pos60 >= 70 ? '处于 60 日区间高位（分位 ' + m.pos60 + '%）'
    : m.pos60 <= 30 ? '处于 60 日区间低位（分位 ' + m.pos60 + '%）'
    : '位于 60 日区间中部（分位 ' + m.pos60 + '%）';
  const flow = m.chg > 0.5 ? '当日动能向上'
    : m.chg < -0.5 ? '当日承压回落'
    : '当日波动有限';
  const book = m.askSum ? (m.bidSum / m.askSum >= 1.15 ? '买盘挂单承接更强'
    : m.bidSum / m.askSum <= 0.85 ? '卖盘挂单相对更重' : '买卖挂单力量接近') : '盘口数据缺失';
  const key = '跟踪 MA20（' + f(m.ma20) + '）的得失，以及 60 日分位能否修复至中位上方';
  const risk = '波动率 ' + f(m.vol20, 1) + '% · 250 日最大回撤 ' + f(m.dd250, 1) + '% · 演示文本，不可用于真实决策';
  return { trend, pos, flow, book, key, risk };
}

function callMock(prov, opts) {
  const started = Date.now();
  const role = opts.mockRole || '分析师';
  const symbol = opts.mockSymbol || '600519';
  const seed = [...`${role}${symbol}`].reduce((a, c) => a + c.charCodeAt(0), 0);
  const pick = (arr, i) => arr[(seed + i) % arr.length];

  let stance, score, keyPoint, bullets, engineNote;
  const m = mockRuleScore(role, opts.mockQuote, opts.mockTechnicals);

  if (m) {
    const n = mockNarrative(role, m);
    score = m.score;
    stance = mockStanceOf(score);
    keyPoint = n.key;
    bullets = [
      `- **核心判断**：${n.trend}，${n.pos}；${n.flow}，${n.book}。`,
      `- **关键点**：${n.key}`,
      `- **风险提示**：${n.risk}`
    ];
    engineNote = '本端口未接入真实模型：以上多空分数由数据层的真实行情与技术指标经规则化模板打分得出，用于演示流水线结构，不代表任何分析观点。';
  } else {
    score = 45 + (seed % 30);
    stance = pick(['偏多', '中性', '偏多', '偏空', '中性'], 0);
    keyPoint = '离线演示：请配置真实端口密钥后重新分析';
    bullets = [
      `- **核心判断**：${pick(['量能温和放大，结构未破坏', '缩量整理，等待方向选择', '放量滞涨，短线承压', '均线多头排列，趋势仍在'], 1)}`,
      `- **关键点**：关注 ${pick(['MA20 支撑', '前高压力位', '五档盘口买卖比', '成交额是否放大'], 2)} 的得失`,
      `- **风险提示**：演示文本，不可用于真实决策`
    ];
    engineNote = '本端口未接入真实模型，且当前未取得行情底稿，输出为固定演示模板。';
  }

  const contract = { role, stance, score, confidence: 0.6, horizon: '中线', key_point: keyPoint };
  if (role === '投资决策总经理') {
    contract.action = score >= 62 ? '买入' : score >= 45 ? '观望' : '卖出';
    contract.position = mockClamp(Math.round(score - 38), 0, 80);
  }
  const veto = role === '系统性风险总监'
    && ((m && m.vol20 != null && m.vol20 > 60) || (m && m.dd250 != null && m.dd250 > 45));
  if (veto) contract.veto = true;

  const text = [
    '> ⚠️ 离线演示端口（Mock）· 未调用任何外部模型',
    '',
    engineNote,
    '',
    ...bullets,
    '',
    '```json',
    JSON.stringify(contract, null, 2),
    '```'
  ].join('\n');

  return { text, model: 'mock-analyst', provider: 'mock', latencyMs: Date.now() - started, usage: null, mocked: true };
}

/* ------------------------------------------------------------------ */
/* 对外统一入口                                                        */
/* ------------------------------------------------------------------ */
export async function chat(prov, opts = {}) {
  if (!prov) throw new Error('未指定模型端口');
  const status = providerStatus(prov);
  if (prov.kind !== 'mock' && status !== 'ready') {
    throw new Error(`[${prov.label}] 端口未就绪（${status === 'reserved' ? '预留未启用' : '缺少 API Key'}）`);
  }
  const attempts = prov.kind === 'mock' ? 1 : 2;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      if (prov.kind === 'mock') return callMock(prov, opts);
      if (prov.kind === 'gemini') return await callGemini(prov, opts);
      return await callOpenAICompatible(prov, opts);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable = /HTTP (429|500|502|503|504)/.test(msg) || /超时|timeout|socket|ECONN|fetch failed/i.test(msg);
      if (i < attempts - 1 && retryable) { await sleep(800 * (i + 1)); continue; }
      break;
    }
  }
  throw lastErr;
}

/** 端口自检：向某个端口发一句最小请求，确认「通」与「不通」 */
export async function pingProvider(id, opts = {}) {
  const prov = providerById(id);
  if (!prov) return { id, ok: false, error: '未知端口' };
  const status = providerStatus(prov);
  if (prov.kind !== 'mock' && status !== 'ready') {
    return { id, ok: false, status, error: status === 'reserved' ? '预留端口未启用（需配置 BASE_URL + API Key）' : '未配置 API Key' };
  }
  const started = Date.now();
  try {
    const r = await chat(prov, {
      system: '你是连通性测试助手，只回复两个字符。',
      user: '请只回复：OK',
      temperature: 0,
      model: opts.model || prov.defaultModel,
      webSearch: false,
      timeoutMs: Math.min(opts.timeoutMs || 30000, 30000),
      mockRole: '自检'
    });
    return { id, ok: true, status, model: r.model, latencyMs: Date.now() - started, sample: r.text.slice(0, 80) };
  } catch (e) {
    return { id, ok: false, status, latencyMs: Date.now() - started, error: String(e?.message || e).slice(0, 300) };
  }
}