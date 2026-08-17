# Getting started

Four steps: install, create a Connected App, save its credentials, authenticate. Budget ten minutes,
most of it in the Anypoint Platform UI.

## 1. Install

```bash
npm install -g @sfdxy/anypoint-connect
anc --version
```

Requires Node.js `>=20.0.0`.

??? note "Install from source"

    ```bash
    git clone https://github.com/Avinava/anypoint-connect.git
    cd anypoint-connect
    npm install && npm run build
    npm link   # makes "anc" available globally
    ```

## 2. Create a Connected App

Authentication uses a Connected App in your Anypoint organization, so the tool acts as you rather than
as a shared service identity.

1. Log in to [Anypoint Platform](https://anypoint.mulesoft.com).
2. Go to **Access Management → Connected Apps**.
3. Click **Create app** and choose **App that acts on a user's behalf**.
4. Set the **Redirect URI** to `http://localhost:3000/api/callback`.
5. Grant the scopes you need:

    | Scope category | Permissions | Needed for |
    | --- | --- | --- |
    | General | View Organization, View Environment | Everything. Without these, no environment resolves |
    | Runtime Manager | Read Applications, Create/Modify Applications | Status, deploy, restart, scale |
    | CloudHub | Read Applications, Manage Applications | CloudHub 2.0 deployments and lifecycle |
    | Monitoring | Read Metrics | Metrics, percentiles, memory, AMQL |
    | Design Center | Read/Write Designer | Reading and pushing API specs |
    | Exchange | Exchange Contributor | Publishing assets and JARs |
    | Audit Logs | View Audit Logs | Deployment and change history. Optional |

6. Copy the **Client ID** and **Client Secret**.

Grant only what you intend to use. A read-only identity is a perfectly good setup if you never want an
agent to be able to deploy — see the [safety model](safety.md).

## 3. Save the credentials

```bash
anc config init
```

The prompt writes credentials to a per-profile file and keeps tokens separate and encrypted:

```text
Anypoint Connect Setup — Profile: default
  Credentials saved to: ~/.anypoint-connect/profiles/default/config.json
  Tokens saved to: ~/.anypoint-connect/profiles/default/tokens.enc (AES-256-GCM)

  Client ID: <paste your Client ID>
  Client Secret: <paste your Client Secret>
  Callback URL: (http://localhost:3000/api/callback)
  Base URL: (https://anypoint.mulesoft.com)
```

Confirm what was stored, with secrets masked:

```bash
anc config show
```

Working across several organizations? Use named profiles from the start — see
[Profiles and multiple orgs](profiles.md).

## 4. Authenticate

```bash
anc auth login
anc auth status
```

This opens a browser for OAuth and stores encrypted tokens locally. Tokens refresh automatically with a
five-minute buffer, so day-to-day use does not prompt again.

## 5. Confirm it works

```bash
anc apps list --env Sandbox
anc logs tail my-api --env Sandbox
anc monitor view --env Production
```

If any of those fail, the message names which of the [access states](readiness.md) you are in — being
unconfigured, unauthenticated, and lacking a scope are three different problems with three different
fixes.

## Credentials in CI

Environment variables take precedence over stored profile config, which is what makes unattended use
work without a login flow:

```bash
export ANYPOINT_CLIENT_ID=...
export ANYPOINT_CLIENT_SECRET=...
```

Never commit credentials, and never paste them into an agent conversation. The CLI holds the session;
nothing that consumes this tool needs the secret itself.

## Next

- [CLI reference](cli-reference.md) for every command
- [MCP server](mcp.md) to let an AI agent use it
- [Safety model](safety.md) before anything touches production
