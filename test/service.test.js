import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { adfToText } from '../src/core.js';
import { DEMO_ISSUE } from '../src/demo.js';

// In-memory stand-ins for Forge KVS and the Jira REST API.
function fakes(issues) {
  const kv = new Map();
  const comments = [];
  const store = {
    listAssets: async () => structuredClone(kv.get('assets') ?? []),
    replaceAssets: async (assets) => void kv.set('assets', structuredClone(assets)),
    getMeta: async () => kv.get('meta'),
    putMeta: async (m) => void kv.set('meta', m),
    receipts: async (key) => [...kv].filter(([k]) => k.startsWith(`receipt:${key}:`)).map(([, v]) => v),
    addReceipt: async (r) => void kv.set(`receipt:${r.issueKey}:${r.id}`, r),
    getScan: async (key) => kv.get(`scan:${key}`),
    putScan: async (key, s) => void kv.set(`scan:${key}`, s),
  };
  const jira = {
    getIssue: async (key) => {
      if (!issues[key]) throw new Error(`Work item ${key} was not found or you cannot see it.`);
      return { key, labels: [], components: [], description: '', ...issues[key] };
    },
    addComment: async (key, adf) => void comments.push({ key, text: adfToText(adf) }),
    listProjects: async () => [{ key: 'DATA', name: 'Data platform' }],
    createIssue: async (projectKey, summary, adf) => {
      const key = `${projectKey}-${Object.keys(issues).length + 100}`;
      issues[key] = { summary, description: adfToText(adf).trim() };
      return key;
    },
  };
  let n = 0;
  const service = createService({ store, jira, now: () => '2026-11-05T10:00:00.000Z', newId: () => `r${++n}` });
  return { service, comments };
}

const ISSUES = {
  'DATA-42': DEMO_ISSUE,
  'DATA-7': { summary: 'Fix the README typo' },
};

test('createDemoIssue files the demo work item, which Downstream then flags', async () => {
  const { service } = fakes({ ...ISSUES });
  await service.loadSample();
  assert.deepEqual(await service.projects(), [{ key: 'DATA', name: 'Data platform' }]);
  await assert.rejects(() => service.createDemoIssue('not a key!'), /Pick a Jira project/);
  const { issueKey } = await service.createDemoIssue('data');
  assert.match(issueKey, /^DATA-\d+$/);
  const panel = await service.panel(issueKey);
  assert.deepEqual(panel.changes.map((c) => c.severity), ['blocking', 'blocking']);
});

test('everything explains that a project must be connected first', async () => {
  const { service } = fakes(ISSUES);
  await assert.rejects(() => service.ticketImpact('DATA-42'), /No dbt project is connected/);
  assert.deepEqual(await service.listAssets(), { meta: null, assets: [] });
});

test('loadSample imports the jaffle shop and lists models first', async () => {
  const { service } = fakes(ISSUES);
  const res = await service.loadSample();
  assert.equal(res.project, 'jaffle_shop');
  assert.equal(res.assets, 12);
  const { meta, assets } = await service.listAssets();
  assert.equal(meta.syncedAt, '2026-11-05T10:00:00.000Z');
  assert.deepEqual(assets.slice(0, 2).map((a) => a.name), ['customers', 'fct_revenue']);
  assert.equal(assets.find((a) => a.name === 'orders').usedBy, 4);
});

test('ticketImpact reports blocking contract breaks with owners and next steps', async () => {
  const { service } = fakes(ISSUES);
  await service.loadSample();
  const text = await service.ticketImpact('DATA-42');
  assert.match(text, /Downstream impact of DATA-42/);
  assert.match(text, /\[BLOCKING\] drop orders\.discount_amount/);
  assert.match(text, /\[BLOCKING\] rename orders\.amount/);
  assert.match(text, /Affected owners no receipt mentions yet: .*Finance analytics/);
  assert.match(text, /call check-change/);
});

