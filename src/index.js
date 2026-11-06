// Forge entry points. Each one adapts its module's calling convention to the service;
// the behaviour lives in service.js and core.js.
import Resolver from '@forge/resolver';
import { KEY_RE, issueKeyOf } from './core.js';
import { createService } from './service.js';
import { jiraClient } from './jira.js';
import { connections, store } from './store.js';

export { onConnectionChange, validateConnection, resyncAll } from './connector.js';

const asUser = () => createService({ store, jira: jiraClient('user') });
const asApp = () => createService({ store, jira: jiraClient('app') });

// Rovo actions and MCP tools. Failures come back as text so the agent can relay them.
const action = (fn) => async (payload = {}, context = {}) => {
  try {
    return await fn(payload, context);
  } catch (e) {
    console.error('[downstream] action failed', e);
    return `Downstream could not complete that: ${e.message}`;
  }
};

export const getTicketImpact = action((p) => asUser().ticketImpact(issueKeyOf(p)));
export const checkChange = action((p) => {
  const key = issueKeyOf(p);
  return asUser().checkChange(p.plan, KEY_RE.test(key) ? key : undefined);
});
export const getImpact = action((p) => asUser().impactOf(p.asset, p.column));
export const describeAsset = action((p) => asUser().describeAsset(p.asset));
export const findAssets = action((p) => asUser().findAssets(p.query));
// Receipts name the agent, not the Atlassian account, so the app stores no personal data.
export const submitChangeReceipt = action((p) => asUser().submitReceipt({ ...p, issueKey: issueKeyOf(p) }));

// Product trigger: warn when a new or edited work item would break data others depend on.
export async function guardIssue(event) {
  const key = event?.issue?.key;
  if (!key) return;
  try {
    const { notified } = await asApp().scanIssue(key);
    if (notified.length) console.log(`[downstream] ${key}: warned about ${notified.join(', ')}`);
  } catch (e) {
    console.error(`[downstream] guard failed for ${key}`, e);
  }
}

// UI Kit resolvers for the issue panel and the catalog page.
const resolver = new Resolver();
const ui = (fn) => async (req) => {
  try {
    return { data: await fn(req) };
  } catch (e) {
    console.error('[downstream] resolver failed', e);
    return { error: e.message };
  }
};
resolver.define('panel', ui(({ context }) => asUser().panel(context.extension.issue.key)));
// `connected`: a configured connector re-syncs daily, so the sample is only offered without one.
resolver.define('catalog', ui(async () => ({ ...(await asUser().listAssets()), connected: (await connections.list()).length > 0 })));
resolver.define('loadSample', ui(async () => {
  const { list, ...info } = await asUser().loadSample();
  return info;
}));
resolver.define('projects', ui(() => asUser().projects()));
resolver.define('createDemoIssue', ui(({ payload }) => asUser().createDemoIssue(payload?.projectKey)));
export const handler = resolver.getDefinitions();
