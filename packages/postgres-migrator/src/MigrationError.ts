import * as Data from 'effect/Data';

export type MigrationStage =
	| 'manifest_validation'
	| 'bootstrap'
	| 'ledger_validation'
	| 'apply'
	| 'transaction';

export class MigrationError extends Data.TaggedError('MigrationError')<{
	readonly stage: MigrationStage;
	readonly message: string;
	readonly cause?: unknown;
	readonly version?: number;
	readonly migrationName?: string;
}> {}