test('checkChange blocks a breaking plan and passes a versioned one', async () => {
  const { service } = fakes(ISSUES);
  await service.loadSample();
  const bad = await service.checkChange('Rename amount to gross_amount in orders.sql and drop discount_amount.', 'DATA-42');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.changes.map((c) => [c.asset, c.column, c.op, c.severity]), [
    ['orders', 'amount', 'rename', 'blocking'],
    ['orders', 'discount_amount', 'drop', 'blocking'],
  ]);
  assert.deepEqual(bad.changes[0].breaks, ['customers', 'fct_revenue']);
  assert.match(bad.summary, /^❌/);

  const good = await service.checkChange('Add a new model orders_v2 with a gross_amount column; leave the current orders model untouched.');
  assert.equal(good.ok, true, good.summary);
  assert.match(good.summary, /^✅/);
});

test('checkChange uses the work item to name the model a terse plan refers to', async () => {
  const { service } = fakes(ISSUES);
  await service.loadSample();
  const res = await service.checkChange('Rename amount to gross_amount.', 'DATA-42');
  assert.deepEqual(res.changes.map((c) => [c.asset, c.column, c.op]), [['orders', 'amount', 'rename']]);
  // Changes only described in the work item are not attributed to the plan.
  assert.ok(!res.changes.some((c) => c.column === 'discount_amount'));
});

test('impactOf and describeAsset look assets up and suggest near misses', async () => {
  const { service } = fakes(ISSUES);
  await service.loadSample();
  assert.match(await service.impactOf('orders', 'discount_amount'), /Directly: fct_revenue \(reads discount_amount\)/);
  await assert.rejects(() => service.impactOf('order'), /Did you mean: orders/);
  await assert.rejects(() => service.impactOf('orders', 'nope'), /no documented column "nope"/);
  assert.match(await service.describeAsset('raw.payments'), /^raw\.payments \(dbt source\), owned by Data platform/);
  assert.match(await service.findAssets('churn'), /Churn prediction model \(dbt ml\), owned by ML platform/);
});

test('submitReceipt comments and lists affected owners nobody notified', async () => {
  const { service, comments } = fakes(ISSUES);
  await service.loadSample();
  const res = await service.submitReceipt(
    { issueKey: 'DATA-42', summary: 'Added orders v2; v1 stays until 1 Dec', notified: 'Finance analytics, ML platform', tests: 'dbt build: 23 passed', prUrl: 'https://github.com/acme/jaffle/pull/7', agent: 'Claude Code' },
    'acc-1',
  );
  assert.deepEqual(res.unnotified, ['Finance operations', 'Growth analytics']);
  assert.equal(comments.length, 1);
  assert.match(comments[0].text, /Data change receipt from Claude Code/);
  assert.match(comments[0].text, /not notified yet: Finance operations, Growth analytics/);
  const panel = await service.panel('DATA-42');
  assert.equal(panel.receipts.length, 1);
  assert.deepEqual(panel.unnotified, ['Finance operations', 'Growth analytics']);
});

test('scanIssue comments once per new risky change and ignores quiet work items', async () => {
  const { service, comments } = fakes(ISSUES);
  await service.loadSample();
  const first = await service.scanIssue('DATA-42');
  assert.equal(first.notified.length, 2);
  assert.equal(comments.length, 1);
  assert.match(comments[0].text, /BLOCKING: drop orders\.discount_amount/);
  assert.deepEqual((await service.scanIssue('DATA-42')).notified, []);
  await service.scanIssue('DATA-7');
  assert.equal(comments.length, 1);
});

test('panel returns plain data the UI can render', async () => {
  const { service } = fakes(ISSUES);
  await service.loadSample();
  const panel = await service.panel('DATA-42');
  assert.equal(panel.changes[0].asset.contract, true);
  assert.deepEqual(panel.changes[0].direct.map((d) => [d.name, d.owner]), [['fct_revenue', 'Finance analytics']]);
  assert.deepEqual(panel.changes[0].exposures.map((d) => d.name).sort(), ['Churn prediction model', 'Monthly finance close export', 'Revenue dashboard']);
});

test('importProject refuses folders without dbt models', async () => {
  const { service } = fakes(ISSUES);
  await assert.rejects(() => service.importProject([{ path: 'README.md', text: '# hi' }], {}), /No dbt models were found/);
});
