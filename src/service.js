// Use cases behind every Downstream surface: Rovo actions, MCP tools, the issue panel,
// the catalog page, the issue trigger and the dbt connector. Storage and Jira are
// injected so the tests run without Forge.
import {
  adviceFor,
  assessChanges,
  assetText,
  describeChange,
  detectChanges,
  downstream,
  findAsset,
  impactAdf,
  impactText,
  indexAssets,
  normalizeReceipt,
  parseDbtProject,
  plainAdf,
  receiptAdf,
  searchAssets,
  unnotifiedOwners,
} from './core.js';
import { DEMO_ISSUE, sampleFiles } from './demo.js';

const issueText = (issue) => `${issue.summary}\n${issue.description}`;
const TYPE_ORDER = { model: 0, source: 1, exposure: 2 };
const changeKey = (c) => `${c.assetId}|${c.column ?? ''}|${c.op}`;

export function createService({ store, jira, now = () => new Date().toISOString(), newId = () => crypto.randomUUID() }) {
  async function catalog() {
    const assets = await store.listAssets();
    if (!assets.length) throw new Error('No dbt project is connected yet. Load the sample project or connect a repository first.');
    return { assets, index: indexAssets(assets) };
  }

  async function ticket(issueKey) {
    if (!issueKey) throw new Error('Tell me which work item, for example DATA-42.');
    const [issue, { assets, index }, receipts] = await Promise.all([jira.getIssue(issueKey), catalog(), store.receipts(issueKey)]);
    receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { issue, assets, index, receipts, assessed: assessChanges(detectChanges(issueText(issue), assets), index) };
  }

  function resolve(assets, name) {
    const asset = findAsset(assets, name);
    if (asset) return asset;
    const near = searchAssets(assets, name, 5).map((a) => a.name);
    throw new Error(`No dbt model, source or exposure is called "${name}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
  }

  async function importProject(files, meta) {
    const { project, assets, errors } = parseDbtProject(files);
    if (!assets.length) throw new Error('No dbt models were found. Point Downstream at the folder that contains dbt_project.yml.');
    await store.replaceAssets(assets);
    const info = { project, ...meta, assets: assets.length, errors: errors.slice(0, 20), syncedAt: now() };
    await store.putMeta(info);
    return { ...info, list: assets };
  }

  return {
    importProject,

    async ticketImpact(issueKey) {
      const { issue, index, receipts, assessed } = await ticket(issueKey);
      const unnotified = unnotifiedOwners(assessed, receipts);
      return [
        `# Downstream impact of ${issue.key}: ${issue.summary}`,
        impactText(assessed, index),
        receipts.length ? `\nChange receipts: ${receipts.map((r) => `${r.createdAt.slice(0, 10)} ${r.agent}: ${r.summary}`).join(' | ')}` : '',
        unnotified.length ? `\nAffected owners no receipt mentions yet: ${unnotified.join(', ')}` : '',
        '\nBefore editing SQL, call check-change with your plan. When done, call submit-change-receipt listing the owners you notified.',
      ]
        .filter(Boolean)
        .join('\n');
    },

    async checkChange(plan, issueKey) {
      if (!String(plan ?? '').trim()) throw new Error('Pass the change you plan to make, naming the models and columns.');
      const { assets, index } = await catalog();
      // The work item can name the model while the plan only names columns.
      const context = issueKey ? issueText(await jira.getIssue(issueKey)) : '';
      const assessed = assessChanges(detectChanges(plan, assets, { context }), index);
      const blockers = assessed.filter((c) => c.severity === 'blocking' || c.severity === 'breaking');
      const head = !assessed.length
        ? '✅ The plan does not change any known model, source or column.'
        : blockers.length
          ? `❌ The plan breaks ${blockers.length} thing(s) downstream. Revise it before editing SQL:`
          : '✅ Nothing downstream breaks. Mind the notes below.';
      return {
        ok: blockers.length === 0,
        changes: assessed.map((c) => ({
          asset: c.asset.name,
          column: c.column,
          op: c.op,
          severity: c.severity,
          breaks: c.impact.direct.map((d) => index.byId.get(d.id).name),
          consumers: c.impact.exposures.map((d) => index.byId.get(d.id).name),
          owners: c.impact.owners,
        })),
        summary: assessed.length ? `${head}\n${impactText(assessed, index)}` : head,
      };
    },

    async impactOf(name, column) {
      const { assets, index } = await catalog();
      const asset = resolve(assets, name);
      const col = String(column ?? '').trim();
      if (col && !asset.columns.some((c) => c.name.toLowerCase() === col.toLowerCase())) {
        throw new Error(`${asset.name} has no documented column "${col}". Columns: ${asset.columns.map((c) => c.name).join(', ') || 'none documented'}.`);
      }
      const impact = downstream(index, asset.id, col || null);
      const n = (id) => index.byId.get(id)?.name ?? id;
      return [
        `Changing ${col ? `${asset.name}.${col}` : asset.name}${asset.contract ? ' (contract enforced)' : ''} affects:`,
        `- Directly: ${impact.direct.map((d) => `${n(d.id)} (${d.via})`).join(', ') || 'nothing'}`,
        `- Further downstream: ${impact.indirect.map((d) => n(d.id)).join(', ') || 'nothing'}`,
        `- Dashboards and other consumers: ${impact.exposures.map((d) => n(d.id)).join(', ') || 'none'}`,
        `- Owners: ${impact.owners.join(', ') || 'none recorded'}`,
      ].join('\n');
    },

    async describeAsset(name) {
      const { assets, index } = await catalog();
      return assetText(resolve(assets, name), index);
    },

    async findAssets(query) {
      const { assets, index } = await catalog();
      const found = searchAssets(assets, query);
      return found.length ? found.map((a) => assetText(a, index)).join('\n\n') : `Nothing matches "${query}".`;
    },

    async submitReceipt(input) {
      const { issue, receipts, assessed } = await ticket(input.issueKey);
      const receipt = normalizeReceipt({ ...input, issueKey: issue.key }, { id: newId(), now: now() });
      await store.addReceipt(receipt);
      const unnotified = unnotifiedOwners(assessed, [...receipts, receipt]);
      await jira.addComment(issue.key, receiptAdf(receipt, unnotified));
      return {
        receipt,
        unnotified,
        summary: unnotified.length
          ? `Receipt posted to ${issue.key}. Affected owners not notified yet: ${unnotified.join(', ')}.`
          : `Receipt posted to ${issue.key}; every affected owner is covered.`,
      };
    },

    // Issue trigger: one comment per newly detected risky change, never repeated.
    async scanIssue(issueKey) {
      if (!(await store.listAssets()).length) return { notified: [] };
      const { index, assessed } = await ticket(issueKey);
      const previous = (await store.getScan(issueKey)) ?? { notified: [] };
      const fresh = assessed.filter((c) => c.severity !== 'safe' && !previous.notified.includes(changeKey(c)));
      if (fresh.length) await jira.addComment(issueKey, impactAdf(fresh, index));
      await store.putScan(issueKey, { notified: [...previous.notified, ...fresh.map(changeKey)], scannedAt: now() });
      return { notified: fresh.map(changeKey) };
    },

    async panel(issueKey) {
      const { issue, index, receipts, assessed } = await ticket(issueKey);
      const named = (xs) => xs.map((x) => ({ ...x, name: index.byId.get(x.id)?.name, owner: index.byId.get(x.id)?.owner ?? '' }));
      return {
        issueKey: issue.key,
        changes: assessed.map((c) => ({
          key: changeKey(c),
          asset: { name: c.asset.name, type: c.asset.type, owner: c.asset.owner, contract: c.asset.contract, url: c.asset.url },
          column: c.column,
          op: c.op,
          severity: c.severity,
          summary: describeChange(c),
          advice: adviceFor(c),
          evidence: c.evidence,
          direct: named(c.impact.direct),
          indirect: named(c.impact.indirect),
          exposures: named(c.impact.exposures),
          owners: c.impact.owners,
        })),
        receipts: receipts.slice(0, 5),
        unnotified: unnotifiedOwners(assessed, receipts),
      };
    },

    async listAssets() {
      const [assets, meta] = await Promise.all([store.listAssets(), store.getMeta()]);
      const index = indexAssets(assets);
      const rows = assets
        .map((a) => ({ ...a, usedBy: (index.children.get(a.id) ?? []).length }))
        .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.name.localeCompare(b.name));
      return { meta: meta ?? null, assets: rows };
    },

    loadSample() {
      return importProject(sampleFiles(), { source: 'Built-in sample (jaffle shop)' });
    },

    projects() {
      return jira.listProjects();
    },

    // The demo work item, so a new install shows impact without typing anything.
    async createDemoIssue(projectKey) {
      const key = String(projectKey ?? '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(key)) throw new Error('Pick a Jira project for the demo work item.');
      return { issueKey: await jira.createIssue(key, DEMO_ISSUE.summary, plainAdf(DEMO_ISSUE.description)) };
    },
  };
}
