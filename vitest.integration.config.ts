import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export const postgresIntegrationSuites = [
	'packages/postgres/test/Migrations.integration.test.ts',
	'packages/postgres/test/ConversationStorage.integration.test.ts',
	'packages/postgres/test/JobStore.integration.test.ts',
	'packages/postgres/test/Deduplicator.integration.test.ts',
	'packages/postgres/test/Layers.integration.test.ts',
] as const;

export const assertPostgresIntegrationSuites = (
	exists: (path: string) => boolean = existsSync,
): void => {
	const missing = postgresIntegrationSuites.filter((path) => !exists(path));
	if (missing.length > 0) {
		throw new Error(
			`Missing required PostgreSQL integration suites:\n${missing.join('\n')}`,
		);
	}
};

export const assertPostgresIntegrationSuiteSetWhenPresent = (
	exists: (path: string) => boolean = existsSync,
): void => {
	if (postgresIntegrationSuites.some(exists)) {
		assertPostgresIntegrationSuites(exists);
	}
};

if (process.env.TFX_REQUIRE_POSTGRES_INTEGRATION_SUITES === '1') {
	assertPostgresIntegrationSuites();
} else {
	assertPostgresIntegrationSuiteSetWhenPresent();
}

export default defineConfig({
	test: {
		include: [
			'packages/postgres/test/integration-config.test.ts',
			...postgresIntegrationSuites,
			'apps/**/*.integration.test.ts',
			'apps/**/*.e2e.test.ts',
		],
		passWithNoTests: false,
	},
});
