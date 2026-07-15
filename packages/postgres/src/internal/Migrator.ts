import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';

import type { Options } from '../Options.js';
import { up } from './Migration0001.js';
import { make } from './Tables.js';
export const migrate = (options: Options = {}) =>
	Effect.flatMap(PgClient.PgClient, (sql) =>
		sql.withTransaction(up(sql, make(options))),
	).pipe(Effect.asVoid);
