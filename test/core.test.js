import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adfToText,
  assessChanges,
  assetText,
  detectChanges,
  downstream,
  findAsset,
  impactAdf,
  impactText,
  indexAssets,
  issueKeyOf,
  normalizeReceipt,
  parseDbtProject,
  receiptAdf,
  searchAssets,
  splitList,
  sqlDependencies,
  unnotifiedOwners,
} from '../src/core.js';
import { sampleFiles } from '../src/demo.js';

const NOW = '2026-11-05T00:00:00.000Z';
const { assets, errors, project } = parseDbtProject(sampleFiles('https://github.com/acme/jaffle/blob/main'));
const index = indexAssets(assets);
const get = (id) => assets.find((a) => a.id === id);
const ids = (xs) => xs.map((x) => x.id).sort();

test('splitList trims and dedupes case-insensitively', () => {
  assert.deepEqual(splitList(' a, b;A\n c ,, '), ['a', 'b', 'c']);
  assert.deepEqual(splitList(['x', 'X']), ['x']);
});

test('sqlDependencies reads ref() in all its forms and source()', () => {
  const sql = `select * from {{ ref('a') }} join {{ ref("pkg", "b") }} join {{ ref('c', v=2) }} join {{ source('raw', 'orders') }}`;
  assert.deepEqual(sqlDependencies(sql), ['model.a', 'model.b', 'model.c', 'source.raw.orders']);
});

test('parseDbtProject builds models, sources and exposures with owners and contracts', () => {
  assert.equal(project, 'jaffle_shop');
  assert.deepEqual(errors, []);
  assert.equal(assets.filter((a) => a.type === 'model').length, 6);
  assert.equal(assets.filter((a) => a.type === 'source').length, 3);
  assert.equal(assets.filter((a) => a.type === 'exposure').length, 3);
  const orders = get('model.orders');
  assert.equal(orders.owner, 'Finance analytics'); // from its group
  assert.equal(orders.contract, true);
  assert.deepEqual(orders.dependsOn, ['model.stg_orders', 'model.stg_payments']);
  assert.equal(get('model.customers').owner, 'Growth analytics'); // from meta
  assert.equal(get('source.raw.orders').owner, 'Data platform'); // inherited from the source
  assert.equal(get('exposure.churn_model').kind, 'ml');
  assert.equal(get('model.orders').url, 'https://github.com/acme/jaffle/blob/main/models/marts/orders.sql');
  assert.equal(get('model.orders').sql, undefined);
});

test('column usage is read from SQL by name, not guessed from select *', () => {
  assert.deepEqual(get('model.fct_revenue').uses['model.orders'], ['order_date', 'status', 'discount_amount', 'amount']);
  // customers imports orders with select * but only reads four of its columns.
  assert.deepEqual(get('model.customers').uses['model.orders'], ['order_id', 'customer_id', 'order_date', 'amount']);
});

test('a model whose final statement is select * passes every column through', () => {
  const p = parseDbtProject([
    { path: 'models/base.sql', text: 'select 1 as a, 2 as b' },
    { path: 'models/view.sql', text: "select * from {{ ref('base') }}" },
    { path: 'models/m.yml', text: 'models:\n  - name: base\n    columns: [{name: a}, {name: b}]\n' },
  ]);
  assert.deepEqual(p.assets.find((a) => a.id === 'model.view').uses['model.base'], ['a', 'b']);
});

test('parseDbtProject reports broken YAML instead of throwing', () => {
  const p = parseDbtProject([{ path: 'models/bad.yml', text: 'models: [unclosed' }]);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /models\/bad\.yml/);
});

test('downstream follows column usage, then everything built on it', () => {
  const col = downstream(index, 'model.orders', 'discount_amount');
  assert.deepEqual(ids(col.direct), ['model.fct_revenue']);
  assert.deepEqual(col.indirect, []);
  assert.deepEqual(ids(col.exposures), ['exposure.churn_model', 'exposure.finance_close_export', 'exposure.revenue_dashboard']);
  const whole = downstream(index, 'model.stg_payments');
  assert.deepEqual(ids(whole.direct), ['model.orders']);
  assert.deepEqual(ids(whole.indirect), ['model.customers', 'model.fct_revenue']);
  assert.ok(whole.owners.includes('ML platform'));
});

test('detectChanges pairs each column with its own operation and skips negated ones', () => {
  const changes = detectChanges(
    'DATA-42: Clean up the orders model. Drop discount_amount and rename amount to gross_amount. Do not drop order_id.',
    assets,
  );
  assert.deepEqual(
    changes.map((c) => [c.assetId, c.column, c.op]),
    [
      ['model.orders', 'discount_amount', 'drop'],
      ['model.orders', 'amount', 'rename'],
    ],
  );
  assert.match(changes[0].evidence, /Drop discount_amount/);
});

