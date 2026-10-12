/**
 * index.mjs —— 零依赖 HTTP 服务（Node >= 20，无需 npm install）
 *
 *   node server/index.mjs            # 启动平台
 *   set OFFLINE_DEMO=1 && node ...   # 强制离线演示模式（全部走 Mock 端口 + 合成行情）
 *
 * 路由一览
 *   GET  /                      前端工作台
 *   GET  /api/status            平台状态
 *   GET  /api/providers         模型端口清单（含就绪状态，绝不回传密钥）
 *   POST /api/providers/ping    端口自检（逐个发最小请求，验证连通性）
 *   GET  /api/nodes             智能体角色清单 + 当前路由
 *   POST /api/analyze           SSE 流：启动四阶段委员会分析
 *   POST /api/chat              单端口直连（调试用）
 *   GET  /api/quote             行情（多源冗余 + 溯源）
 *   GET  /api/kline             K 线 + 派生指标
 *   GET  /api/history           历史记录
 *   GET  /api/history/:id       历史详情
 *   DEL  /api/history/:id       删除单条
 *   DEL  /api/history           清空
 *   GET  /api/settings          读取路由配置
 *   POST /api/settings          保存路由配置
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { loadEnv, loadSettings, saveSettings, providerCatalog, PROVIDERS, AGENT_ORDER, ROOT, WEB_DIR } from './config.mjs';
import { pingProvider, chat } from './providers.mjs';
import { getQuote, getKline, deriveTechnicals, buildMarketContext, getIndexSnapshot, normalizeSymbol } from './market.mjs';
import { AGENTS, agentById } from './agents.mjs';
import { runAnalysis } from './orchestrator.mjs';
import { listHistory, getHistory, deleteHistory, clearHistory, addHistory } from './store.mjs';

loadEnv();
const settings = loadSettings();
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found', path: rel });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function providerSummary() {
  const catalog = providerCatalog();
  return {
    total: catalog.length,
    ready: catalog.filter((p) => p.status === 'ready').map((p) => p.id),
    missing: catalog.filter((p) => p.status === 'missing-key').map((p) => p.id),
    reserved: catalog.filter((p) => p.status === 'reserved').map((p) => p.id)
  };
}

/* ------------------------------------------------------------------ */
/* 业务处理                                                            */
/* ------------------------------------------------------------------ */
async function handleAnalyze(req, res) {
  const body = await readBody(req);
  const symbol = String(body.symbol || '').trim();
  if (!symbol) return json(res, 400, { error: '缺少股票代码' });

  const sym = normalizeSymbol(symbol);
  if (!sym.ok) return json(res, 400, { error: sym.error });

  // 运行期覆盖：允许前端临时指定每个角色的端口/模型
  const runtime = {
    ...settings,
    concurrency: Number(body.concurrency) || settings.concurrency,
    offlineDemo: body.offlineDemo === true || settings.offlineDemo,
    routing: { ...settings.routing, ...(body.routing || {}) }
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  let closed = false;
  req.on('close', () => { closed = true; });
  const emit = (event) => {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { closed = true; }
  };
  const heartbeat = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { closed = true; } } }, 15000);

  try {
    emit({ type: 'start', symbol: sym.symbol, routing: runtime.routing, offlineDemo: runtime.offlineDemo });

    /* Stage 0：数据层 */
    emit({ type: 'stage_start', stage: 0, label: '数据层 · 多源行情采集与指标计算', roles: [] });
    const allowSynthetic = runtime.offlineDemo;
    const [q, k, idx] = await Promise.all([
      getQuote(sym.symbol, { allowSynthetic }),
      getKline(sym.symbol),
      getIndexSnapshot().catch(() => [])
    ]);
    if (!q.ok) {
      emit({ type: 'fatal', error: q.error, provenance: q.provenance });
      clearInterval(heartbeat);
      return res.end();
    }
    const technicals = k.ok ? deriveTechnicals(k.bars, q.quote) : null;
    const context = buildMarketContext({
      quote: q.quote, technicals, provenance: q.provenance, indexQuote: idx[0] || null
    });
    const market = {
      quote: q.quote,
      technicals,
      kline: k.ok ? k.bars.slice(-120) : [],
      indices: idx,
      provenance: q.provenance,
      context
    };
    emit({ type: 'market', quote: q.quote, technicals, kline: market.kline, indices: idx, provenance: q.provenance, context });
    emit({ type: 'stage_done', stage: 0, label: '数据层', summary: [{ role: 'DATA', stance: '中性', score: 50, provider: q.provenance?.source }] });

    /* Stage 1-4 + 聚合 */
    const { results, aggregation, decision, summary } = await runAnalysis({ symbol: sym.symbol, settings: runtime, market, emit });

    const record = {
      symbol: sym.symbol,
      name: q.quote.name,
      date: new Date().toISOString().slice(0, 10),
      timestamp: Date.now(),
      action: decision.action,
      position: decision.position,
      consistency: aggregation.consistency,
      elapsedMs: summary.elapsedMs,
      providers: summary.providersUsed,
      mocked: summary.mockedRoles.length > 0,
      aggregation,
      decision,
      summary,
      market: { quote: q.quote, technicals, provenance: q.provenance },
      outputs: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
        title: v.title, text: v.text, verdict: v.verdict, charts: v.charts,
        provider: v.provider, providerLabel: v.providerLabel, model: v.model,
        latencyMs: v.latencyMs, degraded: v.degraded, mocked: v.mocked, error: v.error || null
      }]))
    };
    const historyId = addHistory(record);
    emit({ type: 'done', historyId, elapsedMs: summary.elapsedMs });
  } catch (e) {
    emit({ type: 'fatal', error: String(e?.message || e) });
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
}

