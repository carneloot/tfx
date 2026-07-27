/* eslint-disable @typescript-eslint/consistent-type-assertions */
export const legacyTables = [
	'users',
	'pets',
	'pet_carers',
	'pet_food',
	'configs',
	'api_keys',
	'notifications',
	'users_to_notify',
	'notification_history',
	'sessions',
] as const;
export type LegacyTable = (typeof legacyTables)[number];
export type LegacyRow = Readonly<Record<string, unknown>>;
export type LegacySnapshot = {
	readonly [K in LegacyTable]: ReadonlyArray<LegacyRow>;
};

export interface DecodeIssue {
	readonly table: LegacyTable;
	readonly sourceKey: string;
	readonly path: string;
	readonly message: string;
}
const text = (row: LegacyRow, key: string, nullable = false) => {
	const value = row[key];
	if (nullable && value === null) return;
	if (typeof value !== 'string' || value.length === 0)
		throw new Error(`${key}: expected non-empty string`);
};
const integer = (row: LegacyRow, key: string, nullable = false) => {
	const value = row[key];
	if (nullable && value === null) return;
	const number = typeof value === 'bigint' ? Number(value) : value;
	if (typeof number !== 'number' || !Number.isSafeInteger(number))
		throw new Error(`${key}: expected safe integer`);
};
export const sourceKey = (row: LegacyRow) =>
	typeof row.id === 'string' && row.id ? row.id : '<unknown>';
export const decodeLegacyRow = (
	table: LegacyTable,
	input: unknown,
): LegacyRow => {
	if (typeof input !== 'object' || input === null || Array.isArray(input))
		throw new Error('row: expected object');
	const row = input as LegacyRow;
	text(row, 'id');
	switch (table) {
		case 'users':
			text(row, 'telegram_id');
			text(row, 'username', true);
			text(row, 'first_name');
			text(row, 'last_name', true);
			break;
		case 'pets':
			text(row, 'name');
			text(row, 'owner_id');
			break;
		case 'pet_carers':
			text(row, 'pet_id');
			text(row, 'carer_id');
			if (!['pending', 'accepted', 'rejected'].includes(String(row.status)))
				throw new Error('status: invalid literal');
			break;
		case 'pet_food':
			text(row, 'pet_id');
			text(row, 'user_id');
			integer(row, 'message_id', true);
			if (typeof row.quantity !== 'number' || !Number.isFinite(row.quantity))
				throw new Error('quantity: expected finite number');
			integer(row, 'time');
			break;
		case 'configs':
			text(row, 'context');
			text(row, 'key', true);
			try {
				if (typeof row.value === 'string') JSON.parse(row.value);
			} catch {
				throw new Error('value: invalid JSON');
			}
			break;
		case 'api_keys':
			text(row, 'user_id');
			text(row, 'key');
			integer(row, 'created_at');
			break;
		case 'notifications':
			text(row, 'keyword');
			text(row, 'message');
			text(row, 'owner_id');
			break;
		case 'users_to_notify':
			text(row, 'notification_id');
			text(row, 'user_id');
			break;
		case 'notification_history':
			text(row, 'notification_id', true);
			text(row, 'pet_id', true);
			text(row, 'user_id');
			integer(row, 'message_id');
			integer(row, 'sent_at');
			break;
		case 'sessions':
			text(row, 'context');
			text(row, 'key');
			break;
	}
	return Object.freeze({ ...row });
};
export const decodeSnapshot = (raw: LegacySnapshot) => {
	const snapshot = Object.fromEntries(
		legacyTables.map((table) => [table, []]),
	) as unknown as Record<LegacyTable, LegacyRow[]>;
	const issues: DecodeIssue[] = [];
	for (const table of legacyTables)
		for (const row of raw[table] ?? []) {
			try {
				snapshot[table].push(decodeLegacyRow(table, row));
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : 'invalid row';
				issues.push({
					table,
					sourceKey: sourceKey(row),
					path: message.split(':')[0] ?? 'row',
					message,
				});
			}
		}
	return { snapshot: snapshot as LegacySnapshot, issues };
};
