---
name: downstream
description: Use when changing dbt models, sources or columns (SQL or schema YAML), or when planning data work for a Jira work item such as DATA-42, in a team that uses the Downstream Forge app. Tells you what your change breaks downstream and who owns it before you edit SQL, and posts a data change receipt when you finish.
---

# Downstream: do not break other people's data

Downstream is a Jira app that knows the team's dbt lineage: which models read which
columns, the dashboards and ML models they feed, owners, and enforced contracts. It exposes
that as MCP tools. Use it before every change to a dbt model.

## Connect

Add the remote MCP server `https://mcp.atlassian.com/forge/<appId>` to your agent, where
`<appId>` is the UUID from the Downstream app id. A site admin first enables the tools under
Atlassian Administration > Apps > Sites > your site > Connected apps. Tools run with your
own Jira permissions.

## Workflow for every data change

1. **Read the impact.** If there is a work item, call `get-ticket-impact` with its key.
   Otherwise call `get-impact` with the model (and column) you intend to change.
2. **Write a concrete plan** that names models and columns: "rename amount to gross_amount
   in orders".
3. **Check the plan.** Call `check-change` with the plan (and the work item key). If `ok` is
   false, do not edit SQL yet:
   - **blocking** (enforced contract): add a new model version alongside the current one
     instead of changing it, and plan the deprecation with the owners.
   - **breaking**: update every downstream model listed under "breaks" in the same change, or
     keep a compatible column for a release.
   - **risky** (logic change with consumers): tell the owners before release.
   Revise and check again until `ok` is true, or stop and ask the user.
4. **Implement and test** (`dbt build` on the changed models and their children).
5. **Leave a receipt.** Call `submit-change-receipt` with the key, what changed, the owners
   you notified (`notified`), the test results, the PR link and your agent name. Tell the
   user which affected owners the response says were not notified.

## Rules

- Never claim a change is safe without `check-change` or `get-impact`.
- Use model, column and owner names exactly as the tools return them.
- Treat a blocking result as a hard stop.
