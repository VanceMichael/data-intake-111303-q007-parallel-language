// 抓取与规范化：只读取来源接口返回的 lang/point/revision/alternates/segments，
// 手动跟随重定向并记录链路证据；不以请求抵达顺序推断资料版本。

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 8;
const MAX_PAGES = 200;

export async function crawl({ source, seeds, timeoutMs = 5000, observations = [] }) {
  const pages = new Map(); // 规范路径 -> 页面记录
  const aliases = new Map(); // 跳转中间路径 -> 最终规范路径
  const queue = [...seeds];
  const requested = new Set();

  while (queue.length > 0) {
    if (requested.size >= MAX_PAGES) {
      observations.push({ type: 'crawl-limit', note: '抓取页面数超出本地演练上限，剩余互链留待下次' });
      break;
    }
    const path = queue.shift();
    if (requested.has(path)) continue;
    requested.add(path);
    const fetched = await fetchPage(source, path, timeoutMs, observations);
    if (!fetched) continue; // 读取失败不等于不存在，已记录观察
    const { record, chain } = fetched;
    for (const hop of chain.slice(0, -1)) aliases.set(hop, record.path);
    if (pages.has(record.path)) continue;
    pages.set(record.path, record);
    for (const target of record.alternates) queue.push(target);
  }
  return { pages, aliases };
}

async function fetchPage(source, startPath, timeoutMs, observations) {
  const origin = new URL(source).origin;
  const chain = [startPath];
  let current = startPath;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response;
    try {
      response = await fetch(new URL(current, source), {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      observations.push({ type: 'fetch-failed', path: current, detail: String(error?.message ?? error) });
      return null;
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      await response.text().catch(() => {});
      if (!location) {
        observations.push({ type: 'fetch-failed', path: current, status: response.status, detail: '重定向缺少 location' });
        return null;
      }
      const next = new URL(location, new URL(current, source));
      if (next.origin !== origin) {
        observations.push({ type: 'external-redirect', from: current, to: next.href, note: '重定向离开本地来源，停止跟随' });
        return null;
      }
      chain.push(next.pathname);
      current = next.pathname;
      continue;
    }
    if (!response.ok) {
      observations.push({ type: 'fetch-failed', path: current, status: response.status });
      return null;
    }
    let body;
    try {
      body = await response.json();
    } catch {
      observations.push({ type: 'invalid-payload', path: current, detail: '响应不是有效 JSON' });
      return null;
    }
    const record = normalizePage(current, body, observations);
    if (!record) return null;
    if (chain.length > 1) observations.push({ type: 'redirect', from: startPath, to: record.path, chain });
    return { record, chain };
  }
  observations.push({ type: 'redirect-loop', from: startPath, chain });
  return null;
}

function normalizePage(path, body, observations) {
  if (!body || typeof body !== 'object') {
    observations.push({ type: 'invalid-payload', path, detail: '响应不是对象' });
    return null;
  }
  const { lang, point, revision } = body;
  if (typeof lang !== 'string' || typeof point !== 'string' || typeof revision !== 'number') {
    observations.push({ type: 'invalid-payload', path, detail: '缺少 lang/point/revision 字段' });
    return null;
  }
  const alternates = [...new Set((Array.isArray(body.alternates) ? body.alternates : []).filter((item) => typeof item === 'string'))];
  const segments = {};
  for (const segment of Array.isArray(body.segments) ? body.segments : []) {
    if (!segment || typeof segment.anchor !== 'string') continue;
    const entry = {
      revision: typeof segment.revision === 'number' ? segment.revision : undefined,
      sourceRevision: typeof segment.sourceRevision === 'number' ? segment.sourceRevision : undefined,
      kind: typeof segment.kind === 'string' ? segment.kind : 'body',
      text: typeof segment.text === 'string' ? segment.text : ''
    };
    const prior = segments[segment.anchor];
    if (!prior) {
      segments[segment.anchor] = entry;
    } else if ((entry.revision ?? -1) > (prior.revision ?? -1)) {
      observations.push({ type: 'anchor-conflict', page: path, anchor: segment.anchor, note: '同页内锚点重复，保留较高修订' });
      segments[segment.anchor] = entry;
    } else {
      observations.push({ type: 'anchor-conflict', page: path, anchor: segment.anchor, note: '同页内锚点重复，保留较高修订' });
    }
  }
  return { path, lang, point, revision, alternates, segments };
}
