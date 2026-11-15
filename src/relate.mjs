// 关系与状态判定：只依据显式语言互链、观察点标识（point）与段落锚点（anchor）。
// 不做机器翻译，不做文本相似度强配；证据不足的关系进入 uncertain 留待人工确认。
//
// 页级确认：双向互链且 point 一致；锚点只在同一观察点的确认组件内比较。
// 段落方向：携带 sourceRevision 的段落是译文，否则视为源文原创段落。

// 由合并后的页面状态构建关系图：确认边、确认组件、弱线索。
export function buildGraph(pageMap, aliasMap, observations) {
  const paths = Object.keys(pageMap).sort();
  const resolve = (target) => aliasMap.get(target) ?? target;

  // 解析互链到规范路径；指回自身的语言链接直接丢弃并留证
  const links = new Map();
  for (const path of paths) {
    const seen = new Set();
    const list = [];
    for (const raw of pageMap[path].alternates ?? []) {
      const canonical = resolve(raw);
      if (canonical === path) {
        observations.push({ type: 'self-link', page: path, target: raw, note: '语言链接指回自身，已忽略' });
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      list.push({ raw, canonical });
    }
    links.set(path, list);
  }

  const edges = new Map(); // 无向键 -> [a, b]（确认边）
  const clues = new Map(); // 无向键 -> 弱线索（每个页对只保留一条，方向取先见者，路径序确定）
  for (const path of paths) {
    const page = pageMap[path];
    for (const { raw, canonical } of links.get(path)) {
      const target = pageMap[canonical];
      const pairKey = [path, canonical].sort().join('\n');
      if (!target) {
        if (!clues.has(pairKey)) clues.set(pairKey, { from: path, to: raw, reasons: ['target-unreachable'] });
        continue;
      }
      if (target.lang === page.lang) {
        observations.push({ type: 'same-language-link', page: path, target: canonical, lang: page.lang, note: '互链两端语言相同，不构成跨语言线索' });
        continue;
      }
      const mutual = (links.get(canonical) ?? []).some((link) => link.canonical === path);
      const samePoint = target.point === page.point;
      if (mutual && samePoint) {
        if (!edges.has(pairKey)) edges.set(pairKey, [path, canonical].sort());
      } else if (!clues.has(pairKey)) {
        const reasons = [];
        if (!mutual) reasons.push('only-one-way-link');
        if (!samePoint) reasons.push(`point-mismatch:${page.point}!=${target.point}`);
        clues.set(pairKey, { from: path, to: canonical, reasons });
      }
    }
  }

  // 并查集求确认组件；确认边要求同点，组件内各页 point 必然一致
  const parent = new Map(paths.map((path) => [path, path]));
  const find = (value) => {
    let root = value;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = value;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  for (const [a, b] of edges.values()) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const path of paths) {
    const root = find(path);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(path);
  }

  const components = [];
  const relations = [];
  for (const members of groups.values()) {
    const langs = [...new Set(members.map((member) => pageMap[member].lang))].sort();
    const component = { point: pageMap[members[0]].point, members, langs };
    components.push(component);
    if (members.length > 1 && langs.length > 1) {
      const pages = {};
      for (const lang of langs) pages[lang] = members.filter((member) => pageMap[member].lang === lang).sort();
      relations.push({ point: component.point, status: 'confirmed', basis: 'mutual-alternates', pages });
    }
  }
  return { components, relations, clues: [...clues.values()] };
}

// 在单个确认组件内比较锚点，给出每个锚点的状态与双侧证据。
export function computeStatuses(component, pageMap, observations) {
  const { point, members, langs } = component;
  if (langs.length < 2) return null;
  const revisionOf = (segment, page) => (typeof segment.revision === 'number' ? segment.revision : page.revision);

  // 允许一页对应多页：同一语言在组件内有多页时，按锚点合并并保留较高修订
  const perLang = new Map(langs.map((lang) => [lang, new Map()]));
  for (const path of members) {
    const page = pageMap[path];
    const table = perLang.get(page.lang);
    for (const [anchor, segment] of Object.entries(page.segments ?? {})) {
      const prior = table.get(anchor);
      if (!prior) {
        table.set(anchor, { segment, page: path });
        continue;
      }
      const nextRevision = revisionOf(segment, page);
      const priorRevision = revisionOf(prior.segment, pageMap[prior.page]);
      const differs = JSON.stringify(segment) !== JSON.stringify(prior.segment);
      if (nextRevision > priorRevision) {
        table.set(anchor, { segment, page: path });
        if (differs) observations.push({ type: 'anchor-conflict', point, anchor, lang: page.lang, kept: path, dropped: prior.page });
      } else if (differs) {
        observations.push({ type: 'anchor-conflict', point, anchor, lang: page.lang, kept: prior.page, dropped: path });
      }
    }
  }

  const pagesByLang = {};
  for (const lang of langs) pagesByLang[lang] = members.filter((member) => pageMap[member].lang === lang).sort();

  const anchors = new Set();
  for (const table of perLang.values()) for (const anchor of table.keys()) anchors.add(anchor);

  const statuses = {};
  const evidence = {};
  for (const anchor of [...anchors].sort()) {
    const present = [];
    for (const lang of langs) {
      const hit = perLang.get(lang).get(anchor);
      if (hit) present.push({ lang, ...hit });
    }
    // 该语言当前缺失、但状态里登记过“源侧撤下”的记录
    const removedRecords = [];
    for (const path of members) {
      const page = pageMap[path];
      if (perLang.get(page.lang).has(anchor)) continue;
      const record = page.removed?.[anchor];
      if (record) removedRecords.push({ lang: page.lang, page: path, record });
    }

    const isTranslation = (item) => typeof item.segment.sourceRevision === 'number';
    const sources = present.filter((item) => !isTranslation(item));
    const translations = present.filter(isTranslation);

    let status;
    let reason;
    let sourceSide = null;
    let translationSide = null;

    if (sources.length > 0 && translations.length > 0) {
      sourceSide = sources.reduce((best, item) =>
        revisionOf(item.segment, pageMap[item.page]) > revisionOf(best.segment, pageMap[best.page]) ? item : best);
      const sourceRevision = revisionOf(sourceSide.segment, pageMap[sourceSide.page]);
      const lagging = translations.filter((item) => item.segment.sourceRevision < sourceRevision);
      translationSide = lagging[0] ?? translations[0];
      if (lagging.length > 0) {
        status = 'translation-lag';
        reason = `译文依据源文修订 ${translationSide.segment.sourceRevision}，源文段落已为修订 ${sourceRevision}`;
      } else {
        status = 'matched';
        reason = `译文已对应源文修订 ${sourceRevision}`;
      }
    } else if (present.length >= 2 && translations.length === 0) {
      status = 'matched';
      [sourceSide, translationSide] = present;
      reason = '双侧均为原创段落，锚点在确认关系内一致';
    } else if (present.length >= 2) {
      status = 'uncertain';
      reason = '双侧段落均声明译自对方，无法判定方向';
    } else {
      const only = present[0];
      if (removedRecords.length > 0) {
        // 状态可证明源侧曾有此锚点：是源文撤下，不是译文新增
        status = 'source-removed';
        translationSide = only;
        sourceSide = { lang: removedRecords[0].lang, page: removedRecords[0].page, segment: removedRecords[0].record, removed: true };
        reason = '源文页面已撤下该锚点，译文侧仍保留旧段落';
      } else if (isTranslation(only)) {
        // 译文声明了所译源文修订而源侧已无此锚点：同样是源文撤下
        status = 'source-removed';
        translationSide = only;
        reason = `译文声明译自源文修订 ${only.segment.sourceRevision}，源侧当前已无此锚点`;
      } else {
        // 缺译不是删除：源侧独有的原创段落记为源文新增
        status = 'source-new';
        sourceSide = only;
        reason = '源侧独有段落，译文侧尚未对应';
      }
    }

    statuses[anchor] = status;
    const entry = {
      status,
      reason,
      source: sourceSide ? sideEvidence(sourceSide, pageMap, anchor) : null,
      translation: translationSide ? sideEvidence(translationSide, pageMap, anchor) : null,
      relation: { basis: 'mutual-alternates', point, pages: pagesByLang }
    };
    if (status === 'uncertain') entry.sides = present.map((item) => sideEvidence(item, pageMap, anchor));
    evidence[anchor] = entry;
  }
  return { statuses, evidence };
}

// 单侧证据：保留语言、页面修订与段落修订身份；正文/图注/引用通过 kind 区分。
function sideEvidence(item, pageMap, anchor) {
  const page = pageMap[item.page];
  const segment = item.segment;
  const output = {
    page: item.page,
    lang: item.lang,
    pageRevision: page.revision,
    anchor,
    kind: segment.kind ?? 'body',
    text: segment.text ?? ''
  };
  if (typeof segment.revision === 'number') output.revision = segment.revision;
  if (typeof segment.sourceRevision === 'number') output.sourceRevision = segment.sourceRevision;
  if (item.removed) {
    output.removed = true;
    if (typeof segment.removedAtRevision === 'number') output.removedAtRevision = segment.removedAtRevision;
  }
  return output;
}
