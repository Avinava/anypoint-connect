# Library API

The same client the CLI and MCP server use is exported for direct use in TypeScript or JavaScript.

```typescript
import { AnypointClient } from '@sfdxy/anypoint-connect';

const client = new AnypointClient({
  clientId: process.env.ANYPOINT_CLIENT_ID!,
  clientSecret: process.env.ANYPOINT_CLIENT_SECRET!,
});

// identity and organization context
const me = await client.whoami();
const orgId = me.organization.id;

// environments, then apps in one of them
const envs = await client.accessManagement.getEnvironments(orgId);
const sandbox = envs.find((e) => e.name === 'Sandbox')!;
const apps = await client.cloudHub2.getDeployments(orgId, sandbox.id);
```

## Streaming logs

`tailLogs` is an async iterable, so backpressure is the consumer's loop rather than a callback queue:

```typescript
for await (const entries of client.logs.tailLogs(orgId, sandbox.id, 'my-api')) {
  entries.forEach((e) => console.log(`[${e.priority}] ${e.message}`));
}
```

## Metrics

```typescript
const metrics = await client.monitoring.getAppMetrics(
  orgId,
  sandbox.id,
  Date.now() - 24 * 60 * 60 * 1000,
  Date.now()
);
```

## Design Center round trip

```typescript
const projects = await client.designCenter.getProjects(orgId);
const spec = await client.designCenter.getFileContent(orgId, projects[0].id, 'api.raml');

await client.designCenter.updateFile(orgId, projects[0].id, 'api.raml', updatedContent);
await client.designCenter.publishToExchange(orgId, projects[0].id, {
  name: 'My API',
  apiVersion: 'v1',
  version: '1.0.0',
  classifier: 'raml',
});
```

## What you inherit, and what you do not

Using the client directly still gives you bearer-token injection, automatic refresh, rate limiting, and
the response cache — those live below the facade.

What you do not get automatically are the confirmation gates. The dry-run-by-default behavior described in
the [safety model](safety.md) is enforced by the MCP tool layer and the CLI, not by the API clients. If you
call `cloudHub2` methods yourself, you own the guard rails: check `get_deployment_spec` equivalents before
mutating, and do not let a script delete by name without binding to a deployment ID.

Credentials come from the constructor or the environment. For interactive use, prefer the stored profile
via the CLI rather than passing secrets around in code — see [Profiles](profiles.md).
