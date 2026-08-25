import { AnypointClient } from '@sfdxy/anypoint-connect';

const requiredVariables = ['ANYPOINT_CLIENT_ID', 'ANYPOINT_CLIENT_SECRET'];
for (const variable of requiredVariables) {
    const value = process.env[variable];
    if (!value || value.startsWith('YOUR_')) {
        throw new Error(`Set ${variable} in a local .env file before running this example.`);
    }
}

const profileName = process.env.ANYPOINT_PROFILE || 'default';
const environmentName = process.env.ANYPOINT_ENV || 'Sandbox';

const client = new AnypointClient({
    clientId: process.env.ANYPOINT_CLIENT_ID,
    clientSecret: process.env.ANYPOINT_CLIENT_SECRET,
    profileName,
});

const identity = await client.whoami();
const environments = await client.accessManagement.getEnvironments(identity.organization.id);
const environment = environments.find((candidate) => candidate.name === environmentName);

if (!environment) {
    const visibleNames = environments.map((candidate) => candidate.name).sort();
    throw new Error(
        `Environment "${environmentName}" is not visible. Available environments: ${visibleNames.join(', ') || '(none)'}`,
    );
}

const applications = await client.cloudHub2.getDeployments(identity.organization.id, environment.id);

console.log(`Authenticated profile: ${profileName}`);
console.log(`Environment: ${environmentName}`);
console.log(`Applications visible: ${applications.length}`);

for (const application of applications) {
    console.log(`- ${application.name} (${application.status})`);
}
