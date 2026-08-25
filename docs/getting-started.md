# Getting started

This path is written for MuleSoft developers who use Maven, Studio, or Runtime Manager but do not
normally work with Node.js. You will install one command, create one Connected App, authorize it in a
browser, and finish with a safe read-only check.

**Expected time:** about 15 minutes. Most of it is in the Anypoint Platform UI.

<div class="anc-step" markdown="1">
<span class="anc-step-number">01</span>

## Install Node.js and `anc`

Use **Node.js 24 LTS**. Download the LTS installer for your operating system from
[nodejs.org](https://nodejs.org/en/download), accept the option to install npm, then open a new terminal.

```bash
node --version
npm --version
```

`node --version` should begin with `v24`. Node 22 is also supported; Node 20 is not.

Install the CLI globally:

```bash
npm install --global @sfdxy/anypoint-connect
anc --version
```

??? tip "If your terminal says `anc: command not found`"

    Close and reopen the terminal first. If the command is still missing, run `npm prefix --global` and
    confirm that npm's global binary directory is on your `PATH`. You can continue without changing
    `PATH` by replacing `anc` with `npx --yes @sfdxy/anypoint-connect@0.13.0` in the commands below.

</div>

<div class="anc-step" markdown="1">
<span class="anc-step-number">02</span>

## Create the Connected App

In Anypoint Platform, go to **Access Management → Connected Apps → Create app** and use these values:

| Field | Value |
| --- | --- |
| Name | `anypoint-connect-local` or another neutral internal name |
| Type | **App acts on behalf of a user** |
| Grant type | **Authorization Code** |
| Website URL | `https://github.com/Avinava/anypoint-connect` |
| Redirect URI | `http://localhost:3000/api/callback` |
| Audience | **Members of this organization only** for an internal app |
| Scopes | **Full Access** (`full`) and **Background Access** (`offline_access`) |

Save the app, then copy its **Client ID** and **Client Secret** to a secure temporary location. Do not
paste either value into an issue, chat, or source file.

If you cannot create Connected Apps, send the exact table above to an organization administrator. The
[credential guide](credentials.md) explains permissions, allowlists, rotation, and why these two scopes
are required.

</div>

<div class="anc-step" markdown="1">
<span class="anc-step-number">03</span>

## Save the credentials locally

```bash
anc config init
```

Paste the Client ID when prompted. Keep the default callback and base URLs unless your platform
administrator has given you different values. The Client Secret prompt is masked.

```text
Anypoint Connect Setup — Profile: default
  Credentials saved to: ~/.anypoint-connect/profiles/default/config.json
  Tokens saved to: ~/.anypoint-connect/profiles/default/tokens.enc (AES-256-GCM)

  Client ID: <paste Client ID>
  Callback URL: (http://localhost:3000/api/callback)
  Base URL: (https://anypoint.mulesoft.com)
  Default Environment (optional):
  Client Secret: ********
```

Confirm the resolved profile and masked secret:

```bash
anc config show
```

The Client Secret is stored in `config.json`, restricted to the current operating-system user. OAuth
tokens are stored separately in encrypted form. See [where credentials live](credentials.md#where-the-files-live).

</div>

<div class="anc-step" markdown="1">
<span class="anc-step-number">04</span>

## Authorize the session

```bash
anc auth login
```

The CLI starts a loopback callback server and opens Anypoint Platform in your browser. Sign in normally,
including MFA, review the requested access, and grant it. The browser shows a local success page; return
to the terminal when it does.

```bash
anc auth status
```

You should see `Authenticated`, a token expiry, and `Can Refresh: Yes`.

</div>

<div class="anc-step" markdown="1">
<span class="anc-step-number">05</span>

## Prove the environment is visible

Use an environment name that your Anypoint user can already see:

```bash
anc apps list --env Sandbox
```

An empty application list is still a successful access check. An authentication error, invisible
environment, missing permission, and missing subscription are different conditions; use
[Access readiness](readiness.md) to identify the one you have.

</div>

## Choose your next path

<div class="anc-grid">
<a class="anc-card" href="../recipes/"><span class="anc-kicker">CLI</span><h3>Run a common task</h3><p>Application health, logs, metrics, deployment previews, and other copyable recipes.</p></a>
<a class="anc-card" href="../mcp/"><span class="anc-kicker">MCP</span><h3>Connect an AI host</h3><p>Configure Codex, Claude, VS Code, or another stdio MCP client.</p></a>
<a class="anc-card" href="../profiles/"><span class="anc-kicker">Teams</span><h3>Add another organization</h3><p>Use neutral named profiles and bind the correct one to each project directory.</p></a>
</div>

## Uninstalling or signing out

`anc auth logout` removes OAuth tokens for the active profile but keeps the Client ID and Secret. To
remove the package itself, run `npm uninstall --global @sfdxy/anypoint-connect`. Delete a local profile
directory only when you intentionally want to remove its saved credentials as well.
