import type * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import type { Tables } from '../src/internal/Tables.js';
export declare const up: (
	sql: PgClient.PgClient,
	tables: Tables,
) => Effect.Effect<
	void,
	import('effect/unstable/sql/SqlError').SqlError,
	never
>;
//# sourceMappingURL=0001_tfx_core.d.ts.map
