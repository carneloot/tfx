import { Redacted } from 'effect';
import { describe, expect, it } from 'vitest';

import { CliError, parseArgs } from '../../src/importer/Cli.js';
describe('legacy importer CLI', () => {
	it('parses overrides and redacts secrets', () => {
		const result = parseArgs(
			[
				'--source-url',
				'file:test.db',
				'--source-id',
				'fixture',
				'--bot-id',
				'carneloot',
				'--database-url',
				'postgres://secret',
				'--source-auth-token',
				'token',
				'--dry-run',
				'--report',
				'out.json',
			],
			{},
		);
		expect(result.dryRun).toBe(true);
		expect(result.reportPath).toBe('out.json');
		expect(String(result.databaseUrl)).not.toContain('secret');
		expect(Redacted.value(result.sourceAuthToken!)).toBe('token');
	});
	it('rejects unknown and missing flags', () => {
		expect(() => parseArgs(['--wat'], {})).toThrow(CliError);
		expect(() => parseArgs(['--source-url'], {})).toThrow('Missing value');
	});
});
