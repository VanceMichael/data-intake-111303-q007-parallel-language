// 跨次执行行为：旧修订迟到不回退、局部重算不影响其他观察点、
// 读取失败保留已落盘资料、撤下判定可依据已落盘状态证明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';
import { run } from '../src/workflow.mjs';

async function withStateDir(fn) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'material-increment-'));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('旧修订迟到：保留较高修订，不派生旧段落', { timeout: 15000 }, async () => {
  const scenario = {
    name: '旧修订迟到',
    routes: [
      {
        path: '/zh/g',
        replies: [
          { body: { lang: 'zh', point: 'm1', revision: 5, alternates: ['/ru/g'], segments: [{ anchor: 's1', revision: 5, text: '第五版' }] } },
          { body: { lang: 'zh', point: 'm1', revision: 2, alternates: ['/ru/g'], segments: [{ anchor: 's1', revision: 2, text: '第二版' }, { anchor: 's9', revision: 2, text: '早已撤下的旧段' }] } }
        ]
      },
      { path: '/ru/g', body: { lang: 'ru', point: 'm1', revision: 5, alternates: ['/zh/g'], segments: [{ anchor: 's1', sourceRevision: 5, text: 'Пятая версия' }] } }
    ]
  };
  const source = await startSource(scenario);
  try {
    await withStateDir(async (stateDir) => {
      const first = await run({ source: source.url, stateDir, input: { seeds: ['/zh/g'] } });
      assert.equal(first.points.m1.s1, 'matched');

      const second = await run({ source: source.url, stateDir, input: { seeds: ['/zh/g'] } });
      assert.equal(second.points.m1.s1, 'matched', '旧修订不应改变已确认状态');
      assert.ok(!('s9' in second.points.m1), '旧修订迟到的段落不能当作源文新增');
      assert.ok(second.observations.some((entry) => entry.type === 'stale-revision' && entry.page === '/zh/g'), '应记录旧修订迟到证据');
      assert.equal(second.evidence.m1.s1.source.text, '第五版', '证据应保留较高修订身份');
    });
  } finally {
    await source.close();
  }
});

test('局部重算：更新只影响相关观察点', { timeout: 15000 }, async () => {
  const scenario = {
    name: '局部重算',
    routes: [
      {
        path: '/zh/h',
        replies: [
          { body: { lang: 'zh', point: 'n1', revision: 2, alternates: ['/ru/h'], segments: [{ anchor: 's1', revision: 2, text: '汊一' }] } },
          { body: { lang: 'zh', point: 'n1', revision: 3, alternates: ['/ru/h'], segments: [{ anchor: 's1', revision: 2, text: '汊一' }, { anchor: 's2', revision: 3, text: '汊二' }] } }
        ]
      },
      { path: '/ru/h', body: { lang: 'ru', point: 'n1', revision: 2, alternates: ['/zh/h'], segments: [{ anchor: 's1', sourceRevision: 2, text: 'Рукав' }] } },
      { path: '/zh/i', body: { lang: 'zh', point: 'n2', revision: 1, alternates: ['/ru/i'], segments: [{ anchor: 's1', revision: 1, text: '洼地' }] } },
      { path: '/ru/i', body: { lang: 'ru', point: 'n2', revision: 1, alternates: ['/zh/i'], segments: [{ anchor: 's1', sourceRevision: 1, text: 'Низина' }] } }
    ]
  };
  const source = await startSource(scenario);
  try {
    await withStateDir(async (stateDir) => {
      const first = await run({ source: source.url, stateDir, input: { seeds: ['/zh/h', '/zh/i'] } });
      assert.equal(first.points.n1.s1, 'matched');
      assert.equal(first.points.n2.s1, 'matched');

      const second = await run({ source: source.url, stateDir, input: { seeds: ['/zh/h'] } });
      assert.equal(second.points.n1.s2, 'source-new', '新段落应识别为源文新增');
      assert.equal(second.points.n1.s1, 'matched');
      assert.equal(second.points.n2.s1, 'matched', '未涉及的观察点保持已确认状态');
      assert.ok(second.recomputed.includes('n1'), 'n1 应被重算');
      assert.ok(second.carried.includes('n2'), 'n2 应沿用落盘结果');
      assert.ok(!second.recomputed.includes('n2'), 'n2 不应被重算');
      const visits = source.history.filter((entry) => entry.path === '/zh/i').length;
      assert.equal(visits, 1, '第二次运行不应重新抓取未涉及的页面');
    });
  } finally {
    await source.close();
  }
});

