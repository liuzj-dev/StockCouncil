/**
 * store.mjs —— 历史记录持久化（零依赖，JSON 文件；上限 100 条）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HISTORY_FILE } from './config.mjs';

const MAX_ITEMS = 100;

function readAll() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch { return []; }
}

function writeAll(items) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

export function listHistory({ limit = 50 } = {}) {
  return readAll()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((it) => ({
      id: it.id, symbol: it.symbol, name: it.name,
      action: it.action, position: it.position, consistency: it.consistency,
      timestamp: it.timestamp, elapsedMs: it.elapsedMs,
      providers: it.providers || [], mocked: it.mocked || false
    }));
}

export function getHistory(id) {
  return readAll().find((it) => it.id === id) || null;
}

export function addHistory(record) {
  const items = readAll();
  const idx = items.findIndex((it) => it.symbol === record.symbol && it.date === record.date);
  const entry = { ...record, id: `${record.symbol}-${record.timestamp}` };
  if (idx >= 0) items[idx] = entry; else items.unshift(entry);
  writeAll(items.slice(0, MAX_ITEMS));
  return entry.id;
}

export function deleteHistory(id) {
  const items = readAll().filter((it) => it.id !== id);
  writeAll(items);
  return true;
}

export function clearHistory() {
  writeAll([]);
  return true;
}