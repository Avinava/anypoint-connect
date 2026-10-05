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
    `PATH` by replacing `anc` with `npx --yes @sfdxy/anypoint-connect@0.15.0` in the commands below.

</div>

<div class="anc-step" markdown="1">
<span class="anc-step-number">02</span>

## Create the Connected App

Creating the app requires Organization Administrator permission at the relevant root organization or
business group. If you do not have it, send the [administrator handoff](credentials.md#administrator-handoff)
checklist instead of asking for broader personal permissions.

1. Sign in to [Anypoint Platform](https://anypoint.mulesoft.com).
2. Open **Access Management**, select the intended business group if necessary, and open
   **Connected Apps → Owned Apps → Create app**.
3. Use these values:

    | Field | Value | Why |
    | --- | --- | --- |
    | Name | `anypoint-connect-local` or another neutral internal label | Avoid customer names in screenshots and support threads |
    | Type | **App acts on behalf of a user** | The toolkit operates with the signing-in user's identity and permissions |
    | Grant type | **Authorization Code** | The CLI receives a short-lived code through its local callback |
    | Website URL | `https://github.com/Avinava/anypoint-connect` | Identifies the software requesting access |
    | Redirect URI | `http://localhost:3000/api/callback` | Must match the CLI default exactly, including scheme, port, and path |
    | Audience | **Members of this organization only** | Appropriate for an internal Connected App |
    | Scopes | **Full Access** (`full`) and **Background Access** (`offline_access`) | Act with the user's existing permissions, and receive a refresh token so you are not asked to log in every hour |

4. Save the app, then use **Copy ID** and **Copy Secret**. Keep both in a secure temporary location or an
   approved secret manager. Do not paste either value into an issue, chat, or source file.

The [credential reference](credentials.md) explains what the ID, Secret, and tokens each prove, why
these scopes are requested, and how to rotate the secret. MuleSoft's own steps are in the
[Connected App documentation](https://docs.mulesoft.com/access-management/creating-connected-apps-dev).

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
<a class="anc-card" href="../mcp/"><span class="anc-kicker">MCP</span><h3>Connect an MCP host</h3><p>Configure Codex, Claude, VS Code, or another stdio MCP client.</p></a>
<a class="anc-card" href="../profiles/"><span class="anc-kicker">Teams</span><h3>Add another organization</h3><p>Use neutral named profiles and bind the correct one to each project directory.</p></a>
</div>

## Uninstalling or signing out

`anc auth logout` removes OAuth tokens for the active profile but keeps the Client ID and Secret. To
remove the package itself, run `npm uninstall --global @sfdxy/anypoint-connect`. Delete a local profile
directory only when you intentionally want to remove its saved credentials as well.
