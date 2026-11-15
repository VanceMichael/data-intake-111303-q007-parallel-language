// 跨次执行状态：只复用已落盘且能追溯依据（页面修订）的进度。
// 合并只按 revision 字段判定新旧：旧修订迟到不回退，新修订到达时记录被撤下的锚点。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function emptyState() {
  return {
    version: 1,
    pages: {}, // 规范路径 -> { path, lang, point, revision, alternates, segments, removed }
    aliases: {}, // 重定向中间路径 -> 规范路径
    points: {}, // 最近一次按观察点给出的段落状态
    evidence: {}, // 与 points 对应的双侧证据
    relations: [], // 最近一次确认的页级关系
    uncertain: [], // 最近一次留待确认的弱线索
    uncertainEvidence: {}
  };
}

export async function loadState(stateDir) {
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8'));
    if (raw && raw.version === 1 && raw.pages && typeof raw.pages === 'object') {
      return { ...emptyState(), ...raw };
    }
  } catch {
    // 无可用状态或状态损坏：从零开始，不伪称恢复
  }
  return emptyState();
}

export async function saveState(stateDir, state, result) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state, null, 2));
  await writeFile(path.join(stateDir, 'result.json'), JSON.stringify(result, null, 2));
}

// 合并一条抓取记录。返回 { outcome, previousPoint }：
// new/updated/merged/same/stale；stale 表示旧修订迟到，已忽略内容。
export function mergePage(state, record, observations) {
  const stored = state.pages[record.path];
  if (!stored) {
    state.pages[record.path] = { ...record, removed: {} };
    return { outcome: 'new', previousPoint: null };
  }
  if (record.revision < stored.revision) {
    observations.push({
      type: 'stale-revision',
      page: record.path,
      storedRevision: stored.revision,
      receivedRevision: record.revision,
      note: '旧修订迟到，保留已落盘的较高修订'
    });
    return { outcome: 'stale', previousPoint: stored.point };
  }
  if (record.revision === stored.revision) {
    let changed = false;
    for (const [anchor, segment] of Object.entries(record.segments)) {
      const prior = stored.segments[anchor];
      if (!prior || (segment.revision ?? record.revision) > (prior.revision ?? stored.revision)) {
        stored.segments[anchor] = segment;
        changed = true;
      }
    }
    for (const target of record.alternates) {
      if (!stored.alternates.includes(target)) {
        stored.alternates.push(target);
        changed = true;
      }
    }
    return { outcome: changed ? 'merged' : 'same', previousPoint: stored.point };
  }
  // 更高修订到达：整页替换，并把消失的锚点登记为“源侧撤下”线索
  const previousPoint = stored.point;
  const removed = { ...(stored.removed ?? {}) };
  for (const [anchor, segment] of Object.entries(stored.segments ?? {})) {
    if (!(anchor in record.segments)) {
      removed[anchor] = { ...segment, removedAtRevision: record.revision };
      observations.push({
        type: 'removed-anchor-recorded',
        page: record.path,
        anchor,
        lastRevision: segment.revision ?? stored.revision,
        removedAtRevision: record.revision
      });
    }
  }
  for (const anchor of Object.keys(record.segments)) delete removed[anchor]; // 重新出现即撤销撤下记录
  state.pages[record.path] = { ...record, removed };
  return { outcome: 'updated', previousPoint };
}
