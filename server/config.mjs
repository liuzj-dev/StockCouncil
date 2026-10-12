/**
 * config.mjs —— 全局配置：环境变量加载 / 模型端口注册表 / 角色-模型路由
 * 零依赖：仅使用 Node 内置模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'web');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

/* ------------------------------------------------------------------ */
/* .env 加载（不覆盖已存在的系统环境变量）                             */
/* ------------------------------------------------------------------ */
function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

export function loadEnv() {
  const loaded = {};
  for (const file of [path.join(ROOT, '.env')]) {
    try {
      if (fs.existsSync(file)) Object.assign(loaded, parseEnvText(fs.readFileSync(file, 'utf8')));
    } catch { /* ignore */ }
  }
  for (const [k, v] of Object.entries(loaded)) {
    if (process.env[k] === undefined && v !== '') process.env[k] = v;
  }
  return loaded;
}

export function envValue(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim() !== '' && !/^(your_|xxx|sk-xxx|<)/i.test(String(v).trim())) return String(v).trim();
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 模型端口注册表：所有 LLM 统一从这里进出                             */
/* kind: gemini = Google 原生协议；openai = OpenAI 兼容协议；mock = 离线 */
/* ------------------------------------------------------------------ */
export const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    envKey: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    tag: '联网搜索 / 长上下文',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    note: '内置 Google Search Grounding，适合宏观与行业情报类角色。'
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    kind: 'openai',
    envKey: 'XAI_API_KEY',
    baseUrlEnv: 'XAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4-fast',
    models: ['grok-4', 'grok-4-fast', 'grok-3', 'grok-3-mini'],
    tag: '实时舆情 / 反共识',
    keyUrl: 'https://console.x.ai/',
    note: 'xAI 兼容 OpenAI 协议，适合舆情、情绪与反共识角色。'
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    kind: 'openai',
    envKey: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.1',
    models: ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    tag: '综合推理主力',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '本项目默认主力推理端口，承担总监/风控/总经理等关键角色。'
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT（预留端口）',
    kind: 'openai',
    envKey: 'CHATGPT_API_KEY',
    baseUrlEnv: 'CHATGPT_BASE_URL',
    baseUrl: '',
    defaultModel: 'gpt-5-chat',
    models: ['gpt-5-chat', 'gpt-4o-chat', 'chatgpt-latest'],
    tag: '预留 / 待接入',
    reserved: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '预留插槽：填好 CHATGPT_BASE_URL 与 CHATGPT_API_KEY 即可启用（可指向 Azure OpenAI、企业网关或任意兼容端点）。'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    tag: '低成本量化推演',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '原项目主力模型，成本低，适合技术面/估值类角色。'
  },
  {
    id: 'qwen',
    label: '通义千问 Qwen',
    kind: 'openai',
    envKey: 'QWEN_API_KEY',
    baseUrlEnv: 'QWEN_BASE_URL',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    tag: '中文语境',
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '中文财经语境友好，可作备用端口。'
  },
  {
    id: 'custom',
    label: '自定义端点（OpenAI 兼容）',
    kind: 'openai',
    envKey: 'CUSTOM_API_KEY',
    baseUrlEnv: 'CUSTOM_BASE_URL',
    baseUrl: '',
    defaultModel: 'default',
    models: [],
    tag: '私有网关 / 本地模型',
    keyUrl: '',
    note: '把 CUSTOM_BASE_URL 指向任意 OpenAI 兼容服务（vLLM、Ollama、企业网关、代理）。'
  },
  {
    id: 'mock',
    label: '离线演示 (Mock)',
    kind: 'mock',
    envKey: '',
    baseUrl: '',
    defaultModel: 'mock-analyst',
    models: ['mock-analyst'],
    tag: '无密钥可跑通全流程',
    keyUrl: '',
    note: '不调用任何外部服务，用内置模板输出，用于演示/联调/自检。'
  }
];

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

export function providerBaseUrl(prov) {
  const fromEnv = prov.baseUrlEnv ? envValue(prov.baseUrlEnv) : '';
  return (fromEnv || prov.baseUrl || '').replace(/\/+$/, '');
}

/** 端口就绪状态：ready / missing-key / reserved */
export function providerStatus(prov) {
  if (prov.kind === 'mock') return 'ready';
  const key = prov.envKey ? envValue(prov.envKey) : '';
  const base = providerBaseUrl(prov);
  if (prov.reserved) return base && key ? 'ready' : 'reserved';
  if (!key) return 'missing-key';
  if (prov.id === 'custom' && !base) return 'missing-key';
  return 'ready';
}

