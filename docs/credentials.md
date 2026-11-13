# Connected App and credentials

The setup uses three related things that are easy to conflate:

| Item | What it proves | Where it lives |
| --- | --- | --- |
| Client ID | Which Connected App is asking | Profile `config.json`; not a password, but still an internal identifier |
| Client Secret | That the local client is allowed to act as that Connected App | Profile `config.json`, mode `0600`; never commit or paste into chat |
| OAuth tokens | That a particular user granted the app access | Encrypted `tokens.enc`; refreshed automatically |

The Client ID and Secret do **not** grant platform access on their own. A user still authorizes the app
through the browser, and effective access cannot exceed that user's Anypoint permissions.

This page is the reference for what the credentials are, where they are stored, and how to rotate or
revoke them. To create the Connected App and log in for the first time, follow
[Getting started](getting-started.md#create-the-connected-app); it has the exact field values.

## Why these scopes

| UI label | OAuth scope | Purpose |
| --- | --- | --- |
| Full Access | `full` | Allows anything the signing-in user is already permitted to do |
| Background Access | `offline_access` | Issues a refresh token so the CLI does not require a browser login every hour |

The OAuth request asks for exactly `full offline_access`. Product-specific permissions such as Runtime
Manager, Monitoring, Exchange, or Anypoint MQ are not requested scopes: effective access is whatever the
authorizing user already has. Authorize with a read-only Anypoint user when the toolkit must never deploy
or change resources.

## Entering the secret

Use `anc config init`; the Client Secret prompt is masked, so the value does not enter shell history. Do
not use `anc config set clientSecret ...` for routine secret entry: the value can remain in terminal
history or be visible to process inspection. Re-running `anc config init` keeps an existing secret when the
masked prompt is left blank.

## Where the files live

```text
~/.anypoint-connect/
└── profiles/
    └── default/
        ├── config.json   # Client ID and Secret; restricted to this OS user
        └── tokens.enc    # AES-256-GCM encrypted OAuth tokens
```

The token encryption key is derived from machine, operating-system user, and profile information. A
copied `tokens.enc` file is not a portable CI credential and should not be backed up as a reusable
session. Named profiles use the same layout; see [Profiles](profiles.md).

Credential resolution, highest priority first:

1. `ANYPOINT_CLIENT_ID` and `ANYPOINT_CLIENT_SECRET` in the process environment.
2. The active profile's `config.json`.
3. A project-local `.env` file as a legacy fallback.

In the default mode, environment variables change where the app credentials come from; they do not remove
the browser authorization step or create an OAuth token. See
[CI and unattended systems](#ci-and-unattended-systems) for the service modes.

## Administrator handoff

Send an administrator this checklist without adding an organization or customer name:

```text
Please create an internal Connected App for anypoint-connect:
- Type: App acts on behalf of a user
- Grant type: Authorization Code
- Redirect URI: http://localhost:3000/api/callback
- Website: https://github.com/Avinava/anypoint-connect
- Scopes: Full Access and Background Access
- Audience: Members of this organization only

Please deliver the Client ID and Client Secret through the approved secret manager.
```

If the organization uses a restricted Connected App authorization policy, an administrator may also
need to allowlist the app. Internal apps are normally treated differently from third-party apps; follow
the organization's policy rather than weakening it.

## Rotate or revoke access

To rotate the Client Secret:

1. Change the secret in **Access Management → Connected Apps → Owned Apps**.
2. Run `anc config init` for every affected profile and enter the new secret at the masked prompt.
3. Run `anc auth login` again, then `anc auth status`.

To revoke a user's authorization, use the Connected App authorizations view in Anypoint Platform. To
remove only the local tokens, run `anc auth logout`. Logout does not delete `config.json`.

## CI and unattended systems

The default is the user Authorization Code flow, which needs a person and a browser once. A CI runner with
only `ANYPOINT_CLIENT_ID` and `ANYPOINT_CLIENT_SECRET` has no authorized session, and the machine-bound
token file is not a supported secret to copy between hosts. For unattended runs, choose a service mode
with `ANYPOINT_AUTH_MODE` (or `anc config set authMode <mode>`):

| Mode | Credentials | Behavior |
| --- | --- | --- |
| `authorization_code` (default) | Client ID and Secret, then `anc auth login` | A person authorizes once; tokens are stored encrypted and refreshed |
| `client_credentials` | `ANYPOINT_CLIENT_ID` and `ANYPOINT_CLIENT_SECRET` of a Connected App that acts on its own behalf | The runner exchanges them for a token, kept in memory only and renewed shortly before it expires; nothing is written to disk |
| `bearer` | `ANYPOINT_ACCESS_TOKEN` | The supplied token is used as is, in memory only. Its lifetime is unknown, so it is never refreshed; a rejected token is reported as such |

Service modes have no user, so they need an explicit organization: set `ANYPOINT_ORG_ID` (or `anc config
set orgId <id>`). Configuration fails before any request when it is missing. `whoami` and `anc auth
status` then report the mode, the organization and the environments the identity can see, and `anc auth
login` is not available. A service identity needs its own Connected App with the scopes and
environment access the work requires; a visible environment does not mean Monitoring, alerts, Design
Center or Anypoint MQ access, which are checked per endpoint.

`ANYPOINT_ORG_ID` also works in the default mode, to choose the organization for a user who belongs to
several; without it the user's own organization is used.

## Credential troubleshooting

| Symptom | Likely cause | Corrective action |
| --- | --- | --- |
| `Anypoint Connect is not configured` | The active profile cannot resolve both ID and Secret | Run `anc config init`, then `anc config show` |
| Browser reports an invalid redirect | The app URI differs by scheme, port, path, or slash | Set it exactly to `http://localhost:3000/api/callback` |
| Browser cannot return to the CLI | Port 3000 is occupied or loopback traffic is blocked | Stop the conflicting local process and retry |
| Authorization is refused by policy | The organization restricts Connected Apps | Ask an administrator to review or allowlist the internal app |
| Login works but an operation returns 403 | The user lacks a platform permission or entitlement | Check [Access readiness](readiness.md); logging in again does not add permission |
| Refresh repeatedly fails after rotation | Saved app secret or authorization is stale | Re-run `anc config init`, then `anc auth login` |
| `needs an explicit organization` | A service mode is set without `ANYPOINT_ORG_ID` | Set `ANYPOINT_ORG_ID` or `anc config set orgId <id>` |
| `Service token request failed (HTTP 401)` | The Connected App credentials are wrong, or the app is not valid for client credentials | Check the Client ID and Secret and that the app acts on its own behalf |
| `The bearer token was rejected` | The supplied token expired or is invalid | Supply a new `ANYPOINT_ACCESS_TOKEN` |
