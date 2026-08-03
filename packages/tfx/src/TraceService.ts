import * as Effect from 'effect/Effect';

export const traceService = <Service extends object>(
	prefix: string,
	service: Service,
): Service => {
	Object.assign(
		service,
		Object.fromEntries(
			Object.entries(service).map(([method, operation]) => [
				method,
				typeof operation === 'function'
					? (...args: Array<never>) =>
							operation(...args).pipe(Effect.withSpan(`${prefix}.${method}`))
					: operation,
			]),
		),
	);

	return service;
};
