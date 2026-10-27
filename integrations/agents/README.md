# Agent tools

Use FlockStack's existing MCP server from Claude Code or Codex, or this dependency-free Node 22 CLI. The skill in `skills/flockstack/SKILL.md` uses the same registered actions. Each client authenticates to the owner's chosen region independently; no connection is installed by these files.

```sh
export FLOCKSTACK_URL=https://flockstack.io
# Set FLOCKSTACK_API_KEY privately in your terminal or secret manager.
node integrations/agents/cli.mjs brief --input brief.json
node integrations/agents/cli.mjs bootstrap --input bootstrap.json
node integrations/agents/cli.mjs workspace-create --input workspace.json --output workspace-private.json
```

A brief input is `{"newsletter":"garden-notes","timeZone":"Europe/Madrid"}`. A bootstrap input is:

```json
{
  "externalId": "garden-notes-setup",
  "name": "Garden notes",
  "brief": "Private writing brief for a gardening newsletter.",
  "description": "Practical gardening notes.",
  "drafts": [
    { "subject": "Welcome", "content": "A draft to review." },
    { "subject": "Soil", "content": "A draft to review." },
    { "subject": "Water", "content": "A draft to review." },
    { "subject": "Seasons", "content": "A draft to review." }
  ]
}
```

Workspace creation uses that input without externalId. It needs no API key. Its returned draft capability is restricted to GET/PATCH `/api/agent-workspaces/<id>` with Bearer authentication; a PATCH takes `{"revision":1,"payload":{...}}`. It is not a customer API key. Give the private claim link only to the intended owner. The fragment holds the capability and does not reach server access logs.

The CLI refuses redirects before a credential can reach another origin, writes capabilities only to a new file with mode 0600, and never prints upstream error bodies. Keep input and output files out of Git. `import-paid` is preview-only in this CLI. See [the implementation guide](../../docs/HANDOVER-BUILDS.md) for dashboards, inbound setup, imports and limitations.
