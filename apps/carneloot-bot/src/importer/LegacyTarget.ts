import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type { LegacyImportError } from './LegacyImportError.js';
import type { MappedLegacy } from './LegacyMapping.js';
export interface PromotionResult {
	readonly inserted: Readonly<Record<string, number>>;
	readonly existing: Readonly<Record<string, number>>;
}
export interface LegacyTargetService {
	readonly promote: (
		mapped: MappedLegacy,
	) => Effect.Effect<PromotionResult, LegacyImportError>;
}
export class LegacyTarget extends Context.Service<
	LegacyTarget,
	LegacyTargetService
>()('carneloot/LegacyTarget') {}
