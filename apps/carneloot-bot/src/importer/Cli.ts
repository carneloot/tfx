import * as Redacted from 'effect/Redacted';

import type { LegacyImportConfigService } from './LegacyImportConfig.js';
export class CliError extends Error {
	constructor(
		readonly exitCode: 0 | 2,
		message: string,
	) {
		super(message);
	}
}
export const help = `Usage: import:legacy [options]\n  --source-url <url>\n  --source-auth-token <token>\n  --source-id <id>\n  --bot-id <id>\n  --database-url <url>\n  --dry-run\n  --report <path>\n  --help`;
export const parseArgs = (
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string | undefined>> = process.env,
): LegacyImportConfigService => {
	const values: Record<string, string | boolean | undefined> = {
		sourceUrl: env.LEGACY_DATABASE_URL,
		sourceAuthToken: env.LEGACY_DATABASE_AUTH_TOKEN,
		sourceId: env.LEGACY_SOURCE_ID,
		botId: env.BOT_ID,
		databaseUrl: env.DATABASE_URL,
		dryRun: false,
	};
	const names: Record<string, string> = {
		'--source-url': 'sourceUrl',
		'--source-auth-token': 'sourceAuthToken',
		'--source-id': 'sourceId',
		'--bot-id': 'botId',
		'--database-url': 'databaseUrl',
		'--report': 'reportPath',
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === '--help') throw new CliError(0, help);
		if (arg === '--dry-run') {
			values.dryRun = true;
			continue;
		}
		const key = names[arg];
		if (!key) throw new CliError(2, `Unknown option: ${arg}`);
		const value = args[++i];
		if (!value || value.startsWith('--'))
			throw new CliError(2, `Missing value for ${arg}`);
		values[key] = value;
	}
	for (const [key, label] of [
		['sourceUrl', 'LEGACY_DATABASE_URL'],
		['sourceId', 'LEGACY_SOURCE_ID'],
		['botId', 'BOT_ID'],
		['databaseUrl', 'DATABASE_URL'],
	] as const)
		if (typeof values[key] !== 'string' || !String(values[key]).trim())
			throw new CliError(2, `${label} is required`);
	return {
		sourceUrl: String(values.sourceUrl),
		...(values.sourceAuthToken
			? { sourceAuthToken: Redacted.make(String(values.sourceAuthToken)) }
			: {}),
		sourceId: String(values.sourceId),
		botId: String(values.botId),
		databaseUrl: Redacted.make(String(values.databaseUrl)),
		dryRun: Boolean(values.dryRun),
		...(values.reportPath ? { reportPath: String(values.reportPath) } : {}),
	};
};
