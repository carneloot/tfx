import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { LegacyImportError } from './LegacyImportError.js';
import type { LegacySnapshot } from './LegacySchemas.js';

export interface LegacySourceService {
	readonly readSnapshot: Effect.Effect<LegacySnapshot, LegacyImportError>;
}
export class LegacySource extends Context.Service<
	LegacySource,
	LegacySourceService
>()('carneloot/LegacySource') {}
