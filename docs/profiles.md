# Profiles and multiple orgs

A profile is a named set of credentials and tokens. One organization needs only the `default` profile;
consultants and platform teams working across several want one profile per organization, bound per
project directory so the right one is used without a flag.

## Create and authenticate

```bash
anc config init --profile org-a
anc config init --profile org-b

anc auth login --profile org-a
anc auth login --profile org-b
```

Use neutral local names such as `org-a` rather than a customer name. The profile identifier shows up in
local files and can end up in a screenshot or a support thread.

## Bind a directory to a profile

```bash
cd ~/projects/org-a-integrations
anc config use org-a
```

That writes `.anypoint-connect.json` containing `{ "profile": "org-a" }`. Every command run in that
directory or below now uses `org-a` with no flag. The file binds a machine-local profile name; it stores
no credentials. Add it to `.gitignore` anyway, because a profile name can reveal customer labeling:

```gitignore
.anypoint-connect.json
```

## Managing configuration

```bash
anc config show                      # secrets masked
anc config show --profile org-a
anc config set defaultEnv Production
anc config profiles                  # list all profiles
anc config path                      # where files live

ANYPOINT_PROFILE=org-b anc apps list --env Sandbox   # one-off override
```

## Resolution order

A profile is resolved first, then credentials within it.

**Profile**, highest priority first:

| Priority | Source | Example |
| --- | --- | --- |
| 1 | `--profile` on auth/config commands | `anc auth status --profile org-a` |
| 2 | `ANYPOINT_PROFILE` | `export ANYPOINT_PROFILE=org-a` |
| 3 | `.anypoint-connect.json` in the project, walking up from the working directory | `{ "profile": "org-a" }` |
| 4 | Fallback | `default` |

Operational commands do not expose a `--profile` option. For a one-off operational override, set
`ANYPOINT_PROFILE` for that process; for day-to-day work, bind the project directory with
`anc config use <profile>`.

**Credentials** within that profile, highest priority first:

| Priority | Source | When it applies |
| --- | --- | --- |
| 1 | Environment variables | CI, containers, per-session overrides |
| 2 | Profile `config.json` | Day-to-day development |
| 3 | `.env` in the working directory | Legacy project-local fallback |

The most common surprise is an environment variable left exported in a shell, silently overriding the
profile you thought you selected. `anc config show` reports the resolved source, so check there first
when a command hits the wrong organization.

## Storage layout

```text
~/.anypoint-connect/
└── profiles/
    ├── default/
    │   ├── config.json     OAuth credentials (chmod 600)
    │   └── tokens.enc      AES-256-GCM encrypted tokens
    └── org-a/
        ├── config.json
        └── tokens.enc
```

## Profiles and MCP

The MCP server resolves the active profile the same way, from `.anypoint-connect.json` in the project or
`default`, so no `env` block is needed in host configuration. Two tools expose this to an agent:
`get_project_profile` reports the active profile and where it came from, and `set_project_profile` binds
a directory.

An agent should not switch profiles on its own initiative — it changes which organization subsequent
calls hit. Treat it as an operation you authorize explicitly, and do not have an agent report the
organization name in a document meant to be shared.
