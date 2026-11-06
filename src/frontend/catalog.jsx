import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, DynamicTable, EmptyState, Heading, Inline, Label, Link, Lozenge, SectionMessage, Select, Stack, Text, Textfield } from '@forge/react';
import { invoke } from '@forge/bridge';

const TYPE = { model: 'inprogress', source: 'default', exposure: 'discovery' };

// One click to a work item that shows Downstream's impact panel.
function DemoIssue() {
  const [projects, setProjects] = useState(null);
  const [project, setProject] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    invoke('projects').then((res) => setProjects(res.data || []));
  }, []);
  const create = async () => {
    setBusy(true);
    setResult(await invoke('createDemoIssue', { projectKey: project?.value }));
    setBusy(false);
  };
  if (projects && !projects.length) return <Text size="small">Create a Jira project to try the demo work item.</Text>;
  return (
    <Stack space="space.100">
      <Heading size="small">Try it</Heading>
      <Text>Create the demo work item "Clean up the orders model" in a project, then open its Downstream impact panel.</Text>
      <Inline space="space.100" alignBlock="end">
        <Stack space="space.050">
          <Label labelFor="demo-project">Project</Label>
          <Select id="demo-project" placeholder="Choose a Jira project" options={(projects || []).map((p) => ({ label: `${p.name} (${p.key})`, value: p.key }))} value={project} onChange={setProject} />
        </Stack>
        <Button onClick={create} isDisabled={!project || busy}>
          {busy ? 'Creating…' : 'Create demo work item'}
        </Button>
      </Inline>
      {result?.error ? (
        <SectionMessage appearance="error">
          <Text>{result.error}</Text>
        </SectionMessage>
      ) : null}
      {result?.data ? (
        <Text>
          {'Created '}
          <Link href={`/browse/${result.data.issueKey}`} openNewTab>
            {result.data.issueKey}
          </Link>
          {'. Open it and add the Downstream impact panel.'}
        </Text>
      ) : null}
    </Stack>
  );
}

const head = {
  cells: [
    { key: 'name', content: 'Name', isSortable: true },
    { key: 'type', content: 'Type', isSortable: true },
    { key: 'owner', content: 'Owner', isSortable: true },
    { key: 'contract', content: 'Contract' },
    { key: 'usedBy', content: 'Used by', isSortable: true },
    { key: 'columns', content: 'Columns' },
  ],
};

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const load = async () => {
    const res = await invoke('catalog');
    if (res.error) setError(res.error);
    else setData(res.data);
  };
  useEffect(() => {
    load();
  }, []);

  const loadSample = async () => {
    setBusy(true);
    setError(null);
    const res = await invoke('loadSample');
    if (res.error) setError(res.error);
    await load();
    setBusy(false);
  };

  const q = filter.trim().toLowerCase();
  const assets = (data?.assets || []).filter((a) => !q || `${a.name} ${a.owner} ${a.kind ?? ''}`.toLowerCase().includes(q));
  const rows = assets.map((a) => ({
    key: a.id,
    cells: [
      {
        key: 'name',
        content: a.url ? (
          <Link href={a.url} openNewTab>
            {a.name}
          </Link>
        ) : (
          a.name
        ),
      },
      { key: 'type', content: <Lozenge appearance={TYPE[a.type]}>{a.type === 'exposure' ? a.kind : a.type}</Lozenge> },
      { key: 'owner', content: a.owner || '—' },
      { key: 'contract', content: a.contract ? <Lozenge appearance="removed">enforced</Lozenge> : '—' },
      { key: 'usedBy', content: a.usedBy },
      { key: 'columns', content: (a.columns || []).length },
    ],
  }));
  const meta = data?.meta;
  const canLoadSample = !meta || /sample/i.test(meta.source ?? '') || !data?.connected;

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Text>
          Downstream knows your dbt lineage: which models read which columns, the dashboards they feed and who owns them. It warns on Jira work
          items that would break them, and gives Rovo and any MCP client the same impact analysis.
        </Text>
      </Stack>
      {error ? (
        <SectionMessage appearance="error" title="Something went wrong">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
      {meta ? (
        <Text size="small" color="color.text.subtle">
          {`${meta.project} · ${meta.assets} assets · ${meta.source} · synced ${String(meta.syncedAt).slice(0, 16).replace('T', ' ')} UTC`}
          {meta.errors?.length ? ` · ${meta.errors.length} file(s) could not be parsed: ${meta.errors.join('; ')}` : ''}
        </Text>
      ) : null}
      <Inline space="space.200" alignBlock="end">
        <Stack space="space.050">
          <Label labelFor="filter">Filter by name, owner or type</Label>
          <Textfield id="filter" value={filter} onChange={(e) => setFilter(String(e?.target?.value ?? ''))} />
        </Stack>
        {canLoadSample ? (
          <Button onClick={loadSample} isDisabled={busy}>
            {busy ? 'Loading…' : 'Load sample dbt project'}
          </Button>
        ) : null}
      </Inline>
      {data && !data.assets.length ? (
        <EmptyState
          header="No dbt project connected yet"
          description="Load the sample jaffle shop project to try Downstream, or ask an admin to add the dbt connector in Atlassian Administration and point it at your dbt repository on GitHub."
        />
      ) : (
        <DynamicTable head={head} rows={rows} isLoading={!data} rowsPerPage={25} label="dbt models, sources and exposures" />
      )}
      {data?.assets.length ? <DemoIssue /> : null}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