test('读取失败不等于不存在：保留已落盘对应关系', { timeout: 15000 }, async () => {
  const scenario = {
    name: '读取失败',
    routes: [
      {
        path: '/zh/j',
        replies: [
          { body: { lang: 'zh', point: 'o1', revision: 2, alternates: ['/ru/j'], segments: [{ anchor: 's1', revision: 2, text: '留存' }] } },
          { status: 404, body: '本地来源无此资源' }
        ]
      },
      { path: '/ru/j', body: { lang: 'ru', point: 'o1', revision: 2, alternates: ['/zh/j'], segments: [{ anchor: 's1', sourceRevision: 2, text: 'Сохранено' }] } }
    ]
  };
  const source = await startSource(scenario);
  try {
    await withStateDir(async (stateDir) => {
      const first = await run({ source: source.url, stateDir, input: { seeds: ['/zh/j'] } });
      assert.equal(first.points.o1.s1, 'matched');

      const second = await run({ source: source.url, stateDir, input: { seeds: ['/zh/j'] } });
      assert.equal(second.points.o1.s1, 'matched', '读取失败不得抹掉已确认关系');
      assert.ok(second.carried.includes('o1'));
      assert.ok(second.observations.some((entry) => entry.type === 'fetch-failed' && entry.path === '/zh/j'), '应记录读取失败证据');
    });
  } finally {
    await source.close();
  }
});

test('源文撤下可由落盘状态证明（译文未声明源修订时）', { timeout: 15000 }, async () => {
  const scenario = {
    name: '状态证明撤下',
    routes: [
      {
        path: '/zh/k',
        replies: [
          { body: { lang: 'zh', point: 'o2', revision: 2, alternates: ['/ru/k'], segments: [{ anchor: 's1', revision: 2, text: '一' }, { anchor: 's2', revision: 2, kind: 'caption', text: '旧图注' }] } },
          { body: { lang: 'zh', point: 'o2', revision: 3, alternates: ['/ru/k'], segments: [{ anchor: 's1', revision: 2, text: '一' }] } }
        ]
      },
      { path: '/ru/k', body: { lang: 'ru', point: 'o2', revision: 2, alternates: ['/zh/k'], segments: [{ anchor: 's1', sourceRevision: 2, text: 'Один' }, { anchor: 's2', kind: 'caption', text: 'Старая подпись' }] } }
    ]
  };
  const source = await startSource(scenario);
  try {
    await withStateDir(async (stateDir) => {
      const first = await run({ source: source.url, stateDir, input: { seeds: ['/zh/k'] } });
      assert.equal(first.points.o2.s2, 'matched', '双侧原创段落首次对应');

      const second = await run({ source: source.url, stateDir, input: { seeds: ['/zh/k'] } });
      assert.equal(second.points.o2.s2, 'source-removed', '源侧撤下后译文侧仍保留，不得当作源文新增');
      assert.equal(second.points.o2.s1, 'matched');
      const evidence = second.evidence.o2.s2;
      assert.equal(evidence.source.removedAtRevision, 3, '撤下证据应给出撤下时的页面修订');
      assert.equal(evidence.translation.text, 'Старая подпись', '译文侧证据应保留原文');
    });
  } finally {
    await source.close();
  }
});
