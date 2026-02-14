import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['src/cli.ts', 'src/mcp.ts', 'src/index.ts', 'src/**/index.ts'],
        },
    },
});
