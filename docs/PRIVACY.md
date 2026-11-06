# Downstream privacy policy

Downstream is a Forge app for Jira. It runs on Atlassian's Forge platform inside the
customer's Atlassian site.

**What it stores.** The dbt catalog (model, source and exposure names, descriptions,
columns, owners, contracts and lineage), data change receipts and issue scan results, in
Forge storage within the customer's site. The developer has no access to this data.
Downstream does not store Atlassian account IDs or other personal data about users; a receipt
names the agent that submitted it, not the person.

**What it reads.** Jira work items the invoking user can see (summary and description). The
issue guard reads newly created or edited work items as the app.

**What it writes.** Comments on Jira work items for change receipts and impact warnings.

**External services.** None by default. If an administrator configures the dbt connector,
Downstream reads the dbt project files from GitHub (`api.github.com` and `raw.githubusercontent.com`) using the repository, folder,
branch and optional token the administrator provides. The token is stored as a Forge secret,
is never shown again and is only sent to GitHub. SQL is used to compute lineage and is not
stored.

**Teamwork Graph.** Imported models, sources and dashboards are ingested into the customer's
Teamwork Graph and are visible to members of that workspace in Rovo Search and Rovo Chat.

**Deletion.** Uninstalling the app removes its Forge storage. Disconnecting the connector
removes its Teamwork Graph data.

**Contact.** Open an issue on the public repository or use the support contact on the
Atlassian Marketplace listing.