test('plain-word model names need context, technical names do not', () => {
  assert.deepEqual(detectChanges('Customers say orders are slow; remove the banner.', assets), []);
  assert.deepEqual(detectChanges('Deprecate stg_customers next quarter.', assets).map((c) => [c.assetId, c.column, c.op]), [['model.stg_customers', null, 'drop']]);
  assert.deepEqual(detectChanges('Cast `orders`.status to an enum.', assets).map((c) => [c.column, c.op]), [['status', 'type']]);
});

test('assessChanges ranks contract breaks first and explains what to do', () => {
  const assessed = assessChanges(detectChanges('In fct_revenue, exclude refunds. Rename orders.amount to gross_amount.', assets), index);
  assert.deepEqual(assessed.map((c) => [c.assetId, c.op, c.severity]), [
    ['model.orders', 'rename', 'blocking'],
    ['model.fct_revenue', 'logic', 'risky'],
  ]);
  const text = impactText(assessed, index);
  assert.match(text, /\[BLOCKING\] rename orders\.amount/);
  assert.match(text, /Breaks directly: customers \(Growth analytics\), reads amount; fct_revenue/);
  assert.match(text, /new model version/);
  assert.match(text, /\[RISKY\] change the logic of fct_revenue/);
});

test('changes nothing reads are safe', () => {
  const [c] = assessChanges(detectChanges('Rename stg_customers.email to email_address.', assets), index);
  assert.equal(c.severity, 'safe');
});

test('receipts validate input and track which affected owners were told', () => {
  assert.throws(() => normalizeReceipt({ issueKey: 'nope', summary: 's' }, { id: 'r', now: NOW }), /work item key/);
  assert.throws(() => normalizeReceipt({ issueKey: 'DATA-1', summary: 's', prUrl: 'javascript:x' }, { id: 'r', now: NOW }), /http/);
  const r = normalizeReceipt({ issueKey: 'data-42', summary: 'Added orders v2', notified: 'Finance analytics, ML platform', agent: 'Claude Code', prUrl: 'https://github.com/acme/jaffle/pull/7' }, { id: 'r1', now: NOW });
  assert.equal(r.issueKey, 'DATA-42');
  const assessed = assessChanges(detectChanges('Drop orders.discount_amount', assets), index);
  assert.deepEqual(unnotifiedOwners(assessed, [r]), ['Finance operations']);
  const adf = receiptAdf(r, ['Finance operations']);
  assert.match(JSON.stringify(adf), /"href":"https:\/\/github.com\/acme\/jaffle\/pull\/7"/);
  assert.match(adfToText(adf), /not notified yet: Finance operations/);
});

test('impactAdf summarises every change for a Jira comment', () => {
  const assessed = assessChanges(detectChanges('Drop orders.discount_amount', assets), index);
  assert.match(adfToText(impactAdf(assessed, index)), /BLOCKING: drop orders\.discount_amount\. Breaks fct_revenue\./);
});

test('searchAssets and findAsset look up by name, owner and column', () => {
  assert.equal(findAsset(assets, 'raw.orders').id, 'source.raw.orders');
  assert.equal(findAsset(assets, 'model.orders').id, 'model.orders');
  assert.equal(findAsset(assets, 'nope'), null);
  assert.equal(searchAssets(assets, 'orders')[0].id, 'model.orders');
  assert.ok(searchAssets(assets, 'ML platform').some((a) => a.id === 'exposure.churn_model'));
  assert.ok(searchAssets(assets, 'discount_amount').some((a) => a.id === 'model.orders'));
});

test('assetText describes an asset with its neighbours', () => {
  const t = assetText(get('model.orders'), index);
  assert.match(t, /^orders \(dbt model\), owned by Finance analytics, contract enforced/);
  assert.match(t, /Reads from: stg_orders, stg_payments/);
  assert.match(t, /Used by: customers, fct_revenue, Churn prediction model, Monthly finance close export/);
});

test('issueKeyOf prefers an explicit key and falls back to the viewed work item', () => {
  assert.equal(issueKeyOf({ issueKey: 'data-9', context: { jira: { issueKey: 'DATA-1' } } }), 'DATA-9');
  assert.equal(issueKeyOf({ issueKey: 'this one', context: { jira: { issueKey: 'DATA-1' } } }), 'DATA-1');
  assert.equal(issueKeyOf({ issueKey: 'nonsense' }), 'NONSENSE');
});
