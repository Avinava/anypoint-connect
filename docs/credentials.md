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

Environment variables change where the app credentials come from; they do not remove the browser
authorization step or create an OAuth token.

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

This release implements the user Authorization Code flow, not the `client_credentials` grant. Supplying
only `ANYPOINT_CLIENT_ID` and `ANYPOINT_CLIENT_SECRET` to a new CI runner is therefore insufficient: the
runner has no authorized OAuth session, and the machine-bound token file is not a supported secret to
copy between hosts.

Use the CLI, MCP server, and library with a locally authorized profile. Treat true service-account CI
authentication as unsupported until a dedicated client-credentials mode is added and tested.

## Credential troubleshooting

| Symptom | Likely cause | Corrective action |
| --- | --- | --- |
| `Anypoint Connect is not configured` | The active profile cannot resolve both ID and Secret | Run `anc config init`, then `anc config show` |
| Browser reports an invalid redirect | The app URI differs by scheme, port, path, or slash | Set it exactly to `http://localhost:3000/api/callback` |
| Browser cannot return to the CLI | Port 3000 is occupied or loopback traffic is blocked | Stop the conflicting local process and retry |
| Authorization is refused by policy | The organization restricts Connected Apps | Ask an administrator to review or allowlist the internal app |
| Login works but an operation returns 403 | The user lacks a platform permission or entitlement | Check [Access readiness](readiness.md); logging in again does not add permission |
| Refresh repeatedly fails after rotation | Saved app secret or authorization is stale | Re-run `anc config init`, then `anc auth login` |
