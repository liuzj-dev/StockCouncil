/**
 * orchestrator.mjs —— 四阶段决策流水线 + 结构化裁决聚合引擎
 *
 *   Stage 0 数据层：多源行情 + K线 + 本地指标  → 「事实底稿」
 *   Stage 1 分析师：5 个角色并行，独立视角
 *   Stage 2 总监层：2 个角色，各自整合 1 条脉络（基本面 / 动能）
 *   Stage 3 风控层：2 个角色，含一票否决权
 *   Stage 4 总经理：读取全部 9 份报告，给出唯一指令
 *   Stage 5 聚合引擎：规则化复核 LLM 的最终决策（防止单点幻觉）
 *
 * 每个角色都可以绑定不同的模型端口，失败自动沿降级链重试，绝不中断整个流程。
 */
import { agentById, stageAgents, AGENTS, buildAgentMessages } from './agents.mjs';
import { chat } from './providers.mjs';
import { resolveProvider, fallbackChain } from './config.mjs';

/* ------------------------------------------------------------------ */
/* 文本解析                                                            */
/* ------------------------------------------------------------------ */
const STANCE_WEIGHT = { 强多: 2, 偏多: 1, 中性: 0, 偏空: -1, 强空: -2 };

function jsonBlocks(text) {
  const out = [];
  const re = /```json\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* 忽略坏块 */ }
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 三级解析：JSON 块 → 关键词 → 中性兜底 */
export function parseVerdict(text, role) {
  const blocks = jsonBlocks(text);
  const structured = blocks.find((b) => b && (b.stance || b.action));
  const verdict = {
    role,
    stance: '中性',
    score: 50,
    confidence: 0.5,
    horizon: '中线',
    key_point: '',
    action: null,
    position: null,
    veto: false,
    parseMode: 'fallback'
  };

  if (structured) {
    verdict.parseMode = 'json';
    if (typeof structured.stance === 'string' && /强多|偏多|中性|偏空|强空/.test(structured.stance)) verdict.stance = structured.stance.match(/强多|偏多|中性|偏空|强空/)[0];
    if (Number.isFinite(+structured.score)) verdict.score = clamp(Math.round(+structured.score), 0, 100);
    if (Number.isFinite(+structured.confidence)) verdict.confidence = clamp(+structured.confidence, 0, 1);
    if (typeof structured.horizon === 'string') verdict.horizon = structured.horizon;
    if (typeof structured.key_point === 'string') verdict.key_point = structured.key_point.slice(0, 120);
    if (structured.veto === true) verdict.veto = true;
    if (typeof structured.action === 'string' && /买入|观望|卖出/.test(structured.action)) verdict.action = structured.action.match(/买入|观望|卖出/)[0];
    if (structured.position !== undefined && structured.position !== null) {
      const p = String(structured.position).replace(/[^\d.]/g, '');
      if (p) verdict.position = clamp(Math.round(+p), 0, 100);
    }
  } else {
    const t = text || '';
    if (/🟢\s*买入|最终指令[^\n]*买入/.test(t)) verdict.stance = '偏多';
    if (/🔴\s*卖出|最终指令[^\n]*卖出/.test(t)) verdict.stance = '偏空';
    if (/🟡\s*观望/.test(t)) verdict.stance = verdict.stance === '中性' ? '中性' : verdict.stance;
    if (/一票否决[:：]\s*是/.test(t)) verdict.veto = true;
    const am = t.match(/(🟢|🔴|🟡)\s*(买入|卖出|观望)/);
    if (am) verdict.action = am[2];
  }
  if (!verdict.action && verdict.stance !== '中性') {
    if (STANCE_WEIGHT[verdict.stance] > 0.5) verdict.action = '买入';
    if (STANCE_WEIGHT[verdict.stance] < -0.5) verdict.action = '卖出';
  }
  return verdict;
}

export function extractCharts(text) {
  return jsonBlocks(text).filter((b) => b && b.chartType && Array.isArray(b.data));
}

/** 去掉 JSON 代码块，只留给人看的 Markdown */
export function stripJsonBlocks(text) {
  return String(text || '').replace(/```json\s*[\s\S]*?```/gi, '').trim();
}

/* ------------------------------------------------------------------ */
/* 调用单个智能体（含端口降级）                                          */
/* ------------------------------------------------------------------ */
async function runAgent(agent, { symbol, marketContext, context, settings, emit, stageLabel, mockQuote, mockTechnicals }) {
  const primary = resolveProvider(settings, agent.role);
  const chain = fallbackChain(settings, agent.role, primary);
  const { system, user } = buildAgentMessages(agent, { symbol, marketContext, context });
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const prov = chain[i];
    const isMock = prov.kind === 'mock';
    if (isMock && i === 0) {
      // 没有任何真实端口可用时的兜底说明
    }
    try {
      emit({ type: 'agent_start', role: agent.role, provider: prov.id, model: settings.routing[agent.role]?.model || prov.defaultModel, attempt: i });
      const res = await chat(prov, {
        system, user,
        temperature: agent.temperature,
        model: settings.routing[agent.role]?.model || undefined,
        webSearch: agent.webSearch,
        timeoutMs: settings.requestTimeoutMs,
        mockRole: agent.title,
        mockSymbol: symbol,
        mockQuote,
        mockTechnicals
      });
      const verdict = parseVerdict(res.text, agent.role);
      const payload = {
        role: agent.role,
        title: agent.title,
        name: agent.name,
        stage: agent.stage,
        stageLabel,
        provider: prov.id,
        providerLabel: prov.label || prov.id,
        model: res.model,
        latencyMs: res.latencyMs,
        degraded: i > 0,
        mocked: !!res.mocked,
        text: stripJsonBlocks(res.text),
        raw: res.text,
        verdict,
        charts: extractCharts(res.text),
        usage: res.usage || null
      };
      emit({ type: 'agent_done', ...payload });
      return payload;
    } catch (e) {
      lastError = e;
      emit({ type: 'agent_error', role: agent.role, provider: prov.id, error: String(e?.message || e).slice(0, 300) });
    }
  }

  const failed = {
    role: agent.role, title: agent.title, name: agent.name, stage: agent.stage, stageLabel,
    provider: null, providerLabel: '全部端口失败', model: null, latencyMs: 0,
    degraded: true, mocked: false, error: String(lastError?.message || '未知错误'),
    text: `> ⚠️ 本角色分析失败：${String(lastError?.message || '未知错误')}`,
    raw: '', verdict: parseVerdict('', agent.role), charts: []
  };
  emit({ type: 'agent_done', ...failed });
  return failed;
}

/** 并发池 */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ */
/* 聚合引擎：规则化复核 LLM 决策                                        */
/* ------------------------------------------------------------------ */
export function aggregate(results, { veto }) {
  const list = Object.values(results).filter(Boolean);
  const counts = { 强多: 0, 偏多: 0, 中性: 0, 偏空: 0, 强空: 0 };
  for (const r of list) counts[r.verdict.stance] = (counts[r.verdict.stance] || 0) + 1;

  const bull = counts.强多 + counts.偏多;
  const bear = counts.强空 + counts.偏空;
  const total = list.length || 1;

  const weights = { 1: 1, 2: 1.5, 3: 1, 4: 2 };
  let wsum = 0, wtot = 0, scoreSum = 0, scoreW = 0;
  for (const r of list) {
    const w = weights[r.stage] || 1;
    const sw = STANCE_WEIGHT[r.verdict.stance] || 0;
    wsum += sw * w;
    wtot += 2 * w;
    scoreSum += r.verdict.score * w;
    scoreW += w;
  }
  const biasIndex = wtot ? +(wsum / wtot).toFixed(3) : 0;      // -1 ~ 1 倾向指数
  const avgScore = scoreW ? Math.round(scoreSum / scoreW) : 50; // 0-100 看多强度

  let consistency = '中性';
  if (bull >= Math.ceil((total * 2) / 3)) consistency = '强多';
  else if (bull > bear) consistency = '偏多';
  else if (bear >= Math.ceil((total * 2) / 3)) consistency = '强空';
  else if (bear > bull) consistency = '偏空';

  const mom = ['TECHNICAL', 'FUNDS', 'MANAGER_MOMENTUM']
    .map((k) => results[k]?.verdict?.stance)
    .filter(Boolean);
  const strongBullStructure = mom.length === 3 && mom.every((s) => s === '强多' || s === '偏多');

  let engineAction = '观望';
  if (biasIndex > 0.15 && avgScore >= 55) engineAction = '买入';
  else if (biasIndex < -0.15 && avgScore <= 45) engineAction = '卖出';
  if (veto) engineAction = engineAction === '买入' ? '观望' : engineAction;

  let basePosition = engineAction === '买入' ? Math.round(clamp(30 + (avgScore - 50) * 1.2, 20, 70))
    : engineAction === '卖出' ? 0 : 20;
  if (strongBullStructure && engineAction === '买入') basePosition = Math.round(clamp(basePosition + 10, 20, 80));
  if (veto) basePosition = Math.min(basePosition, 20);

  const gm = results.GM?.verdict;
  const conflict = !!(gm && gm.action && gm.action !== engineAction);

  return {
    counts, bull, bear, consistency, strongBullStructure,
    biasIndex, avgScore, engineAction, enginePosition: basePosition,
    veto: !!veto,
    gmAction: gm?.action || null,
    gmPosition: gm?.position ?? null,
    conflict,
    verdicts: list.map((r) => ({
      role: r.role, title: r.title, stage: r.stage,
      stance: r.verdict.stance, score: r.verdict.score, confidence: r.verdict.confidence,
      action: r.verdict.action, veto: r.verdict.veto, key_point: r.verdict.key_point,
      provider: r.provider, degraded: r.degraded, mocked: r.mocked, parseMode: r.verdict.parseMode
    }))
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const STAGE_LABELS = {
  1: '第一阶段 · 专业分析师团队（并行）',
  2: '第二阶段 · 总监整合层',
  3: '第三阶段 · 风险控制层',
  4: '第四阶段 · 最高决策层'
};

export async function runAnalysis({ symbol, settings, market, emit = () => {} }) {
  const started = Date.now();
  const results = {};

  const runStage = async (stage) => {
    const agents = stageAgents(stage);
    emit({ type: 'stage_start', stage, label: STAGE_LABELS[stage], roles: agents.map((a) => a.role) });
    const ctxFor = (agent) => buildStageContext(stage, results, agent);
    const out = await pool(agents, settings.concurrency, (agent) =>
      runAgent(agent, {
        symbol,
        marketContext: market.context,
        context: ctxFor(agent),
        settings,
        emit,
        stageLabel: STAGE_LABELS[stage],
        mockQuote: market.quote,
        mockTechnicals: market.technicals
      })
    );
    for (const r of out) results[r.role] = r;
    emit({ type: 'stage_done', stage, label: STAGE_LABELS[stage], summary: out.map((r) => ({ role: r.role, stance: r.verdict.stance, score: r.verdict.score, provider: r.provider })) });
    return out;
  };

  await runStage(1);
  await runStage(2);
  await runStage(3);

  // 一票否决优先传递到 GM
  const veto = !!results.RISK_SYSTEM?.verdict?.veto;
  emit({ type: 'stage_start', stage: 4, label: STAGE_LABELS[4], roles: ['GM'] });
  const gm = await runAgent(agentById('GM'), {
    symbol,
    marketContext: market.context,
    context: buildStageContext(4, results, agentById('GM'), veto),
    settings,
    emit,
    stageLabel: STAGE_LABELS[4],
    mockQuote: market.quote,
    mockTechnicals: market.technicals
  });
  results.GM = gm;
  emit({ type: 'stage_done', stage: 4, label: STAGE_LABELS[4], summary: [{ role: 'GM', stance: gm.verdict.stance, score: gm.verdict.score, provider: gm.provider }] });

  const aggregation = aggregate(results, { veto });
  const decision = {
    action: aggregation.gmAction || aggregation.engineAction,
    position: aggregation.gmPosition ?? aggregation.enginePosition,
    engineAction: aggregation.engineAction,
    enginePosition: aggregation.enginePosition,
    consistency: aggregation.consistency,
    engineConflict: aggregation.conflict
  };

  const summary = {
    symbol,
    quote: market.quote,
    technicals: market.technicals,
    provenance: market.provenance,
    degradedRoles: Object.values(results).filter((r) => r.degraded).map((r) => r.role),
    mockedRoles: Object.values(results).filter((r) => r.mocked).map((r) => r.role),
    providersUsed: [...new Set(Object.values(results).map((r) => r.provider).filter(Boolean))],
    elapsedMs: Date.now() - started,
    totalLatencyMs: Object.values(results).reduce((a, r) => a + (r.latencyMs || 0), 0)
  };

  emit({ type: 'decision', decision, aggregation, summary });
  return { results, aggregation, decision, summary, market };
}

/** 各阶段看到的前序材料（复刻原版的「信息流拓扑」） */
function buildStageContext(stage, results, agent, veto = false) {
  const get = (role) => {
    const r = results[role];
    if (!r) return `[${role}] （缺失）`;
    return `[${agentById(role)?.title || role}·${r.verdict.stance}·${r.verdict.score}分]\n${r.text}`;
  };
  if (stage === 2) {
    if (agent.role === 'MANAGER_FUNDAMENTAL') {
      return ['MACRO', 'INDUSTRY', 'FUNDAMENTAL'].map(get).join('\n\n');
    }
    return ['TECHNICAL', 'FUNDS'].map(get).join('\n\n');
  }
  if (stage === 3) {
    if (agent.role === 'RISK_SYSTEM') return ['MACRO', 'MANAGER_FUNDAMENTAL', 'MANAGER_MOMENTUM'].map(get).join('\n\n');
    return ['TECHNICAL', 'MANAGER_FUNDAMENTAL', 'MANAGER_MOMENTUM'].map(get).join('\n\n');
  }
  if (stage === 4) {
    const base = ['MACRO', 'INDUSTRY', 'TECHNICAL', 'FUNDS', 'FUNDAMENTAL', 'MANAGER_FUNDAMENTAL', 'MANAGER_MOMENTUM', 'RISK_SYSTEM', 'RISK_PORTFOLIO']
      .map(get).join('\n\n');
    return veto ? `【⚠️ 系统性风险总监已行使一票否决】你的最终仓位不得超过 20%，且不得给出买入指令。\n\n${base}` : base;
  }
  return '';
}

export { AGENTS };