async function route(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    if (pathname === '/api/status' && method === 'GET') {
      return json(res, 200, {
        ok: true,
        version: '1.0.0',
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        root: ROOT,
        offlineDemo: settings.offlineDemo,
        concurrency: settings.concurrency,
        providers: providerSummary(),
        nodeRuntime: process.version
      });
    }

    if (pathname === '/api/providers' && method === 'GET') {
      return json(res, 200, { providers: providerCatalog(), summary: providerSummary() });
    }

    if (pathname === '/api/providers/ping' && method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : PROVIDERS.map((p) => p.id);
      const results = [];
      for (const id of ids) results.push(await pingProvider(id, { timeoutMs: 30000 }));
      return json(res, 200, { results });
    }

    if (pathname === '/api/nodes' && method === 'GET') {
      const nodes = AGENTS.map((a) => {
        const r = settings.routing[a.role] || { provider: 'auto', model: '' };
        return {
          role: a.role, title: a.title, name: a.name, stage: a.stage,
          description: a.description, temperature: a.temperature, webSearch: !!a.webSearch,
          routing: r
        };
      });
      return json(res, 200, { order: AGENT_ORDER, nodes });
    }

    if (pathname === '/api/settings' && method === 'GET') {
      return json(res, 200, { settings: { ...settings, routing: settings.routing } });
    }

    if (pathname === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      if (body.routing && typeof body.routing === 'object') {
        for (const [role, val] of Object.entries(body.routing)) {
          if (!AGENT_ORDER.includes(role)) continue;
          settings.routing[role] = { provider: val.provider || 'auto', model: val.model || '' };
        }
      }
      if (typeof body.concurrency === 'number') settings.concurrency = Math.min(8, Math.max(1, body.concurrency));
      saveSettings(settings);
      return json(res, 200, { ok: true, settings });
    }

    if (pathname === '/api/quote' && method === 'GET') {
      const raw = parsed.searchParams.get('symbol') || '';
      const sym = normalizeSymbol(raw);
      if (!sym.ok) return json(res, 400, { ok: false, error: sym.error });
      const q = await getQuote(raw, { allowSynthetic: parsed.searchParams.get('demo') === '1' || settings.offlineDemo });
      return json(res, q.ok ? 200 : 502, q);
    }

    if (pathname === '/api/kline' && method === 'GET') {
      const raw = parsed.searchParams.get('symbol') || '';
      const sym = normalizeSymbol(raw);
      if (!sym.ok) return json(res, 400, { ok: false, error: sym.error });
      const k = await getKline(raw, { klt: Number(parsed.searchParams.get('klt')) || 101, limit: Number(parsed.searchParams.get('limit')) || 250 });
      if (!k.ok) return json(res, 502, k);
      const q = await getQuote(raw, { allowSynthetic: settings.offlineDemo });
      return json(res, 200, { ok: true, bars: k.bars, technicals: q.ok ? deriveTechnicals(k.bars, q.quote) : null });
    }

    if (pathname === '/api/chat' && method === 'POST') {
      const body = await readBody(req);
      const prov = PROVIDERS.find((p) => p.id === body.provider);
      if (!prov) return json(res, 400, { error: '未知端口' });
      const started = Date.now();
      const out = await chat(prov, {
        system: body.system || '你是财经数据分析助手。',
        user: body.user || '你好',
        model: body.model || undefined,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
        timeoutMs: 60000,
        mockRole: '直连测试'
      });
      return json(res, 200, { ok: true, ...out, latencyMs: Date.now() - started });
    }

    if (pathname === '/api/analyze' && method === 'POST') return handleAnalyze(req, res);

    if (pathname === '/api/history' && method === 'GET') return json(res, 200, { items: listHistory() });
    if (pathname === '/api/history' && method === 'DELETE') { clearHistory(); return json(res, 200, { ok: true }); }
    if (pathname.startsWith('/api/history/')) {
      const id = decodeURIComponent(pathname.slice('/api/history/'.length));
      if (method === 'DELETE') { deleteHistory(id); return json(res, 200, { ok: true }); }
      if (method === 'GET') {
        const item = getHistory(id);
        return item ? json(res, 200, { ok: true, item }) : json(res, 404, { error: '未找到该记录' });
      }
    }

    return json(res, 404, { error: 'unknown endpoint', pathname });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => json(res, 500, { error: String(e?.message || e) }));
});

const PORT = Number(process.env.PORT || settings.port || 8787);
server.listen(PORT, '127.0.0.1', () => {
  const sum = providerSummary();
  console.log('');
  console.log('  ┌───────────────────────────────────────────────────────────┐');
  console.log('  │   StockCouncil · 多智能体股票数据分析平台                  │');
  console.log('  └───────────────────────────────────────────────────────────┘');
  console.log(`   ✓ 访问地址      http://127.0.0.1:${PORT}`);
  console.log(`   ✓ Node          ${process.version}`);
  console.log(`   ✓ 就绪端口      ${sum.ready.join(', ') || '(无，将使用 Mock 演示端口)'}`);
  if (sum.missing.length) console.log(`   · 待配置端口    ${sum.missing.join(', ')}（在 .env 中填 Key）`);
  if (sum.reserved.length) console.log(`   · 预留端口      ${sum.reserved.join(', ')}（ChatGPT 预留插槽，配置 BASE_URL + Key 即启用）`);
  console.log(`   · 离线演示      ${settings.offlineDemo ? '已开启' : '关闭（设 OFFLINE_DEMO=1 可开启）'}`);
  console.log('');
});