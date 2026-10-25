import * as Cloudflare from '@alchemy.run/cloudflare';

/** Declares the hosting resources; credentials and the SQL origin remain application-owned. */
export const worker = <const Env extends Cloudflare.WorkerBindingProps>(
	id: string,
	options: { readonly main: string; readonly env: Env },
) =>
	Cloudflare.Worker(id, {
		main: options.main,
		compatibility: { date: '2026-07-30', flags: ['nodejs_compat'] },
		// Recovery only. Native alarms normally execute schedules at their deadline.
		crons: ['*/5 * * * *'],
		limits: { cpuMs: 30_000 },
		env: {
			...options.env,
			CHAT_DISPATCH: Cloudflare.DurableObject('ChatDispatch'),
			JOB_WAKEUP: Cloudflare.DurableObject('JobWakeup'),
		},
	});
