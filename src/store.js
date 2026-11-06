// Forge KVS persistence. The dbt catalog is stored in pages of 100 assets
// (catalog:page:<n>) so a sync is a handful of writes, plus catalog:meta.
// Also receipt:<issueKey>:<id>, scan:<issueKey>, conn:list and the secret conn:<connectionId>.
import { kvs, WhereConditions } from '@forge/kvs';

const PAGE = 100;

async function all(prefix) {
  const out = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export const store = {
  async listAssets() {
    const meta = await kvs.get('catalog:meta');
    const pages = await Promise.all(Array.from({ length: meta?.pages ?? 0 }, (_, i) => kvs.get(`catalog:page:${i}`)));
    return pages.flatMap((p) => p ?? []);
  },
  async replaceAssets(assets) {
    const previous = (await kvs.get('catalog:meta'))?.pages ?? 0;
    const pages = Math.ceil(assets.length / PAGE);
    await Promise.all(Array.from({ length: pages }, (_, i) => kvs.set(`catalog:page:${i}`, assets.slice(i * PAGE, (i + 1) * PAGE))));
    await Promise.all(Array.from({ length: Math.max(0, previous - pages) }, (_, i) => kvs.delete(`catalog:page:${pages + i}`)));
  },
  async getMeta() {
    return kvs.get('catalog:meta');
  },
  async putMeta(meta) {
    await kvs.set('catalog:meta', { ...meta, pages: Math.ceil(meta.assets / PAGE) });
  },
  receipts: (issueKey) => all(`receipt:${issueKey}:`),
  addReceipt: (r) => kvs.set(`receipt:${r.issueKey}:${r.id}`, r),
  getScan: (issueKey) => kvs.get(`scan:${issueKey}`),
  putScan: (issueKey, scan) => kvs.set(`scan:${issueKey}`, scan),
};

// Teamwork Graph connections and their admin-supplied settings (the token is secret).
export const connections = {
  async list() {
    return (await kvs.get('conn:list')) ?? [];
  },
  async add(connectionId, config) {
    await kvs.setSecret(`conn:${connectionId}`, config);
    const ids = await this.list();
    if (!ids.includes(connectionId)) await kvs.set('conn:list', [...ids, connectionId]);
  },
  async remove(connectionId) {
    await kvs.deleteSecret(`conn:${connectionId}`);
    await kvs.set('conn:list', (await this.list()).filter((id) => id !== connectionId));
  },
  config: (connectionId) => kvs.getSecret(`conn:${connectionId}`),
};
