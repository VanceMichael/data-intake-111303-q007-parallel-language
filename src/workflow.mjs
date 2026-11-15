// 双语资料采集链路入口：run({ source, stateDir, input })。
// 流程：抓取种子页与互链 -> 按修订合并入状态 -> 只局部重算受影响的观察点关系 ->
// 输出按观察点查询的结构化结果（含双侧证据），并持久化到 stateDir。

import { crawl } from './collect.mjs';
import { loadState, saveState, mergePage } from './store.mjs';
import { buildGraph, computeStatuses } from './relate.mjs';

export async function run({ source, stateDir, input }) {
  const seeds = [...new Set((Array.isArray(input?.seeds) ? input.seeds : []).filter((item) => typeof item === 'string'))];
  const state = await loadState(stateDir);
  const observations = [];

  // 1. 采集：种子页 + 互链传递抓取，重定向链路记入观察
  const fetched = await crawl({ source, seeds, observations });

  // 2. 合并：只按 revision 判定新旧；旧修订迟到不回退，撤下锚点登记留证
  const fetchedPaths = new Set();
  const affectedPoints = new Set();
  for (const record of fetched.pages.values()) {
    fetchedPaths.add(record.path);
    const { outcome, previousPoint } = mergePage(state, record, observations);
    if (outcome !== 'stale') {
      affectedPoints.add(record.point);
      if (previousPoint && previousPoint !== record.point) affectedPoints.add(previousPoint);
    }
  }
  // 页面迁移：旧路径若已落盘而现在重定向到他处，迁移撤下记录并留证
  for (const [alias, canonical] of fetched.aliases) {
    state.aliases[alias] = canonical;
    const moved = state.pages[alias];
    if (moved && alias !== canonical) {
      const target = state.pages[canonical];
      if (target) target.removed = { ...(moved.removed ?? {}), ...(target.removed ?? {}) };
      delete state.pages[alias];
      observations.push({ type: 'page-moved', from: alias, to: canonical, note: '已落盘页面现重定向到他处，按新规范路径继续' });
    }
  }

  // 3. 关系图：基于合并后的全部落盘页面（含本次未访问但未受影响的页面）
  const aliasMap = new Map(Object.entries(state.aliases));
  const graph = buildGraph(state.pages, aliasMap, observations);
  for (const component of graph.components) {
    if (component.langs.length < 2) continue;
    if (component.members.some((member) => fetchedPaths.has(member))) affectedPoints.add(component.point);
  }
  // 落盘结果缺失的点必须重算，不能因“未变化”而漏出
  for (const component of graph.components) {
    if (component.langs.length >= 2 && !state.points[component.point]) affectedPoints.add(component.point);
  }

  // 4. 局部重算：未受影响的观察点沿用已落盘结果，已确认关系不受本次更新影响
  const nextPoints = {};
  const nextEvidence = {};
  const nextRelations = [];
  const carried = [];
  for (const point of Object.keys(state.points)) {
    if (affectedPoints.has(point)) continue;
    nextPoints[point] = state.points[point];
    nextEvidence[point] = state.evidence[point] ?? {};
    carried.push(point);
  }
  for (const relation of state.relations) {
    if (!affectedPoints.has(relation.point)) nextRelations.push(relation);
  }

  const recomputed = new Set();
  for (const component of graph.components) {
    if (component.langs.length < 2 || !affectedPoints.has(component.point)) continue;
    const computed = computeStatuses(component, state.pages, observations);
    if (!computed) continue;
    if (Object.keys(computed.statuses).length > 0) {
      // 同一观察点可能出现多个互不相连的确认组件：合并结果，锚点冲突留证
      if (nextPoints[component.point]) {
        for (const anchor of Object.keys(computed.statuses)) {
          if (anchor in nextPoints[component.point]) {
            observations.push({ type: 'point-components-merged', point: component.point, anchor, note: '同点多个确认组件的锚点结果合并' });
          }
        }
        nextPoints[component.point] = { ...nextPoints[component.point], ...computed.statuses };
        nextEvidence[component.point] = { ...(nextEvidence[component.point] ?? {}), ...computed.evidence };
      } else {
        nextPoints[component.point] = computed.statuses;
        nextEvidence[component.point] = computed.evidence;
      }
    }
    recomputed.add(component.point);
  }
  for (const relation of graph.relations) {
    if (affectedPoints.has(relation.point)) nextRelations.push(relation);
  }

  // 5. 弱线索：每次基于落盘页面整体重建（确定性），格式 源路径->目标路径
  const uncertain = [];
  const uncertainEvidence = {};
  for (const clue of graph.clues) {
    const entry = `${clue.from}->${clue.to}`;
    if (uncertain.includes(entry)) continue;
    uncertain.push(entry);
    const fromPage = state.pages[clue.from];
    const toPage = state.pages[clue.to];
    uncertainEvidence[entry] = {
      reasons: clue.reasons,
      from: fromPage
        ? { page: clue.from, lang: fromPage.lang, point: fromPage.point, revision: fromPage.revision }
        : { page: clue.from },
      to: toPage
        ? { page: clue.to, lang: toPage.lang, point: toPage.point, revision: toPage.revision }
        : { page: clue.to, reachable: false }
    };
  }
  uncertain.sort();

  const sortKeys = (object) => Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  const result = {
    source,
    seeds,
    points: sortKeys(nextPoints),
    evidence: sortKeys(nextEvidence),
    relations: nextRelations.sort((a, b) => a.point.localeCompare(b.point)),
    uncertain,
    uncertainEvidence,
    observations,
    recomputed: [...recomputed].sort(),
    carried: carried.sort()
  };

  // 6. 持久化：结果与状态都落盘，重启只能复用可追溯依据的进度
  state.points = result.points;
  state.evidence = result.evidence;
  state.relations = result.relations;
  state.uncertain = result.uncertain;
  state.uncertainEvidence = result.uncertainEvidence;
  await saveState(stateDir, state, result);
  return result;
}
