import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

export interface LegacyImportConfigService {
	readonly sourceUrl: string;
	readonly sourceAuthToken?: Redacted.Redacted<string>;
	readonly sourceId: string;
	readonly databaseUrl?: Redacted.Redacted<string>;
	readonly botId: string;
	readonly dryRun: boolean;
	readonly reportPath?: string;
}
export class LegacyImportConfig extends Context.Service<
	LegacyImportConfig,
	LegacyImportConfigService
>()('carneloot/LegacyImportConfig') {}

export const load = Effect.map(
	Config.all({
		sourceUrl: Config.String('LEGACY_DATABASE_URL'),
		sourceAuthToken: Config.option(
			Config.Redacted('LEGACY_DATABASE_AUTH_TOKEN'),
		),
		sourceId: Config.String('LEGACY_SOURCE_ID'),
		databaseUrl: Config.Redacted('DATABASE_URL'),
		botId: Config.String('BOT_ID'),
	}),
	(value): LegacyImportConfigService => ({
		sourceUrl: value.sourceUrl,
		sourceId: value.sourceId,
		databaseUrl: value.databaseUrl,
		botId: value.botId,
		...(value.sourceAuthToken._tag === 'Some'
			? { sourceAuthToken: value.sourceAuthToken.value }
			: {}),
		dryRun: false,
	}),
);
export const layer = Layer.effect(LegacyImportConfig, load);
export const layerFrom = (config: LegacyImportConfigService) =>
	Layer.succeed(LegacyImportConfig, config);
