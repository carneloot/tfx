import * as HttpApi from 'effect/http-api/HttpApi';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as Schema from 'effect/Schema';

import {
	ExternalNotificationInput,
	ExternalNotificationResult,
	InitialNotificationPersistenceUnavailable,
	InvalidApiKey,
	InvalidRenderedNotification,
	MissingTemplateVariables,
	TemplateNotFound,
} from '../domain/notifications/ExternalNotification.js';

const outcome = <S extends ExternalNotificationResult['status']>(
	status: S,
	code: number,
) =>
	Schema.Struct({
		...ExternalNotificationResult.fields,
		status: Schema.Literal(status),
	}).pipe(HttpApiSchema.status(code));

export const Api = HttpApi.make('carneloot').add(
	HttpApiGroup.make('notifications').add(
		HttpApiEndpoint.post('notify', '/api/notify', {
			payload: ExternalNotificationInput,
			success: [
				outcome('sent', 200),
				outcome('partial', 207),
				outcome('failed', 502),
				outcome('indeterminate', 202),
			],
			error: [
				InvalidApiKey.pipe(HttpApiSchema.status(404)),
				TemplateNotFound.pipe(HttpApiSchema.status(404)),
				MissingTemplateVariables.pipe(HttpApiSchema.status(422)),
				InvalidRenderedNotification.pipe(HttpApiSchema.status(422)),
				InitialNotificationPersistenceUnavailable.pipe(
					HttpApiSchema.status(503),
				),
			],
		}),
	),
);
