import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	migration0001Checksum,
	migration0001Sql,
} from '../src/postgres/Migration0001Sql.js';
import {
	migration0002Checksum,
	migration0002Sql,
} from '../src/postgres/Migration0002Sql.js';
import {
	migration0003Checksum,
	migration0003Sql,
} from '../src/postgres/Migration0003Sql.js';
import {
	migration0004Checksum,
	migration0004Sql,
} from '../src/postgres/Migration0004Sql.js';
import {
	migration0005Checksum,
	migration0005Sql,
} from '../src/postgres/Migration0005Sql.js';
import {
	migration0006Checksum,
	migration0006Sql,
} from '../src/postgres/Migration0006Sql.js';
import {
	migration0007Checksum,
	migration0007Sql,
} from '../src/postgres/Migration0007Sql.js';
import {
	migration0008Checksum,
	migration0008Sql,
} from '../src/postgres/Migration0008Sql.js';

describe('application migration artifacts', () => {
	it.each([
		['0001_identity_pets.sql', migration0001Sql, migration0001Checksum],
		['0002_pet_food.sql', migration0002Sql, migration0002Checksum],
		[
			'0003_pet_food_source_constraints.sql',
			migration0003Sql,
			migration0003Checksum,
		],
		['0004_notifications.sql', migration0004Sql, migration0004Checksum],
		[
			'0005_unreachable_notification_deliveries.sql',
			migration0005Sql,
			migration0005Checksum,
		],
		['0006_pet_caregivers.sql', migration0006Sql, migration0006Checksum],
		[
			'0007_notification_recipient_freeze.sql',
			migration0007Sql,
			migration0007Checksum,
		],
		['0008_food_reply_operations.sql', migration0008Sql, migration0008Checksum],
	] as const)(
		'matches committed %s bytes and SHA-256',
		(file, sql, checksum) => {
			const source = readFileSync(
				new URL(`../migrations/${file}`, import.meta.url),
				'utf8',
			);
			expect(sql).toBe(source);
			expect(createHash('sha256').update(source).digest('hex')).toBe(checksum);
		},
	);

	it('defines frozen-recipient and food timestamp metadata', () => {
		expect(migration0007Sql).toContain(
			'ADD COLUMN recipients_materialized_at timestamptz',
		);
		expect(migration0007Sql).toContain(
			'ADD COLUMN food_timestamp_explicit boolean NOT NULL DEFAULT false',
		);
		expect(migration0007Sql).toContain(
			"food_timestamp_explicit = false OR kind = 'food-added'",
		);
	});

	it('defines durable reply replay and exact source-message lookup', () => {
		expect(migration0008Sql).toContain(
			'CONSTRAINT food_reply_operations_pk PRIMARY KEY (bot_id, update_id)',
		);
		expect(migration0008Sql).toContain(
			'update_id >= 0 AND update_id <= 9007199254740991',
		);
		expect(migration0008Sql).toContain(
			'(source_bot_id, source_message_chat_id, source_message_id)',
		);
	});

	it('defines caregiver relationship integrity and lookup index', () => {
		expect(migration0006Sql).toContain(
			'CONSTRAINT pet_caregivers_pk PRIMARY KEY (pet_id, caregiver_user_id)',
		);
		expect(migration0006Sql).toContain(
			"CHECK (status IN ('pending', 'accepted', 'rejected'))",
		);
		expect(migration0006Sql).toMatch(
			/FOREIGN KEY \(pet_id\)\s+REFERENCES carneloot\.pets\(id\) ON DELETE CASCADE/u,
		);
		expect(migration0006Sql).toMatch(
			/FOREIGN KEY \(caregiver_user_id\)\s+REFERENCES carneloot\.users\(id\) ON DELETE RESTRICT/u,
		);
		expect(migration0006Sql).toContain('created_at timestamptz NOT NULL');
		expect(migration0006Sql).toContain('updated_at timestamptz NOT NULL');
		expect(migration0006Sql).toMatch(
			/CREATE INDEX pet_caregivers_user_status_pet_idx\s+ON carneloot\.pet_caregivers \(caregiver_user_id, status, pet_id\)/u,
		);
	});
});
