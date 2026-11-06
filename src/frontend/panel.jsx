import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, Heading, Inline, Link, Lozenge, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke, rovo } from '@forge/bridge';

const SEVERITY = { blocking: 'removed', breaking: 'moved', risky: 'inprogress', safe: 'success' };
const list = (xs) => (xs || []).map((x) => (x.owner ? `${x.name} (${x.owner})` : x.name)).join(', ');

function Change({ c }) {
  return (
    <Stack space="space.050">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={SEVERITY[c.severity]}>{c.severity}</Lozenge>
        <Text weight="semibold">{c.summary}</Text>
      </Inline>
      {c.direct.length ? <Text size="small">{`Breaks directly: ${c.direct.map((d) => `${d.name}${d.owner ? ` (${d.owner})` : ''}, ${d.via}`).join('; ')}`}</Text> : null}
      {c.indirect.length ? <Text size="small">{`Also affected: ${list(c.indirect)}`}</Text> : null}
      {c.exposures.length ? <Text size="small">{`Dashboards and consumers: ${list(c.exposures)}`}</Text> : null}
      {c.owners.length ? <Text size="small" weight="semibold">{`Owners to notify: ${c.owners.join(', ')}`}</Text> : null}
      <Text size="small" color="color.text.subtle">
        {c.advice}
        {c.asset.url ? ' ' : ''}
        {c.asset.url ? (
          <Link href={c.asset.url} openNewTab>
            {`Open ${c.asset.name}`}
          </Link>
        ) : null}
      </Text>
    </Stack>
  );
}

function App() {
  const [state, setState] = useState({ loading: true });
  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    const res = await invoke('panel');
    setState({ loading: false, ...res });
  };
  // null while unknown; Rovo is off on some sites (for example Free plans).
  const [rovoOn, setRovoOn] = useState(null);
  const [rovoError, setRovoError] = useState(null);
  useEffect(() => {
    load();
    rovo
      .isEnabled()
      .then(setRovoOn)
      .catch(() => setRovoOn(false));
  }, []);

  if (state.loading && !state.data && !state.error) return <Spinner label="Checking downstream impact" />;
  if (state.error) {
    return (
      <SectionMessage appearance={/No dbt project/.test(state.error) ? 'information' : 'error'} title="Downstream">
        <Text>{state.error}</Text>
      </SectionMessage>
    );
  }
  const { issueKey, changes = [], receipts = [], unnotified = [] } = state.data;
  const risky = changes.filter((c) => c.severity !== 'safe');
  const askAgent = async () => {
    setRovoError(null);
    try {
      await rovo.open({
        type: 'forge',
        agentName: 'Downstream',
        agentKey: 'downstream-agent',
        prompt: `What breaks downstream if we do ${issueKey}, and who should we tell?`,
      });
    } catch (e) {
      setRovoError(`Rovo could not open the Downstream agent: ${e?.message ?? e}`);
    }
  };

  return (
    <Stack space="space.200">
      {!changes.length ? (
        <SectionMessage appearance="success" title="No data changes detected">
          <Text>This work item does not change any known dbt model, source or column.</Text>
        </SectionMessage>
      ) : (
        <SectionMessage appearance={risky.length ? 'warning' : 'success'} title={`${changes.length} data change(s), ${risky.length} with downstream impact`}>
          <Text>Review the impact below before the change is built.</Text>
        </SectionMessage>
      )}
      {changes.map((c) => (
        <Change key={c.key} c={c} />
      ))}

      <Heading size="xsmall">{`Change receipts (${receipts.length})`}</Heading>
      {receipts.length ? (
        receipts.map((r) => (
          <Stack key={r.id} space="space.025">
            <Text weight="semibold">{`${r.createdAt.slice(0, 10)} · ${r.agent}`}</Text>
            <Text size="small">{r.summary}</Text>
            <Text size="small" color="color.text.subtle">{`Notified: ${(r.notified || []).join(', ') || 'nobody listed'}${r.tests ? ` · Tests: ${r.tests}` : ''}`}</Text>
          </Stack>
        ))
      ) : (
        <Text color="color.text.subtle">No receipts yet. Agents post one with the submit-change-receipt tool when they finish.</Text>
      )}
      {unnotified.length ? (
        <SectionMessage appearance="warning" title="Owners not notified yet">
          <Text>{unnotified.join(', ')}</Text>
        </SectionMessage>
      ) : null}

      {rovoError ? (
        <SectionMessage appearance="error">
          <Text>{rovoError}</Text>
        </SectionMessage>
      ) : null}
      <Inline space="space.100" alignBlock="center">
        {rovoOn ? (
          <Button appearance="rovo" onClick={askAgent}>
            Ask Downstream
          </Button>
        ) : null}
        <Button appearance="subtle" onClick={load} isDisabled={state.loading}>
          Refresh
        </Button>
        {rovoOn === false ? (
          <Text size="small" color="color.text.subtle">
            Rovo is not enabled on this site, so the Downstream agent is unavailable here. The MCP tools still work.
          </Text>
        ) : null}
      </Inline>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
