<div class="anc-hero" markdown="1">

<span class="anc-eyebrow">CLI · MCP server · JavaScript library</span>

# Operate Anypoint Platform with safer defaults

<p class="anc-lead">Install once, authenticate through your organization’s Connected App, and use the same well-tested client to inspect applications, analyze logs, pull metrics, manage API assets, and perform guarded lifecycle operations.</p>

<div class="anc-actions">
<a class="anc-button anc-button--primary" href="getting-started/">Set up in about 15 minutes</a>
<a class="anc-button" href="recipes/">See working recipes</a>
</div>

<div class="anc-command"><code>npm install --global @sfdxy/anypoint-connect
anc config init
anc auth login
anc auth status</code></div>

</div>

## Choose how you want to use it

<div class="anc-grid">
<a class="anc-card" href="getting-started/">
<span class="anc-kicker">Terminal</span>
<h3>Use the CLI</h3>
<p>Best for operators and Mule developers who want copyable commands without writing Node.js.</p>
</a>
<a class="anc-card" href="mcp/">
<span class="anc-kicker">AI tools</span>
<h3>Run the MCP server</h3>
<p>Let an agent inspect runtime evidence while credentials and confirmation gates remain local.</p>
</a>
<a class="anc-card" href="library/">
<span class="anc-kicker">Automation</span>
<h3>Call the library</h3>
<p>Use the same API clients from JavaScript or TypeScript after authenticating a local profile.</p>
</a>
</div>

## Credentials, without the mystery

`anypoint-connect` uses a Connected App that **acts on behalf of a user**. The Client ID and Client
Secret identify the app; a browser login authorizes the user; the resulting OAuth tokens are stored
separately and refreshed automatically.

<div class="anc-flow">
<div class="anc-flow-card"><strong>Connected App</strong><span>Client ID, Client Secret, redirect URI, Full Access, Background Access</span></div>
<div class="anc-flow-arrow" aria-hidden="true">→</div>
<div class="anc-flow-card"><strong>Browser authorization</strong><span>The user signs in with existing Anypoint permissions and MFA</span></div>
<div class="anc-flow-arrow" aria-hidden="true">→</div>
<div class="anc-flow-card"><strong>Local profile</strong><span>Restricted credential file plus encrypted, refreshable OAuth tokens</span></div>
</div>

[Follow the exact Connected App fields](credentials.md), including what to ask an organization
administrator for and how to rotate a secret safely.

## What it covers

| Area | Typical work |
| --- | --- |
| Runtime Manager | List, inspect, deploy, redeploy, roll back, restart, scale, stop, start, and delete applications |
| Logs and monitoring | Tail logs, group errors, find patterns, pull percentiles, inspect workers, memory, and GC |
| Exchange and Design Center | Search assets, download specifications, synchronize source, publish APIs and application JARs |
| API Manager | Inspect instances, policies, SLA tiers, and alerts |
| Platform services | Environments, entitlements, audit log, Anypoint MQ, and Object Store v2 |

## Safety is part of the interface

Mutating MCP tools preview by default. Artifact updates preserve runtime, target, replicas, and settings;
deletion is bound to the deployment ID that was inspected; production operations require an additional
acknowledgement. Read the [safety model](safety.md) before automating a change.

<div class="anc-note" markdown="1">

**Start with a read.** `anc auth status` verifies the local session, and
`anc apps list --env Sandbox` verifies that the intended environment is visible. Authentication,
environment visibility, permissions, and subscription entitlements are separate states with separate fixes.

</div>
