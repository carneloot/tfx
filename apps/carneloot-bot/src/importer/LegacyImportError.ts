import * as Schema from 'effect/Schema';

export class LegacyImportError extends Schema.TaggedErrorClass<LegacyImportError>()(
	'LegacyImportError',
	{
		reason: Schema.Literals([
			'InvalidConfiguration',
			'SourceUnavailable',
			'InvalidSource',
			'Blocked',
			'TargetUnavailable',
			'ReminderRebuildFailed',
		]),
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {}
