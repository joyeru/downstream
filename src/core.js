// Downstream core: pure lineage logic shared by the Rovo actions, MCP tools, the issue
// panel, the issue trigger and the Teamwork Graph connector. No Forge imports, so
// `node --test` exercises it directly.
import { parse as parseYaml } from 'yaml';

export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const BREAKING = new Set(['drop', 'rename', 'type']);
// An operation preceded by one of these is not planned: "do not drop", "without renaming".
const NEGATORS = ['not', 'no', 'never', 'without', "don't", 'do not', 'avoid', 'instead of', 'rather than', 'keep', 'keeping'];
const NEGATOR_RES = NEGATORS.map((n) => new RegExp(`(^|[^a-z'])${esc(n)}([^a-z]|$)`));
const OPS = [
  ['drop', /\b(drop|drops|dropping|dropped|remove|removes|removing|removed|delete|deleting|deleted|deprecate|deprecating|retire|retiring)\b/i],
  ['rename', /\b(rename|renames|renaming|renamed)\b/i],
  ['type', /\b(cast|casting|retype|change (?:the |its )?(?:data )?type|type change|alter (?:the )?column|convert(?:ing)?\s+\w+\s+to|from (?:int|integer|bigint|string|varchar|text|float|decimal|numeric|date|timestamp)\s+to)\b/i],
  ['logic', /\b(change (?:the )?grain|filter out|exclude|excluding|dedupe|deduplicate|redefine|change (?:the )?(?:logic|definition|calculation))\b/i],
];

const lc = (s) => String(s ?? '').trim().toLowerCase();
const clean = (s, max = 2000) => String(s ?? '').trim().slice(0, max);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const v = String(item ?? '').trim();
    if (v && !seen.has(lc(v))) {
      seen.add(lc(v));
      out.push(v);
    }
  }
  return out;
}

const wordRe = (term) => new RegExp(`(?<![A-Za-z0-9_])${esc(term)}(?![A-Za-z0-9_])`, 'gi');

function snippet(text, index, len) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + len + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

// --- dbt project parsing --------------------------------------------------------------

