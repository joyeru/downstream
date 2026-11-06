// Jira REST adapter. Reads run as the invoking user so an agent can only see what its
// user can see; the trigger has no user and reads as the app. Comments are posted by
// the app so receipts and warnings are clearly attributed to Downstream.
import api, { route } from '@forge/api';
import { KEY_RE, adfToText } from './core.js';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export function jiraClient(as) {
  const reader = () => (as === 'app' ? api.asApp() : api.asUser());
  return {
    async getIssue(issueKey) {
      const key = String(issueKey ?? '').trim().toUpperCase();
      if (!KEY_RE.test(key)) throw new Error(`"${issueKey}" is not a work item key like PAY-142.`);
      const res = await reader().requestJira(
        route`/rest/api/3/issue/${key}?fields=summary,description,labels,components,status,assignee,project`,
        { headers: { Accept: 'application/json' } },
      );
      if (res.status === 404) throw new Error(`Work item ${key} was not found or you cannot see it.`);
      if (!res.ok) throw new Error(`Jira returned ${res.status} for ${key}.`);
      const { key: realKey, fields } = await res.json();
      return {
        key: realKey,
        projectKey: fields.project?.key ?? realKey.split('-')[0],
        summary: fields.summary ?? '',
        description: adfToText(fields.description).trim(),
        labels: fields.labels ?? [],
        components: (fields.components ?? []).map((c) => c.name),
        status: fields.status?.name ?? '',
        assignee: fields.assignee?.displayName ?? '',
      };
    },

    async addComment(issueKey, adf) {
      const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ body: adf }),
      });
      if (!res.ok) throw new Error(`Could not comment on ${issueKey} (Jira returned ${res.status}).`);
    },

    async listProjects() {
      const res = await reader().requestJira(route`/rest/api/3/project/search?maxResults=50&orderBy=name`, { headers: JSON_HEADERS });
      if (!res.ok) throw new Error(`Jira returned ${res.status} listing projects.`);
      return ((await res.json()).values ?? []).map((p) => ({ key: p.key, name: p.name }));
    },

    // Creates a work item as the user, as a Task when the project has one.
    async createIssue(projectKey, summary, adf) {
      const meta = await reader().requestJira(route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`, { headers: JSON_HEADERS });
      if (!meta.ok) throw new Error(`Jira returned ${meta.status} for the issue types of ${projectKey}.`);
      const body = await meta.json();
      const types = (body.issueTypes ?? body.createMetaIssueType ?? []).filter((t) => !t.subtask);
      // Names are localized for the user, so fall back to any standard (non-epic) type.
      const type = types.find((t) => t.name === 'Task') ?? types.find((t) => t.hierarchyLevel === 0) ?? types[0];
      if (!type) throw new Error(`${projectKey} has no issue type you can create.`);
      const res = await reader().requestJira(route`/rest/api/3/issue`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ fields: { project: { key: projectKey }, issuetype: { id: type.id }, summary, description: adf } }),
      });
      if (!res.ok) throw new Error(`Jira returned ${res.status} creating the work item: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).key;
    },
  };
}
