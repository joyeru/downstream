import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProject, graphObject, pushToGraph, repoParts, syncConnection, checkConnection } from '../src/connector.js';
import { indexAssets, parseDbtProject } from '../src/core.js';
import { SAMPLE_PROJECT } from '../src/demo.js';
import { createService } from '../src/service.js';

// Minimal GitHub git-trees and contents API double serving the sample under examples/jaffle_shop.
function github(files, root = 'examples/jaffle_shop') {
  const full = Object.fromEntries(Object.entries(files).map(([p, t]) => [`${root}/${p}`, t]));
  full['README.md'] = '# repo';
  const calls = [];
  const http = async (url, { headers }) => {
    calls.push({ url, headers });
    const { host, pathname } = new URL(url);
    if (pathname.startsWith('/repos/acme/data/git/trees/')) {
      return { ok: true, json: async () => ({ tree: Object.keys(full).map((path) => ({ path, type: 'blob' })) }) };
    }
    const prefix = host === 'raw.githubusercontent.com' ? '/acme/data/refs/heads/main/' : '/repos/acme/data/contents/';
    const path = decodeURIComponent(pathname.replace(prefix, ''));
    return full[path] !== undefined ? { ok: true, text: async () => full[path] } : { ok: false, status: 404 };
  };
  return { http, calls };
}

const CONFIG = { repository: 'acme/data', path: 'examples/jaffle_shop', token: 'tok' };

test('examples/jaffle_shop on disk matches the built-in sample', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const [path, text] of Object.entries(SAMPLE_PROJECT)) {
    assert.equal(await readFile(new URL(`../examples/jaffle_shop/${path}`, import.meta.url), 'utf8'), text, path);
  }
});

test('repoParts accepts owner/name and GitHub URLs only', () => {
  assert.deepEqual(repoParts('https://github.com/acme/data.git'), { owner: 'acme', repo: 'data' });
  assert.throws(() => repoParts('https://evil.example.com/x/y'), /owner\/name/);
  assert.throws(() => repoParts('acme/data/../../x'), /owner\/name/);
});

test('fetchProject reads only the dbt files under the project folder', async () => {
  const { http, calls } = github(SAMPLE_PROJECT);
  const { files, source } = await fetchProject(CONFIG, http);
  assert.equal(files.length, Object.keys(SAMPLE_PROJECT).length);
  assert.ok(files.every((f) => !f.path.startsWith('examples/')));
  assert.equal(files.find((f) => f.path === 'models/marts/orders.sql').url, 'https://github.com/acme/data/blob/main/examples/jaffle_shop/models/marts/orders.sql');
  assert.equal(source, 'GitHub acme/data/examples/jaffle_shop (main)');
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer tok' && c.url.startsWith('https://api.github.com/')));
});

test('public repositories cost one API call; file contents come from raw.githubusercontent.com', async () => {
  const { http, calls } = github(SAMPLE_PROJECT);
  const { files } = await fetchProject({ ...CONFIG, token: '' }, http);
  assert.equal(files.length, Object.keys(SAMPLE_PROJECT).length);
  assert.equal(calls.filter((c) => c.url.startsWith('https://api.github.com/')).length, 1);
  assert.ok(calls.every((c) => !c.headers.Authorization));
});

test('a GitHub rate limit is explained to the admin', async () => {
  const limited = async () => ({ ok: false, status: 403, headers: new Headers({ 'x-ratelimit-remaining': '0' }) });
  const res = await checkConnection(CONFIG, limited);
  assert.equal(res.success, false);
  assert.match(res.message, /rate limit/);
});

test('checkConnection makes one request, needs dbt_project.yml and hides provider errors', async () => {
  const { http, calls } = github(SAMPLE_PROJECT);
  const ok = await checkConnection(CONFIG, http);
  assert.equal(ok.success, true);
  assert.equal(calls.length, 1);
  assert.match((await checkConnection({ ...CONFIG, path: 'nowhere' }, http)).message, /No dbt_project\.yml/);
  const failing = async () => ({ ok: false, status: 401 });
  const res = await checkConnection({ ...CONFIG, token: 'secret-token' }, failing);
  assert.equal(res.success, false);
  assert.doesNotMatch(res.message, /401|secret-token/);
});

test('graphObject maps models to linked documents and dashboards to dashboards', () => {
  const files = Object.entries(SAMPLE_PROJECT).map(([path, text]) => ({ path, text, url: `https://github.com/acme/data/blob/main/${path}` }));
  const { assets } = parseDbtProject(files);
  const index = indexAssets(assets);
  const meta = { project: 'jaffle_shop', syncedAt: '2026-11-05T00:00:00.000Z' };
  const orders = graphObject(index.byId.get('model.orders'), index, meta);
  assert.equal(orders.displayName, 'orders (dbt model)');
  assert.deepEqual(orders['atlassian:document'].labels, ['dbt', 'model', 'contract']);
  assert.deepEqual(orders.associations.set, [{ associationType: 'atlassian:document', values: [{ entityId: 'model.stg_orders' }, { entityId: 'model.stg_payments' }] }]);
  const dash = graphObject(index.byId.get('exposure.revenue_dashboard'), index, meta);
  assert.equal(dash.url, 'https://example.com/dashboards/revenue');
  assert.deepEqual(dash['atlassian:dashboard'].elements, [{ name: 'fct_revenue' }]);
  assert.equal(graphObject(index.byId.get('model.orders'), index, meta, { withAssociations: false }).associations, undefined);
});

test('pushToGraph retries objects rejected for their associations and skips unlinkable ones', async () => {
  const sent = [];
  const g = {
    setObjects: async ({ objects }) => {
      sent.push(objects);
      return {
        success: true,
        results: {
          accepted: objects.filter((o) => !o.associations).map((o) => ({ entityId: o.id })),
          rejected: objects.filter((o) => o.associations).map((o) => ({ key: { entityId: o.id }, errors: [{ message: 'associations not supported' }] })),
        },
      };
    },
  };
  const files = Object.entries(SAMPLE_PROJECT).map(([path, text]) => ({ path, text, url: path === 'models/staging/stg_orders.sql' ? '' : `https://g/${path}` }));
  const { assets } = parseDbtProject(files);
  const res = await pushToGraph('conn-1', assets, { project: 'p', syncedAt: '2026-11-05T00:00:00.000Z' }, g);
  assert.deepEqual(res, { accepted: 11, rejected: 0, skipped: 1 });
  assert.equal(sent.length, 2);
  assert.ok(sent[1].every((o) => !o.associations));
});

test('syncConnection imports the project into the catalog and the graph', async () => {
  const kv = new Map();
  const store = {
    listAssets: async () => kv.get('assets') ?? [],
    replaceAssets: async (a) => void kv.set('assets', a),
    putMeta: async (m) => void kv.set('meta', m),
  };
  const service = createService({ store, jira: null, now: () => '2026-11-05T00:00:00.000Z' });
  const { http } = github(SAMPLE_PROJECT);
  const g = { setObjects: async ({ objects }) => ({ success: true, results: { accepted: objects.map((o) => ({ entityId: o.id })) } }) };
  const res = await syncConnection('conn-1', CONFIG, { http, g, service });
  assert.deepEqual(res, { assets: 12, errors: 0, accepted: 12, rejected: 0, skipped: 0 });
  assert.equal(kv.get('meta').source, 'GitHub acme/data/examples/jaffle_shop (main)');
});
