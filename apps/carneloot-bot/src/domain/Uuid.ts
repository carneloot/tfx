import * as Schema from 'effect/Schema';

const nilUuid = '00000000-0000-0000-0000-000000000000';
const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export const Uuid = Schema.String.check(
	Schema.isUUID(),
	Schema.makeFilter(
		(value) => {
			const normalized = value.toLowerCase();
			return normalized !== nilUuid && normalized !== maxUuid;
		},
		{ message: 'Expected a non-sentinel UUID' },
	),
);
