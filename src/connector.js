// Teamwork Graph connector: imports a dbt project (models, sources, exposures, owners,
// contracts and lineage) from a GitHub repository into Downstream and the Teamwork
// Graph, so Rovo Search, Rovo Chat and every agent can see what feeds what.
import { fetch } from '@forge/api';
import { graph } from '@forge/teamwork-graph';
import { assetText, indexAssets, issueKeysIn } from './core.js';
import { createService } from './service.js';
import { connections, store } from './store.js';

const GITHUB = 'https://api.github.com';
// Public files come from raw.githubusercontent.com: unauthenticated REST calls share a small
// per-IP quota, and Forge egress IPs are shared, so a sync spends one API call (the tree).
const RAW = 'https://raw.githubusercontent.com';
const MAX_FILES = 300; // keeps a sync inside the 55 s function budget

export function repoParts(value) {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(value ?? '').trim());
  if (!m) throw new Error('Repository must look like owner/name or https://github.com/owner/name.');
  return { owner: m[1], repo: m[2] };
}

const encodePath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

async function github(http, path, token, raw = false) {
  const headers = {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'User-Agent': 'downstream-forge-app',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await http(`${GITHUB}${path}`, { headers });
  if (!res.ok) {
    const limited = res.status === 429 || (res.status === 403 && res.headers?.get?.('x-ratelimit-remaining') === '0');
    throw new Error(limited ? 'GitHub rate limit reached. Add a read-only token to the connection, or try again in an hour.' : `GitHub returned ${res.status} for ${path.split('?')[0]}.`);
  }
  return raw ? res.text() : res.json();
}

async function rawFile(http, url) {
  const res = await http(url, { headers: { 'User-Agent': 'downstream-forge-app' } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${new URL(url).pathname}.`);
  return res.text();
}

// One request: the dbt files under the configured project folder.
export async function listProjectFiles(config, http = fetch) {
  const { owner, repo } = repoParts(config.repository);
  const branch = config.branch || 'main';
  const root = String(config.path ?? '').replace(/^\/+|\/+$/g, '');
  const prefix = root ? `${root}/` : '';
  const tree = await github(http, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, config.token);
  const files = (tree.tree ?? [])
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path.slice(prefix.length), full: e.path }))
    .filter((f) => f.path === 'dbt_project.yml' || /^(models|snapshots)\/.+\.(sql|ya?ml)$/i.test(f.path))
    .slice(0, MAX_FILES);
  if (!files.some((f) => f.path === 'dbt_project.yml')) throw new Error(`No dbt_project.yml was found in ${root || 'the repository root'}.`);
  return { owner, repo, branch, files };
}

export async function fetchProject(config, http = fetch) {
  const { owner, repo, branch, files } = await listProjectFiles(config, http);
  const ref = encodeURIComponent(branch);
  // Private repositories need the token, so they keep using the contents API.
  const read = (f) =>
    config.token
      ? github(http, `/repos/${owner}/${repo}/contents/${encodePath(f.full)}?ref=${ref}`, config.token, true)
      : rawFile(http, `${RAW}/${owner}/${repo}/refs/heads/${encodePath(branch)}/${encodePath(f.full)}`);
  const out = [];
  for (let i = 0; i < files.length; i += 10) {
    const batch = files.slice(i, i + 10);
    const texts = await Promise.all(batch.map(read));
    batch.forEach((f, j) => out.push({ path: f.path, text: texts[j], url: `https://github.com/${owner}/${repo}/blob/${ref}/${encodePath(f.full)}` }));
  }
  return { files: out, source: `GitHub ${owner}/${repo}${config.path ? `/${config.path}` : ''} (${branch})` };
}

// Models and sources become documents linked to what they read from; dashboards become
// dashboards. Work item keys in descriptions link the asset to Jira.
export function graphObject(a, index, { project, syncedAt }, { withAssociations = true } = {}) {
  const dashboard = a.type === 'exposure' && a.kind === 'dashboard';
  const object = {
    schemaVersion: dashboard ? '2.0' : '1.0', // the graph only accepts dashboards at 2.0
    id: a.id,
    updateSequenceNumber: Date.parse(syncedAt) || Date.now(),
    displayName: a.type === 'exposure' ? a.name : `${a.name} (dbt ${a.type})`,
    description: (a.description || `dbt ${a.type} in ${project}`).slice(0, 250),
    url: a.exposureUrl || a.url,
    createdAt: syncedAt,
    lastUpdatedAt: syncedAt,
    permissions: [{ accessControls: [{ principals: [{ type: 'ATLASSIAN_WORKSPACE' }] }] }],
  };
  if (dashboard) {
    object['atlassian:dashboard'] = {
      description: assetText(a, index),
      elements: a.dependsOn.map((d) => ({ name: index.byId.get(d)?.name ?? d })),
      workspaceName: project,
    };
  } else {
    object['atlassian:document'] = {
      type: { category: 'CODE', mimeType: a.type === 'model' ? 'text/x-sql' : 'text/yaml' },
      content: { mimeType: 'text/plain', text: assetText(a, index) },
      labels: ['dbt', a.type, ...(a.contract ? ['contract'] : [])],
    };
  }
  const set = [];
  const keys = issueKeysIn(a.description);
  if (keys.length) set.push({ associationType: 'issueIdOrKeys', values: keys });
  const ups = a.dependsOn.filter((d) => index.byId.get(d)?.url);
  if (ups.length && object['atlassian:document']) set.push({ associationType: 'atlassian:document', values: ups.map((entityId) => ({ entityId })) });
  if (withAssociations && set.length) object.associations = { lastUpdatedAt: syncedAt, set };
  return object;
}

// Objects rejected with associations are retried once without them, since not every
// object type accepts every link.
export async function pushToGraph(connectionId, assets, meta, g = graph) {
  const index = indexAssets(assets);
  const linkable = assets.filter((a) => /^https?:\/\//.test(a.exposureUrl || a.url || ''));
  let accepted = 0;
  const rejected = [];
  for (let i = 0; i < linkable.length; i += 100) {
    const batch = linkable.slice(i, i + 100);
    let res;
    try {
      res = await g.setObjects({ connectionId, objects: batch.map((a) => graphObject(a, index, meta)) });
    } catch (e) {
      // The SDK throws when any object in the batch is invalid; push one by one so the rest still land.
      console.error('[downstream] Teamwork Graph batch failed, retrying objects one by one', e.message);
      for (const a of batch) {
        try {
          const one = await g.setObjects({ connectionId, objects: [graphObject(a, index, meta, { withAssociations: false })] });
          if (one.results?.accepted?.length ?? one.success) accepted += 1;
          else rejected.push({ key: { entityId: a.id } });
        } catch (err) {
          rejected.push({ key: { entityId: a.id }, error: err.message });
        }
      }
      continue;
    }
    const bad = res.results?.rejected ?? [];
    if (!res.success && !bad.length) throw new Error(`Teamwork Graph ingestion failed: ${res.error ?? 'unknown error'}`);
    accepted += res.results?.accepted?.length ?? batch.length - bad.length;
    const retry = batch.filter((a) => bad.some((r) => r.key?.entityId === a.id) && graphObject(a, index, meta).associations);
    if (retry.length) {
      const again = await g.setObjects({ connectionId, objects: retry.map((a) => graphObject(a, index, meta, { withAssociations: false })) });
      accepted += again.results?.accepted?.length ?? 0;
      rejected.push(...(again.results?.rejected ?? []));
    }
    rejected.push(...bad.filter((r) => !retry.some((a) => a.id === r.key?.entityId)));
  }
  if (rejected.length) console.error('[downstream] Teamwork Graph rejected objects', JSON.stringify(rejected));
  return { accepted, rejected: rejected.length, skipped: assets.length - linkable.length };
}

export async function syncConnection(connectionId, config, deps = {}) {
  const { http = fetch, g = graph, service = createService({ store, jira: null }) } = deps;
  const { files, source } = await fetchProject(config, http);
  const imported = await service.importProject(files, { source, connectionId });
  const pushed = await pushToGraph(connectionId, imported.list, imported, g);
  console.log(`[downstream] connection ${connectionId}: ${imported.assets} assets from ${source}`, JSON.stringify(pushed));
  return { assets: imported.assets, errors: imported.errors.length, ...pushed };
}

// graph:connector datasource handlers. Forge passes the request object directly.
export async function onConnectionChange(request) {
  const { action, connectionId, configProperties } = request ?? {};
  if (!connectionId) return { success: false, message: 'Missing connection id.' };
  try {
    if (action === 'DELETED') {
      await connections.remove(connectionId); // Atlassian deletes the graph data itself
      return { success: true };
    }
    await connections.add(connectionId, configProperties);
    const result = await syncConnection(connectionId, configProperties);
    return { success: true, message: `Imported ${result.assets} dbt models, sources and exposures.` };
  } catch (e) {
    console.error('[downstream] onConnectionChange failed', e);
    return { success: false, message: e.message };
  }
}

// Also used by Atlassian for periodic health checks: read-only, one request, and never
// echoes credentials or raw provider errors back to the admin. Forge passes a context as the
// second argument, so the injectable check lives in its own function.
export const validateConnection = (request) => checkConnection(request?.configProperties ?? {});

export async function checkConnection(config, http = fetch) {
  try {
    repoParts(config.repository);
  } catch (e) {
    return { success: false, message: e.message };
  }
  try {
    const { files } = await listProjectFiles(config, http);
    return { success: true, message: `Found a dbt project with ${files.length} model and config files.` };
  } catch (e) {
    console.error('[downstream] validateConnection failed', e.message);
    return /dbt_project|rate limit/.test(e.message)
      ? { success: false, message: e.message }
      : { success: false, message: 'Could not read that repository. Check the repository, branch, folder and token.' };
  }
}

// Daily re-sync so changes merged to the dbt project reach Jira and Rovo without reconnecting.
export async function resyncAll() {
  for (const connectionId of await connections.list()) {
    try {
      const config = await connections.config(connectionId);
      if (config) await syncConnection(connectionId, config);
    } catch (e) {
      console.error(`[downstream] resync failed for ${connectionId}`, e);
    }
  }
}
