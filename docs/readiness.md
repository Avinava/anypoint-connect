# Access readiness

Almost every failure people hit with this tool is an access problem, and the fixes are all different. A
missing Connected App, an expired token, an environment in another business group, and a scope you were
never granted all produce "it does not work" — but only one of them is fixed by logging in again.

These are the six states, named the same way the
[`mule-skills`](https://avinava.github.io/mule-skills/anypoint-access/) workflows name them, so a human
reading this page and an agent following that gate describe the same situation with the same words.

## The states

| State | What you see | Fix |
| --- | --- | --- |
| Ready | `whoami` returns an identity, and the environment you want appears in `list_environments` | Nothing. Proceed |
| Not configured | `Anypoint Connect is not configured (profile: "…")`, with the `config init` command echoed | Run `anc config init`, or export `ANYPOINT_CLIENT_ID` and `ANYPOINT_CLIENT_SECRET`. There is nothing to log in to yet |
| Not authenticated | `Not authenticated. Run: anc auth login`, or a token that expired with no refresh token, or a refresh that failed | `anc auth login`, then `anc auth status` |
| Environment not visible | `Environment "X" not found. Available: …` | The name is misspelled, or you are authenticated against a different organization or business group. Check `anc config show` and the available list before assuming a permission problem |
| Not permitted | A 403, or an operation refused despite valid authentication | The Connected App lacks that scope, or the subscription lacks the feature. Grant the scope in Access Management, or use `get_entitlements` to check whether the org has MQ or Object Store at all |
| Transient failure | Timeout, rate limit, or a 5xx | Retry once with a narrower window. Requests are rate-limited client-side, but the platform can still throttle |

## Confirming state before you work

Two cheap read-only calls establish everything, and they are the same ones the agent workflows use:

```bash
anc auth status
anc apps list --env Sandbox
```

From an MCP client, the equivalents are `whoami` and `list_environments`. `whoami` confirms
authentication and returns the organization context other calls need; `list_environments` confirms the
target environment is actually visible to that identity.

Never use a data call as the readiness check. An empty log result cannot distinguish "no errors in the
window" from "not authenticated", and a permission error on one narrow query says nothing about the rest
of the environment.

## Not configured versus not authenticated

These are the two most often confused, and the error text distinguishes them deliberately:

- **Not configured** means no Client ID and Secret are resolvable for the active profile. The tool has
  no idea who you are and no way to ask. Nothing to refresh.
- **Not authenticated** means credentials exist but there is no usable token. A browser login fixes it.

Telling someone to log in when they never created a Connected App wastes the exchange, which is why the
messages differ.

## Entitlements are not permissions

`get_entitlements` reports what the organization's subscription includes — vCores, Anypoint MQ, Object
Store, API quotas. A capability the subscription does not include cannot be granted by a scope. Check
entitlements before concluding that a queue or Object Store tool is broken; a 403 on an unprovisioned
service is the platform being correct.

## For agents

If you are driving this server from an agent, gate on readiness before the first call rather than
reacting to a mid-workflow failure. The
[`mule-skills` readiness reference](https://github.com/Avinava/mule-skills/blob/main/skills/mule-ops/references/anypoint-readiness.md)
defines that gate, including what to offer a user when access is missing and how to label evidence they
supply by hand instead.

Two rules worth repeating here:

- **Never run `config init`, `auth login`, `auth logout`, or a profile switch without explicit
  approval.** They change machine-local state. Print the command instead.
- **Never report the organization name, organization identifier, user name, email, or profile
  identifier.** Say "the authorized environment" and name the environment only as the user named it.
