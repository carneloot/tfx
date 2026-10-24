# Carneloot on Cloudflare

Carneloot retains PostgreSQL as the source of truth. Alchemy v2 declares a Worker, a Hyperdrive connection with caching disabled, a `ChatDispatch` Durable Object namespace, and a minute cron. The database itself remains externally managed.

## Webhook lifetime and ordering

The public Worker checks Telegram's secret header before decoding at most 1 MiB of JSON with the generated `Update` schema. It routes accepted updates through `Partitioning.byChat(UpdateRoutingScope.fromUpdate(...))`, exactly like the polling runtime. This includes chat, user-only, business-connection, and update-only fallback identities.

Each Durable Object holds `blockConcurrencyWhile` across dispatch **and scoped cleanup**. SQL remains authoritative; the object stores no conversation or domain data. Distinct inputs in one partition cannot overtake an accepted input during its asynchronous database or Telegram work. Different partitions can execute concurrently.

This preserves arrival order at the object, not numerical `update_id` order. The registration command enforces `max_connections=1` to limit upstream reordering. Telegram retries and network delays can still change arrival order before the object receives an update. No transport can infer the intended order of an input that has not arrived. A platform crash can interrupt an update between a committed mutation and storing its dispatch outcome, just as a polling-process crash can. This migration does not claim exactly-once processing across that window.

The internal object request does not inherit the public caller's abort signal. After acceptance, a disconnect cannot abandon dispatch while a later request uses the same graph. Telegram operations have a whole-operation 5-second timeout, including response decoding. Dispatch has a 10-second deadline, leaving 20 seconds before Cloudflare's 30-second `blockConcurrencyWhile` limit for cancellation, rollback, deduplication finalization, and pool closure. Cleanup is awaited, not detached. A platform reset or unavailable database can still prevent cleanup from finishing; SQL leases, fencing, and transactions remain necessary.

The Worker returns HTTP 200 only for existing acknowledgeable `DispatchOutcome`s: `Handled`, `HandledWithOutputFailure`, or `PermanentInvalid`. Retryable failures, fatal outcomes, defects, and whole-dispatch deadlines return 503. It does not turn a generic timeout into success. The existing router distinguishes committed conversation output failures from processing failures. A completed duplicate returns its stored outcome without repeating output.

## Transactions and replay

`BotRuntime.dispatch` reuses the polling runtime's durable claim, heartbeat, completion, and release protocol. It starts neither polling nor a keyed executor; the Durable Object supplies transport serialization.

Each invocation builds and closes one scoped SQL pool through Hyperdrive with `prepare:false`. No pool crosses Worker events. `TfxPostgres.servicesLayer` and `RepositoriesLive.repositoriesLayer` acquire repositories without migrations. The graph includes `JobRuntime`, but no `BotRuntime` source or continuous `JobWorker` fiber. Explicit operator commands apply migrations before cutover.

SQL conversation locks, instance/revision checks, and the domain transaction adapter coordinate conversation state with domain changes. Pet mutations recheck owner or caregiver access inside their transaction. Food replay identity stays `(botId, updateId, petId)`, so one update can feed several pets. Food timestamps stay anchored to Telegram's message date, not Worker processing time. These checks are still required across different chat objects that mutate the same pet.

## Reminder timing changes

PostgreSQL jobs, leases, retries, and notification-delivery state remain unchanged. Cron replaces continuous polling with a bounded wakeup: recover expired `sending` deliveries, then run at most 50 jobs or reach the 40-second deadline. Overlapping cron invocations use existing SQL claim fencing.

Reminders now normally wait until the next minute tick, plus processing time. A backlog can add further minute-sized delays because each pass is bounded. Platform cron delays and outages can add more; there is no sub-minute delivery guarantee. Recovery runs on cron rather than process startup. A deadline-interrupted job keeps its lease until expiry and becomes eligible for a later pass.

Telegram sends are not blindly retried. Existing definitive failure policy remains in the notification dispatcher. Ambiguous network failures, decode failures, and expired `sending` leases become terminal `unknown`, not a resend request. Operators must reconcile those deliveries before taking manual action.

## Validation boundary

The integration suite bundles the production entrypoint and runs native Worker requests, Durable Objects, Hyperdrive's local TCP binding, and scheduled events in workerd against real PostgreSQL. Only outgoing Telegram HTTP is mocked. Local Hyperdrive emulation proves wire-driver compatibility, not connectivity, TLS, or permissions of a live Cloudflare origin. Those require an approved staging deployment.

Alchemy `2.0.0-beta.84` and `@alchemy.run/cloudflare` `2.0.0-beta.84` accept Effect `^4.0.5`; the workspace uses one Effect `4.0.6`. `@cloudflare/workers-types` `5.20261012.1` matches Alchemy's runtime type pin. The normal check includes `tsconfig.cloudflare.json`, with strict source checking and a scoped `skipLibCheck:true`. Worker code uses Workers globals and native handler/state types, not DOM-only Node declarations. Root, app, and library declaration checks remain strict.

The exception covers verified upstream declaration defects in current releases: Alchemy's `ContainerConfiguration` type predicate conflicts with `exactOptionalPropertyTypes`, its SQL barrel references optional `mysql2/promise`, and Miniflare `4.20260730.0` references unpublished `shared/ratelimit/zod` paths and a mismatched `MockAgent` generic. Loading the intended Workers globals resolves Alchemy's otherwise missing `Ai` and `AiGateway` names. There are no ambient `any` replacements.

The transitive `capnp-es` `0.0.16` package declares a TypeScript `^5.7.3 || ^6.0.0` peer, while this workspace uses TypeScript `7.0.2`. Installation reports that peer warning; the workspace compiler stays unchanged. The scoped infrastructure check and real workerd execution validate our use of these dependencies rather than assuming peer compatibility.

See [Deploy Carneloot to Cloudflare](deploy-cloudflare.md) for the cutover procedure. The stack follows the [official Alchemy v2 documentation index](https://v2.alchemy.run/llms.txt), not Alchemy v1's async resource API.
