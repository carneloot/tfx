import { defaults, type Options } from '../Options.js';
import { composed, identifier, type Identifier } from './Identifiers.js';
export interface Tables {
	readonly schema: Identifier;
	readonly conversations: Identifier;
	readonly jobs: Identifier;
	readonly jobAttempts: Identifier;
	readonly deduplication: Identifier;
	readonly activeConflictIndex: Identifier;
}
export const make = (options: Options = {}): Tables => {
	const schema = identifier(options.schema ?? defaults.schema, 'schema');
	const prefix = identifier(
		options.tablePrefix ?? defaults.tablePrefix,
		'tablePrefix',
	);
	return Object.freeze({
		schema,
		conversations: composed(prefix, 'conversations'),
		jobs: composed(prefix, 'jobs'),
		jobAttempts: composed(prefix, 'job_attempts'),
		deduplication: composed(prefix, 'update_deduplication'),
		activeConflictIndex: composed(prefix, 'jobs_active_conflict_idx'),
	});
};
