import { defaults, type Options } from '../Options.js';
import { composed, identifier, type Identifier } from './Identifiers.js';
export interface Tables {
	readonly schema: Identifier;
	readonly migrations: Identifier;
	readonly conversations: Identifier;
	readonly jobs: Identifier;
	readonly jobAttempts: Identifier;
	readonly deduplication: Identifier;
	readonly activeConflictIndex: Identifier;
	readonly dedupOutcomeConstraint: Identifier;
	readonly jobStateConstraint: Identifier;
}
export const make = (options: Options = {}): Tables => {
	const schema = identifier(options.schema ?? defaults.schema, 'schema');
	const prefix = identifier(
		options.tablePrefix ?? defaults.tablePrefix,
		'tablePrefix',
	);
	return Object.freeze({
		schema,
		migrations: composed(prefix, 'migrations'),
		conversations: composed(prefix, 'conversations'),
		jobs: composed(prefix, 'jobs'),
		jobAttempts: composed(prefix, 'job_attempts'),
		deduplication: composed(prefix, 'update_deduplication'),
		activeConflictIndex: composed(prefix, 'jobs_active_conflict_idx'),
		dedupOutcomeConstraint: composed(prefix, 'dedup_outcome_chk'),
		jobStateConstraint: composed(prefix, 'jobs_state_chk'),
	});
};