const REF_RE = /\bref\(\s*(['"])([\w.-]+)\1(?:\s*,\s*(['"])([\w.-]+)\3)?[^)]*\)/g;
const SOURCE_RE = /\bsource\(\s*(['"])([\w.-]+)\1\s*,\s*(['"])([\w.-]+)\3\s*\)/g;

export function sqlDependencies(sql) {
  const deps = [];
  for (const m of String(sql).matchAll(REF_RE)) deps.push(`model.${m[4] ?? m[2]}`);
  for (const m of String(sql).matchAll(SOURCE_RE)) deps.push(`source.${m[2]}.${m[4]}`);
  return uniq(deps);
}

// A model whose final statement is `select * from ...` passes every upstream column through.
const passesThrough = (sql) => /select\s+\*\s+from\s+[^;]*$/i.test(String(sql).split(/\bselect\b/i).slice(-1).map((s) => `select${s}`)[0]);

function ownerOf(node, groups) {
  const meta = { ...(node?.meta ?? {}), ...(node?.config?.meta ?? {}) };
  const group = groups[node?.group ?? node?.config?.group];
  return clean(meta.owner?.name ?? meta.owner ?? group?.name ?? node?.owner?.name ?? '', 120);
}

const columnsOf = (node) =>
  (node?.columns ?? []).filter((c) => c?.name).map((c) => ({ name: String(c.name), description: clean(c.description, 300), dataType: clean(c.data_type, 40) }));

function dependsOnList(values) {
  return uniq(
    (values ?? []).flatMap((v) => {
      const s = String(v);
      const ref = /ref\(\s*['"]([\w.-]+)['"](?:\s*,\s*['"]([\w.-]+)['"])?/.exec(s);
      if (ref) return [`model.${ref[2] ?? ref[1]}`];
      const src = /source\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w.-]+)['"]/.exec(s);
      return src ? [`source.${src[1]}.${src[2]}`] : [];
    }),
  );
}

// files: [{ path, text, url }] from a dbt project. Returns { project, assets, errors }.
export function parseDbtProject(files) {
  const assets = new Map();
  const errors = [];
  const groups = {};
  const yamls = [];
  let project = 'dbt project';
  for (const f of files) {
    if (/(^|\/)dbt_project\.ya?ml$/.test(f.path)) {
      try {
        project = parseYaml(f.text)?.name ?? project;
      } catch (e) {
        errors.push(`${f.path}: ${e.message}`);
      }
    } else if (/\.ya?ml$/i.test(f.path)) {
      try {
        const doc = parseYaml(f.text) ?? {};
        yamls.push({ f, doc });
        for (const g of doc.groups ?? []) if (g?.name) groups[g.name] = { name: g.owner?.name ?? g.name, email: g.owner?.email ?? '' };
      } catch (e) {
        errors.push(`${f.path}: ${e.message}`);
      }
    } else if (/\.sql$/i.test(f.path) && /(^|\/)(models|snapshots)\//.test(f.path)) {
      const name = f.path.split('/').pop().replace(/\.sql$/i, '');
      assets.set(`model.${name}`, {
        id: `model.${name}`,
        type: 'model',
        name,
        description: '',
        owner: '',
        columns: [],
        contract: false,
        dependsOn: sqlDependencies(f.text),
        passThrough: passesThrough(f.text),
        sql: f.text,
        path: f.path,
        url: f.url ?? '',
      });
    }
  }
  for (const { f, doc } of yamls) {
    for (const m of doc.models ?? []) {
      const a = assets.get(`model.${m?.name}`);
      if (!a) continue;
      a.description = clean(m.description, 600);
      a.owner = ownerOf(m, groups);
      a.columns = columnsOf(m);
      a.contract = Boolean(m.config?.contract?.enforced);
    }
    for (const s of doc.sources ?? []) {
      for (const t of s?.tables ?? []) {
        const id = `source.${s.name}.${t?.name}`;
        assets.set(id, {
          id,
          type: 'source',
          name: `${s.name}.${t.name}`,
          description: clean(t.description ?? s.description, 600),
          owner: ownerOf(t, groups) || ownerOf(s, groups),
          columns: columnsOf(t),
          contract: false,
          dependsOn: [],
          path: f.path,
          url: f.url ?? '',
        });
      }
    }
    for (const e of doc.exposures ?? []) {
      if (!e?.name) continue;
      assets.set(`exposure.${e.name}`, {
        id: `exposure.${e.name}`,
        type: 'exposure',
        name: e.label ?? e.name,
        kind: clean(e.type, 40) || 'dashboard',
        description: clean(e.description, 600),
        owner: clean(e.owner?.name ?? '', 120),
        ownerEmail: clean(e.owner?.email ?? '', 120),
        columns: [],
        contract: false,
        dependsOn: dependsOnList(e.depends_on),
        exposureUrl: /^https?:\/\//.test(e.url ?? '') ? e.url : '',
        path: f.path,
        url: f.url ?? '',
      });
    }
  }
  // Column usage: which upstream columns each model reads (by name, or all when it passes through).
  for (const a of assets.values()) {
    if (a.type !== 'model') continue;
    a.uses = {};
    for (const dep of a.dependsOn) {
      const up = assets.get(dep);
      if (!up?.columns?.length) continue;
      a.uses[dep] = a.passThrough ? up.columns.map((c) => c.name) : up.columns.map((c) => c.name).filter((c) => wordRe(c).test(a.sql));
    }
    delete a.sql;
  }
  return { project, assets: [...assets.values()], errors };
}

// --- Impact analysis ------------------------------------------------------------------

export function indexAssets(assets) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const children = new Map();
  for (const a of assets) for (const dep of a.dependsOn ?? []) children.set(dep, [...(children.get(dep) ?? []), a.id]);
  return { byId, children };
}

// What a change to `assetId` (optionally one column) affects downstream.
export function downstream(index, assetId, column = null) {
  const { byId, children } = index;
  const direct = [];
  for (const id of children.get(assetId) ?? []) {
    const child = byId.get(id);
    if (!child || child.type === 'exposure') continue;
    if (!column) direct.push({ id, via: 'depends on it' });
    else if ((child.uses?.[assetId] ?? []).some((c) => lc(c) === lc(column))) direct.push({ id, via: `reads ${column}` });
  }
  const seen = new Set([assetId, ...direct.map((d) => d.id)]);
  const indirect = [];
  const queue = direct.map((d) => d.id);
  while (queue.length) {
    const next = queue.shift();
    for (const id of children.get(next) ?? []) {
      if (seen.has(id) || byId.get(id)?.type === 'exposure') continue;
      seen.add(id);
      indirect.push({ id, via: `depends on ${byId.get(next)?.name ?? next}` });
      queue.push(id);
    }
  }
  const affected = new Set([assetId, ...direct.map((d) => d.id), ...indirect.map((d) => d.id)]);
  const exposures = [...byId.values()]
    .filter((a) => a.type === 'exposure' && a.dependsOn.some((d) => affected.has(d)))
    .map((a) => ({ id: a.id, via: `uses ${a.dependsOn.filter((d) => affected.has(d)).map((d) => byId.get(d)?.name ?? d).join(', ')}` }));
  const owners = uniq([...direct, ...indirect, ...exposures].map((x) => byId.get(x.id)?.owner));
  return { direct, indirect, exposures, owners };
}

function negatedBefore(clause, index) {
  const window = clause.slice(Math.max(0, index - 40), index).toLowerCase().split(/\s+/).slice(-4).join(' ');
  return NEGATOR_RES.some((r) => r.test(window));
}

// Every operation word in a clause, in order, flagged when negated.
function opsIn(clause) {
  const found = [];
  for (const [op, re] of OPS) {
    for (const m of clause.matchAll(new RegExp(re.source, 'gi'))) {
      found.push({ op, index: m.index, negated: negatedBefore(clause, m.index) });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// "drop discount_amount and rename amount": each target takes the closest operation before it.
function nearestOp(ops, index) {
  return ops.filter((o) => o.index <= index).pop() ?? ops.find((o) => o.index > index) ?? null;
}

// Where a clause names an asset. Plain-word names like "orders" only count with context
// ("orders model", "the table orders", `orders`, orders.amount), so prose is not misread.
function mentionIndex(asset, s) {
  if (/[_.]/.test(asset.name)) return s.search(wordRe(asset.name));
  const n = esc(asset.name);
  const re = new RegExp(
    `\`${n}\`|['"]${n}['"]|(?<![A-Za-z0-9_])${n}(?=\\s+(?:model|table|view|dataset)\\b|\\.[A-Za-z_])|\\b(?:model|table|view|dataset)\\s+\`?${n}(?![A-Za-z0-9_])`,
    'i',
  );
  return s.search(re);
}

// "orders_v2", "orders v2", "version 2 of orders": a new model version, which changes nothing
// that already exists. This is the fix Downstream itself recommends for contracted models.
const versionRe = (name) =>
  new RegExp(`(?<![A-Za-z0-9_])${esc(name)}(?:_v|\\s+v|\\s+version\\s*)\\d+(?![A-Za-z0-9_])|\\bversion\\s*\\d+\\s+of\\s+(?:the\\s+)?\`?${esc(name)}(?![A-Za-z0-9_])`, 'gi');

// Changes a work item or plan proposes to known assets: [{ assetId, column, op, evidence }].
// `context` (such as the work item a plan is for) can name the models the text refers to.
export function detectChanges(text, assets, { context = '' } = {}) {
  const source = String(text ?? '');
  const named = assets.filter((a) => a.type !== 'exposure' && mentionIndex(a, `${context}\n${source}`) >= 0);
  const changes = [];
  const add = (c) => {
    if (!changes.some((x) => x.assetId === c.assetId && x.column === c.column && x.op === c.op)) changes.push(c);
  };
  let offset = 0;
  // Sentence ends split clauses; the dot inside orders.amount does not.
  for (const clause of source.split(/(?<=[!?;\n])|(?<=\.)(?=\s|$)/)) {
    const ops = opsIn(clause);
    if (ops.length) {
      // Only a plain mention counts: "drop x from the orders model" does, "orders_v2" does not.
      const inClause = named.filter((a) => mentionIndex(a, clause.replace(versionRe(a.name), ' ')) >= 0);
      const versioned = named.some((a) => versionRe(a.name).test(clause));
      // A clause that names no asset ("then rename amount") refers to the assets named elsewhere,
      // unless it is about a new model version.
      for (const a of inClause.length ? inClause : versioned ? [] : named) {
        let columnHit = false;
        for (const c of a.columns ?? []) {
          for (const m of clause.matchAll(wordRe(c.name))) {
            const op = nearestOp(ops, m.index);
            if (!op || op.negated) continue;
            columnHit = true;
            add({ assetId: a.id, column: c.name, op: op.op, at: offset + m.index, evidence: snippet(source, offset + m.index, c.name.length) });
          }
        }
        const at = mentionIndex(a, clause);
        const op = at >= 0 && !columnHit ? nearestOp(ops, at) : null;
        if (op && !op.negated) add({ assetId: a.id, column: null, op: op.op, at: offset + at, evidence: snippet(source, offset + at, a.name.length) });
      }
    }
    offset += clause.length;
  }
  return changes.sort((x, y) => x.at - y.at);
}

const SEVERITY_RANK = { blocking: 0, breaking: 1, risky: 2, safe: 3 };

export function assessChanges(changes, index) {
  return changes
    .map((change) => {
      const asset = index.byId.get(change.assetId);
      const impact = downstream(index, change.assetId, change.column);
      const breaking = BREAKING.has(change.op);
      const reach = impact.direct.length + impact.indirect.length + impact.exposures.length;
      const severity =
        breaking && asset?.contract ? 'blocking' : breaking && reach ? 'breaking' : change.op === 'logic' && reach ? 'risky' : 'safe';
      return { ...change, asset, impact, severity };
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// --- Renderers ------------------------------------------------------------------------

const label = (index, id) => {
  const a = index.byId.get(id);
  return a ? `${a.name}${a.owner ? ` (${a.owner})` : ''}` : id;
};

export function describeChange(c) {
  const target = c.column ? `${c.asset?.name}.${c.column}` : c.asset?.name;
  const verb = { drop: 'drop', rename: 'rename', type: 'change the type of', logic: 'change the logic of' }[c.op];
  return `${verb} ${target}`;
}

export function adviceFor(c) {
  if (c.severity === 'blocking') {
    return `${c.asset.name} has an enforced dbt contract. Add a new model version (for example ${c.asset.name}_v2 via dbt model versions), keep the current version until consumers migrate, and tell the owners below.`;
  }
  if (c.severity === 'breaking') return 'Update the downstream models in the same change, or keep a compatible column for one release, and notify the owners below.';
  if (c.severity === 'risky') return 'The schema stays the same but numbers will change for the consumers below. Tell their owners before release.';
  return 'Nothing downstream reads this. Safe to change.';
}

export function impactText(assessed, index) {
  if (!assessed.length) return 'No changes to known dbt models, sources or columns were detected.';
  const lines = [];
  for (const c of assessed) {
    lines.push(`- [${c.severity.toUpperCase()}] ${describeChange(c)}`);
    if (c.impact.direct.length) lines.push(`  Breaks directly: ${c.impact.direct.map((d) => `${label(index, d.id)}, ${d.via}`).join('; ')}`);
    if (c.impact.indirect.length) lines.push(`  Also affected: ${c.impact.indirect.map((d) => label(index, d.id)).join(', ')}`);
    if (c.impact.exposures.length) lines.push(`  Dashboards and consumers: ${c.impact.exposures.map((d) => label(index, d.id)).join(', ')}`);
    if (c.impact.owners.length) lines.push(`  Owners to notify: ${c.impact.owners.join(', ')}`);
    lines.push(`  What to do: ${adviceFor(c)}`);
  }
  return lines.join('\n');
}

export function assetText(a, index) {
  const ups = (a.dependsOn ?? []).map((d) => index?.byId.get(d)?.name ?? d);
  const downs = (index?.children.get(a.id) ?? []).map((d) => index.byId.get(d)?.name ?? d);
  return [
    `${a.name} (dbt ${a.type === 'exposure' ? a.kind ?? 'exposure' : a.type})${a.owner ? `, owned by ${a.owner}` : ''}${a.contract ? ', contract enforced' : ''}`,
    a.description,
    a.columns?.length && `Columns: ${a.columns.map((c) => (c.dataType ? `${c.name} ${c.dataType}` : c.name)).join(', ')}`,
    ups.length && `Reads from: ${ups.join(', ')}`,
    downs.length && `Used by: ${downs.join(', ')}`,
    a.exposureUrl && `Link: ${a.exposureUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// --- Change receipts ------------------------------------------------------------------

export function normalizeReceipt(input, { id, now }) {
  const issueKey = clean(input.issueKey, 40).toUpperCase();
  if (!KEY_RE.test(issueKey)) throw new Error(`"${input.issueKey}" is not a work item key.`);
  const summary = clean(input.summary, 2000);
  if (!summary) throw new Error('A receipt needs a summary of what changed.');
  const prUrl = clean(input.prUrl, 500);
  if (prUrl && !/^https?:\/\/\S+$/i.test(prUrl)) throw new Error('prUrl must be an http(s) link.');
  return {
    id,
    issueKey,
    agent: clean(input.agent, 80) || 'unnamed agent',
    summary,
    notified: splitList(input.notified),
    tests: clean(input.tests, 1000),
    prUrl,
    createdAt: now,
  };
}

// Owners an assessed change affects who no receipt says were notified.
export function unnotifiedOwners(assessed, receipts) {
  const told = new Set(receipts.flatMap((r) => r.notified.map(lc)));
  return uniq(assessed.filter((c) => c.severity !== 'safe').flatMap((c) => c.impact.owners)).filter((o) => !told.has(lc(o)));
}

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content });
const bullets = (items) => ({ type: 'bulletList', content: items.map((content) => ({ type: 'listItem', content: [para(...content)] })) });
const strong = [{ type: 'strong' }];

export const plainAdf = (value) => ({ type: 'doc', version: 1, content: [para(text(String(value)))] });

export function impactAdf(assessed, index) {
  return {
    type: 'doc',
    version: 1,
    content: [
      para(text('⚠️ Downstream: this work item changes data that others depend on', strong)),
      bullets(
        assessed.map((c) => [
          text(`${c.severity.toUpperCase()}: ${describeChange(c)}. `, strong),
          text(
            [
              c.impact.direct.length && `Breaks ${c.impact.direct.map((d) => index.byId.get(d.id)?.name).join(', ')}.`,
              c.impact.exposures.length && `Feeds ${c.impact.exposures.map((d) => index.byId.get(d.id)?.name).join(', ')}.`,
              c.impact.owners.length && `Owners: ${c.impact.owners.join(', ')}.`,
            ]
              .filter(Boolean)
              .join(' ') || 'Nothing downstream.',
          ),
        ]),
      ),
      para(text('Open the Downstream panel on this work item for details, or ask the Downstream agent in Rovo.')),
    ],
  };
}

export function receiptAdf(receipt, unnotified = []) {
  const items = [[text('Owners notified: ', strong), text(receipt.notified.join(', ') || 'none listed')]];
  if (receipt.tests) items.push([text('Tests: ', strong), text(receipt.tests)]);
  if (receipt.prUrl) items.push([text('Pull request: ', strong), text(receipt.prUrl, [{ type: 'link', attrs: { href: receipt.prUrl } }])]);
  const content = [para(text(`🧾 Data change receipt from ${receipt.agent}`, strong)), para(text(receipt.summary)), bullets(items)];
  if (unnotified.length) content.push(para(text('⚠️ Affected owners not notified yet: ', strong), text(unnotified.join(', '))));
  return { type: 'doc', version: 1, content };
}

// --- Misc -----------------------------------------------------------------------------

export function issueKeysIn(textValue) {
  return uniq(String(textValue ?? '').match(ISSUE_KEY_RE) ?? []);
}

// Rovo/MCP action payloads: an explicit key from the agent wins; otherwise use the work
// item the user is viewing, which Rovo passes deterministically in payload.context.
export function issueKeyOf(payload) {
  const fromInput = String(payload?.issueKey ?? '').trim().toUpperCase();
  const fromContext = String(payload?.context?.jira?.issueKey ?? '').toUpperCase();
  return KEY_RE.test(fromInput) || !KEY_RE.test(fromContext) ? fromInput : fromContext;
}

export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type) ? `${inner}\n` : inner;
}

// Finds assets by name, owner, description or column; exact names rank first.
export function searchAssets(assets, query, limit = 10) {
  const q = lc(query);
  if (!q) return assets.slice(0, limit);
  const words = q.split(/[^a-z0-9_.]+/).filter((w) => w.length >= 2);
  return assets
    .map((a) => {
      const name = lc(a.name);
      if (name === q || lc(a.id) === q) return { a, score: 100 };
      if (name.startsWith(q)) return { a, score: 60 };
      if (name.includes(q)) return { a, score: 50 };
      const hay = lc([a.name, a.owner, a.description, a.kind, ...(a.columns ?? []).map((c) => c.name)].join(' '));
      return { a, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name))
    .slice(0, limit)
    .map((x) => x.a);
}

export function findAsset(assets, nameOrId) {
  const q = lc(nameOrId).replace(/^(model|source|exposure)\./, '');
  return assets.find((a) => lc(a.id).replace(/^(model|source|exposure)\./, '') === q || lc(a.name) === q) ?? null;
}
