/**
 * market.mjs —— 行情数据层
 *
 * 设计要点（相对原版的关键升级）：
 *  1. 多源冗余：腾讯 → 新浪 → 东财，任意一条通路可用即可，绝不单点依赖付费接口；
 *  2. 数据溯源：每一次取数都记录 source / url / fetchedAt / 是否合成数据；
 *  3. 缓存：默认 20 秒 TTL，避免 10 个智能体重复打行情接口；
 *  4. 派生指标：均线、振幅、波动率、区间分位、量比，全部在本地算好再注入 Prompt。
 */
import { envValue } from './config.mjs';

const QUOTE_TTL_MS = 20000;
const KLINE_TTL_MS = 5 * 60 * 1000;
const quoteCache = new Map();
const klineCache = new Map();

/* ------------------------------------------------------------------ */
/* 代码规范化                                                          */
/* ------------------------------------------------------------------ */
export function normalizeSymbol(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(sh|sz|bj)?(\d{6})$/.exec(raw);
  if (!m) return { ok: false, error: '股票代码格式错误，应为 6 位数字（如 600519 / 000001 / 300750 / sh600519）' };
  const code = m[2];
  let market = m[1] || '';
  if (!market) {
    if (/^(6|9|5)/.test(code)) market = 'sh';
    else if (/^(0|2|3|1)/.test(code)) market = 'sz';
    else if (/^(4|8)/.test(code)) market = 'bj';
    else return { ok: false, error: '无法识别的市场前缀' };
  }
  const secid = `${market === 'sh' ? 1 : market === 'sz' ? 0 : 0}.${code}`;
  return { ok: true, code, market, symbol: `${market}${code}`, secid, isIndex: /^(000001|399001|399006|000300)$/.test(code) && market !== 'sh' };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
function decodeGbk(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

async function getText(url, { headers = {}, timeoutMs = 12000, encoding = 'utf-8' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('行情接口超时')), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'StockCouncil/1.0', ...headers }, signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return encoding === 'gbk' ? decodeGbk(buf) : buf.toString('utf8');
  } finally { clearTimeout(timer); }
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------------ */
/* 数据源 1：腾讯行情（唯一能一次拿到完整五档的免费源）                  */
/* ------------------------------------------------------------------ */
async function fetchTencentQuote(sym) {
  const url = `https://qt.gtimg.cn/q=${sym.symbol}`;
  const text = await getText(url, { encoding: 'gbk' });
  const body = text.split('="')[1];
  if (!body) throw new Error('腾讯行情返回格式异常');
  const f = body.replace(/";?\s*$/, '').split('~');
  if (f.length < 35) throw new Error('腾讯行情字段不足');
  const price = num(f[3]);
  if (price === null) throw new Error('腾讯行情无有效价格');
  const bids = [], asks = [];
  for (let i = 0; i < 5; i++) {
    const bp = num(f[9 + i * 2]), bv = num(f[10 + i * 2]);
    const ap = num(f[19 + i * 2]), av = num(f[20 + i * 2]);
    if (bp) bids.push({ level: i + 1, price: bp, volumeLots: bv ?? 0 });
    if (ap) asks.push({ level: i + 1, price: ap, volumeLots: av ?? 0 });
  }
  const ts = String(f[30] || '');
  return {
    name: f[1], code: f[2], price,
    prevClose: num(f[4]), open: num(f[5]),
    volumeLots: num(f[36]) ?? num(f[6]),
    amount: (num(f[37]) ?? 0) * 10000,
    high: num(f[33]), low: num(f[34]),
    change: num(f[31]), changePct: num(f[32]),
    turnoverRate: num(f[38]), pe: num(f[39]),
    amplitudePct: num(f[43]),
    floatCap: (num(f[44]) ?? 0) * 1e8 || null,
    totalCap: (num(f[45]) ?? 0) * 1e8 || null,
    pb: num(f[46]), limitUp: num(f[47]), limitDown: num(f[48]),
    volumeRatio: num(f[49]),
    bids, asks,
    date: ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : '',
    time: ts.length >= 14 ? `${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}` : '',
    source: 'tencent',
    sourceUrl: url
  };
}

/* ------------------------------------------------------------------ */
/* 数据源 2：新浪行情                                                  */
/* ------------------------------------------------------------------ */
async function fetchSinaQuote(sym) {
  const url = `https://hq.sinajs.cn/list=${sym.symbol}`;
  const text = await getText(url, { encoding: 'gbk', headers: { Referer: 'https://finance.sina.com.cn' } });
  const body = text.split('="')[1];
  if (!body) throw new Error('新浪行情返回格式异常');
  const f = body.replace(/";?\s*$/, '').split(',');
  if (f.length < 32) throw new Error('新浪行情字段不足');
  const price = num(f[3]);
  if (!price) throw new Error('新浪行情无有效价格（可能停牌）');
  const bids = [], asks = [];
  for (let i = 0; i < 5; i++) {
    const bv = num(f[10 + i * 2]), bp = num(f[11 + i * 2]);
    const av = num(f[20 + i * 2]), ap = num(f[21 + i * 2]);
    if (bp) bids.push({ level: i + 1, price: bp, volumeLots: Math.round((bv || 0) / 100) });
    if (ap) asks.push({ level: i + 1, price: ap, volumeLots: Math.round((av || 0) / 100) });
  }
  const prevClose = num(f[2]), open = num(f[1]);
  return {
    name: f[0], code: sym.code, price, prevClose, open,
    high: num(f[4]), low: num(f[5]),
    volumeLots: Math.round((num(f[8]) || 0) / 100),
    amount: num(f[9]),
    change: price && prevClose ? +(price - prevClose).toFixed(3) : null,
    changePct: price && prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null,
    date: f[30], time: f[31],
    bids, asks,
    source: 'sina',
    sourceUrl: url
  };
}

/* ------------------------------------------------------------------ */
/* 数据源 3：东方财富（不含五档，作兜底 + 指数/K线主力）                 */
/* ------------------------------------------------------------------ */
const EM_FIELDS = 'f43,f44,f45,f46,f47,f48,f50,f57,f58,f59,f60,f71,f84,f85,f116,f117,f162,f167,f168,f169,f170,f171';

/** 注意：请求时带 fltt=2，东财已返回「已还原小数」的数值，切勿再次除以 10^f59 */
export function parseEastmoneyQuote(d, sym) {
  if (!d) throw new Error('东方财富无数据');
  const p = (v) => (Number.isFinite(v) ? Number(v) : null);
  const price = p(d.f43);
  if (!price) throw new Error('东方财富无有效价格');
  return {
    name: d.f58, code: d.f57, price, prevClose: p(d.f60),
    open: p(d.f46), high: p(d.f44), low: p(d.f45),
    volumeLots: p(d.f47), amount: p(d.f48),
    volumeRatio: p(d.f50), change: p(d.f169), changePct: p(d.f170),
    amplitudePct: p(d.f171), turnoverRate: p(d.f168),
    pe: p(d.f162), pb: p(d.f167),
    totalCap: p(d.f116), floatCap: p(d.f117),
    bids: [], asks: [],
    source: 'eastmoney',
    sourceUrl: `https://quote.eastmoney.com/${sym.market || ''}${sym.code || ''}.html`
  };
}

async function fetchEastmoneyQuote(sym) {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${sym.secid}&fields=${EM_FIELDS}&invt=2&fltt=2`;
  const text = await getText(url);
  const json = JSON.parse(text);
  return parseEastmoneyQuote(json?.data, sym);
}

/* ------------------------------------------------------------------ */
/* 统一取数入口（带缓存与溯源）                                         */
/* ------------------------------------------------------------------ */
export async function getQuote(symbolInput, opts = {}) {
  const sym = normalizeSymbol(symbolInput);
  if (!sym.ok) return { ok: false, error: sym.error };

  const cacheKey = sym.symbol;
  const cached = quoteCache.get(cacheKey);
  if (!opts.noCache && cached && Date.now() - cached.at < QUOTE_TTL_MS) {
    return { ok: true, quote: cached.quote, cache: 'hit', provenance: cached.provenance };
  }

  const allSources = [
    { id: 'tencent', fn: fetchTencentQuote },
    { id: 'sina', fn: fetchSinaQuote },
    { id: 'eastmoney', fn: fetchEastmoneyQuote }
  ];
  const wanted = Array.isArray(opts.sources) && opts.sources.length ? opts.sources : null;
  const sources = wanted ? allSources.filter((s) => wanted.includes(s.id)) : allSources;
  const errors = [];
  for (const s of sources) {
    try {
      const q = await s.fn(sym);
      if (!q.name || !q.price) throw new Error('关键字段缺失');
      const quote = {
        ...q,
        symbol: sym.symbol, market: sym.market, secid: sym.secid,
        fetchedAt: new Date().toISOString(),
        synthetic: false
      };
      const provenance = { source: s.source || s.id, url: q.sourceUrl, fetchedAt: quote.fetchedAt, fallbacks: errors };
      quoteCache.set(cacheKey, { at: Date.now(), quote, provenance });
      return { ok: true, quote, cache: 'miss', provenance };
    } catch (e) {
      errors.push({ source: s.id, error: String(e?.message || e) });
    }
  }

  if (opts.allowSynthetic) {
    const quote = syntheticQuote(sym);
    const provenance = {
      source: 'synthetic',
      url: '(本地合成)',
      fetchedAt: quote.fetchedAt,
      synthetic: true,
      fallbacks: errors
    };
    return { ok: true, quote, cache: 'synthetic', provenance };
  }
  return { ok: false, error: `所有行情源均不可用：${errors.map((e) => `${e.source}(${e.error})`).join('；')}`, provenance: { fallbacks: errors } };
}

/** 合成行情：仅在离线/无网络时使用，前端必须显著标注「演示数据」 */
function syntheticQuote(sym) {
  const seed = [...sym.symbol].reduce((a, c) => a + c.charCodeAt(0), 0);
  const base = 10 + (seed % 90);
  const drift = ((seed % 7) - 3) / 100;
  const price = +(base * (1 + drift)).toFixed(2);
  const prevClose = base;
  const high = +(price * 1.021).toFixed(2);
  const low = +(price * 0.982).toFixed(2);
  const bids = [], asks = [];
  for (let i = 0; i < 5; i++) {
    bids.push({ level: i + 1, price: +(price - 0.01 * (i + 1)).toFixed(2), volumeLots: 120 + ((seed * (i + 3)) % 900) });
    asks.push({ level: i + 1, price: +(price + 0.01 * (i + 1)).toFixed(2), volumeLots: 100 + ((seed * (i + 5)) % 800) });
  }
  return {
    name: `演示标的${sym.code}`, code: sym.code, symbol: sym.symbol, market: sym.market, secid: sym.secid,
    price, prevClose, open: +(base * 0.998).toFixed(2), high, low,
    change: +(price - prevClose).toFixed(2),
    changePct: +(((price - prevClose) / prevClose) * 100).toFixed(2),
    volumeLots: 260000 + (seed % 50000), amount: 1.9e9, volumeRatio: 1.05,
    turnoverRate: 0.85, amplitudePct: +(((high - low) / prevClose) * 100).toFixed(2),
    pe: 21.3, pb: 4.1, totalCap: 2.1e12, floatCap: 2.1e12,
    limitUp: +(prevClose * 1.1).toFixed(2), limitDown: +(prevClose * 0.9).toFixed(2),
    bids, asks, date: new Date().toISOString().slice(0, 10), time: new Date().toTimeString().slice(0, 8),
    source: 'synthetic (本地合成演示数据)', sourceUrl: null,
    fetchedAt: new Date().toISOString(), synthetic: true
  };
}

/* ------------------------------------------------------------------ */
/* K 线 + 本地派生指标                                                  */
/* ------------------------------------------------------------------ */
export async function getKline(symbolInput, { klt = 101, limit = 250, noCache = false } = {}) {
  const sym = normalizeSymbol(symbolInput);
  if (!sym.ok) return { ok: false, error: sym.error };
  const key = `${sym.symbol}:${klt}:${limit}`;
  const cached = klineCache.get(key);
  if (!noCache && cached && Date.now() - cached.at < KLINE_TTL_MS) return { ok: true, bars: cached.bars, cache: 'hit' };

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${sym.secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&end=20500101&lmt=${limit}`;
  try {
    const text = await getText(url);
    const json = JSON.parse(text);
    const lines = json?.data?.klines;
    if (!Array.isArray(lines) || !lines.length) throw new Error('K线数据为空');
    const bars = lines.map((line) => {
      const p = line.split(',');
      return {
        date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
        volume: +p[5], amount: +p[6], amplitude: +p[7], changePct: +p[8], change: +p[9], turnover: +p[10]
      };
    });
    klineCache.set(key, { at: Date.now(), bars });
    return { ok: true, bars, cache: 'miss', provenance: { source: 'eastmoney-kline', url } };
  } catch (e) {
    return { ok: false, error: `K线获取失败：${String(e?.message || e)}` };
  }
}

const ma = (bars, n) => (bars.length >= n ? +(bars.slice(-n).reduce((a, b) => a + b.close, 0) / n).toFixed(2) : null);

export function deriveTechnicals(bars, quote) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const price = quote?.price ?? last.close;
  const win = closes.slice(-60);
  const hi60 = Math.max(...win), lo60 = Math.min(...win);
  const hi250 = Math.max(...closes.slice(-250)), lo250 = Math.min(...closes.slice(-250));
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const recent = returns.slice(-20);
  const mean = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
  const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length || 1);
  const vol20 = +(Math.sqrt(variance) * Math.sqrt(250) * 100).toFixed(1);
  const up = bars.slice(-20).filter((b) => (b.close >= b.open)).length;
  return {
    ma5: ma(bars, 5), ma10: ma(bars, 10), ma20: ma(bars, 20), ma60: ma(bars, 60),
    range60: { high: hi60, low: lo60, positionPct: +(((price - lo60) / (hi60 - lo60 || 1)) * 100).toFixed(1) },
    range250: { high: hi250, low: lo250, drawdownPct: +(((hi250 - price) / hi250) * 100).toFixed(1) },
    vol20AnnualPct: vol20,
    avgVolume5Lots: Math.round(bars.slice(-5).reduce((a, b) => a + b.volume, 0) / 5),
    avgVolume20Lots: Math.round(bars.slice(-20).reduce((a, b) => a + b.volume, 0) / 20),
    upDaysLast20: up,
    lastBars: bars.slice(-10).map((b) => ({ date: b.date, open: b.open, close: b.close, high: b.high, low: b.low, volume: b.volume, changePct: b.changePct }))
  };
}

/* ------------------------------------------------------------------ */
/* 把行情 + 技术指标压成给模型的「事实底稿」                            */
/* ------------------------------------------------------------------ */
export function buildMarketContext({ quote, technicals, provenance, indexQuote }) {
  if (!quote) return '【行情数据】不可用：请仅基于公开常识分析，并明确声明数据缺失。';
  const f = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
  const lots = (v) => (v == null ? '—' : v >= 1e4 ? `${(v / 1e4).toFixed(2)}万手` : `${v}手`);
  const money = (v) => (v == null ? '—' : v >= 1e8 ? `${(v / 1e8).toFixed(2)}亿元` : `${(v / 1e4).toFixed(0)}万元`);
  const cap = (v) => (v == null ? '—' : `${(v / 1e8).toFixed(0)}亿元`);

  const bidBlock = quote.bids?.length
    ? quote.bids.slice().reverse().map((b) => `  买${b.level}  ¥${f(b.price)}  ${lots(b.volumeLots)}`).join('\n')
    : '  （该数据源未提供五档）';
  const askBlock = quote.asks?.length
    ? quote.asks.map((a) => `  卖${a.level}  ¥${f(a.price)}  ${lots(a.volumeLots)}`).join('\n')
    : '  （该数据源未提供五档）';
  const bidSum = quote.bids?.reduce((a, b) => a + (b.volumeLots || 0), 0) || 0;
  const askSum = quote.asks?.reduce((a, b) => a + (b.volumeLots || 0), 0) || 0;
  const ratio = askSum ? (bidSum / askSum).toFixed(2) : '—';

  const t = technicals;
  return [
    '╔══════════════════════════════════════════════════════════════╗',
    '║ 实时行情底稿（平台数据层自动注入 · 禁止臆造本表以外的数字）      ║',
    '╚══════════════════════════════════════════════════════════════╝',
    `【标的】${quote.name}（${quote.symbol?.toUpperCase() || quote.code}）  数据源：${provenance?.source || quote.source}${quote.synthetic ? ' ⚠️演示数据' : ''}`,
    `【时间】${quote.date || ''} ${quote.time || ''}   采集：${quote.fetchedAt || ''}`,
    '',
    '【价格】',
    `  现价 ¥${f(quote.price)}   涨跌 ${f(quote.change)}   涨跌幅 ${f(quote.changePct)}%`,
    `  今开 ¥${f(quote.open)}   昨收 ¥${f(quote.prevClose)}   最高 ¥${f(quote.high)}   最低 ¥${f(quote.low)}`,
    `  振幅 ${f(quote.amplitudePct)}%   涨停 ¥${f(quote.limitUp)}   跌停 ¥${f(quote.limitDown)}`,
    '',
    '【量能与估值】',
    `  成交量 ${lots(quote.volumeLots)}   成交额 ${money(quote.amount)}   量比 ${f(quote.volumeRatio)}`,
    `  换手率 ${f(quote.turnoverRate)}%   PE ${f(quote.pe)}   PB ${f(quote.pb)}   总市值 ${cap(quote.totalCap)}   流通市值 ${cap(quote.floatCap)}`,
    '',
    '【五档盘口】',
    askBlock,
    bidBlock,
    `  买卖挂单比（买五合计/卖五合计）＝ ${ratio}`,
    '',
    t ? '【技术面派生指标（本地计算）】' : '【技术面派生指标】暂缺（K线数据不可用）',
    ...(t ? [
      `  MA5 ${f(t.ma5)}   MA10 ${f(t.ma10)}   MA20 ${f(t.ma20)}   MA60 ${f(t.ma60)}`,
      `  现价相对MA20：${t.ma20 ? f(((quote.price - t.ma20) / t.ma20) * 100) + '%' : '—'}   相对MA60：${t.ma60 ? f(((quote.price - t.ma60) / t.ma60) * 100) + '%' : '—'}`,
      `  60日区间 ${f(t.range60.low)} ~ ${f(t.range60.high)}，当前分位 ${t.range60.positionPct}%`,
      `  250日高点回撤 ${t.range250.drawdownPct}%   20日年化波动率 ${t.vol20AnnualPct}%`,
      `  5日均量 ${lots(t.avgVolume5Lots)}   20日均量 ${lots(t.avgVolume20Lots)}   近20日阳线 ${t.upDaysLast20}/20`,
      `  近10个交易日：${t.lastBars.map((b) => `${b.date.slice(5)}(${b.changePct >= 0 ? '+' : ''}${b.changePct}%)`).join(' ')}`
    ] : []),
    indexQuote ? [
      '',
      '【大盘参照】',
      `  ${indexQuote.name} ${f(indexQuote.price)}  ${f(indexQuote.changePct)}%   成交额 ${money(indexQuote.amount)}`
    ].join('\n') : '',
    '══════════════════════════════════════════════════════════════'
  ].filter(Boolean).join('\n');
}

/** 大盘指数（上证/深成/创业板） */
export async function getIndexSnapshot(codes = ['1.000001', '0.399001', '0.399006']) {
  const out = [];
  for (const secid of codes) {
    try {
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${EM_FIELDS}&invt=2&fltt=2`;
      const json = JSON.parse(await getText(url, { timeoutMs: 8000 }));
      const q = parseEastmoneyQuote(json?.data, { market: secid.startsWith('1') ? 'sh' : 'sz', code: secid.split('.')[1] });
      out.push(q);
    } catch { /* 忽略单个指数失败 */ }
  }
  return out;
}