/** 供前端展示的端口清单（绝不回传密钥明文） */
export function providerCatalog() {
  return PROVIDERS.map((p) => {
    const st = providerStatus(p);
    const key = p.envKey ? envValue(p.envKey) : '';
    return {
      id: p.id,
      label: p.label,
      kind: p.kind,
      tag: p.tag,
      note: p.note,
      keyUrl: p.keyUrl,
      reserved: !!p.reserved,
      envKey: p.envKey || null,
      baseUrl: providerBaseUrl(p) || null,
      models: p.models,
      defaultModel: p.defaultModel,
      status: st,
      keyHint: key ? `${key.slice(0, 4)}••••${key.slice(-3)}` : null
    };
  });
}

/* ------------------------------------------------------------------ */
/* 角色路由：每个智能体可以固定端口，也可以 auto（按优先级自动挑选）    */
/* ------------------------------------------------------------------ */
export const AGENT_ORDER = [
  'MACRO', 'INDUSTRY', 'TECHNICAL', 'FUNDS', 'FUNDAMENTAL',
  'MANAGER_FUNDAMENTAL', 'MANAGER_MOMENTUM',
  'RISK_SYSTEM', 'RISK_PORTFOLIO', 'GM'
];

/** auto 模式下的端口优先级（只用就绪的端口） */
export const AUTO_PRIORITY = {
  MACRO: ['gemini', 'grok', 'openai', 'deepseek', 'qwen', 'custom'],
  INDUSTRY: ['gemini', 'grok', 'openai', 'deepseek', 'qwen', 'custom'],
  TECHNICAL: ['openai', 'deepseek', 'grok', 'gemini', 'qwen', 'custom'],
  FUNDS: ['grok', 'gemini', 'openai', 'deepseek', 'qwen', 'custom'],
  FUNDAMENTAL: ['openai', 'deepseek', 'gemini', 'grok', 'qwen', 'custom'],
  MANAGER_FUNDAMENTAL: ['openai', 'gemini', 'deepseek', 'grok', 'qwen', 'custom'],
  MANAGER_MOMENTUM: ['grok', 'openai', 'gemini', 'deepseek', 'qwen', 'custom'],
  RISK_SYSTEM: ['openai', 'gemini', 'deepseek', 'grok', 'qwen', 'custom'],
  RISK_PORTFOLIO: ['openai', 'deepseek', 'gemini', 'grok', 'qwen', 'custom'],
  GM: ['openai', 'gemini', 'grok', 'deepseek', 'qwen', 'custom']
};

export function defaultRouting() {
  const out = {};
  for (const role of AGENT_ORDER) out[role] = { provider: 'auto', model: '' };
  return out;
}

/* ------------------------------------------------------------------ */
/* 运行期设置（端口 / 并发 / 演示模式 / 数据源）                        */
/* ------------------------------------------------------------------ */
export function defaultSettings() {
  return {
    port: Number(envValue('PORT') || 8787),
    concurrency: Number(envValue('CONCURRENCY') || 4),
    requestTimeoutMs: Number(envValue('REQUEST_TIMEOUT_MS') || 120000),
    offlineDemo: envValue('OFFLINE_DEMO') === '1',
    marketSources: ['tencent', 'sina', 'eastmoney'],
    routing: defaultRouting()
  };
}

export function loadSettings() {
  const base = defaultSettings();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return {
        ...base,
        ...saved,
        routing: { ...base.routing, ...(saved.routing || {}) }
      };
    }
  } catch { /* ignore */ }
  return base;
}

export function saveSettings(settings) {
  const s = { ...settings };
  delete s.port;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch { /* ignore */ }
  return s;
}

/** 解析某个角色最终使用的端口（自动跳过未配置的端口） */
export function resolveProvider(settings, role, explicit) {
  const want = explicit || (settings.routing[role] && settings.routing[role].provider) || 'auto';
  if (want !== 'auto') {
    const p = providerById(want);
    if (p && providerStatus(p) === 'ready') return p;
    if (p && p.kind === 'mock') return p;
  }
  const chain = AUTO_PRIORITY[role] || [];
  for (const id of chain) {
    const p = providerById(id);
    if (p && providerStatus(p) === 'ready') return p;
  }
  if (settings.offlineDemo) return providerById('mock');
  return providerById('mock');
}

/** 降级链：主端口失败后依次尝试的端口 */
export function fallbackChain(settings, role, primary) {
  const chain = [primary];
  for (const id of [AUTO_PRIORITY[role] || [], ['gemini', 'openai', 'grok', 'deepseek', 'qwen', 'custom', 'mock']].flat()) {
    const p = providerById(id);
    if (!p || chain.some((c) => c.id === p.id)) continue;
    if (providerStatus(p) === 'ready') chain.push(p);
  }
  return chain;
}