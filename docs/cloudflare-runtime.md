# Carneloot on Cloudflare

Carneloot retains PostgreSQL as the source of truth. `@tfx/cloudflare` owns webhook admission, chat serialization, per-event Effect lifetimes, native job alarms, and their Alchemy wiring. The app supplies its router, domain layers, and notification recovery policy. Hyperdrive has caching disabled. The database remains externally managed.

## Application boundary

`@tfx/cloudflare/Runtime.make` accepts `botId`, `layer(env)`, and `router(env)`. The optional `beforeJobs` effect recovers application-specific delivery state during reconciliation and execution. The returned `worker`, `ChatDispatch`, and `JobWakeup` are the entrypoint exports. No delivery source, fake server, retained runtime, or continuous `JobWorker` is required.

`@tfx/cloudflare/Postgres.layer` supplies scoped Hyperdrive pools, Telegram HTTP, crypto, tfx PostgreSQL services, and the wakeup outbox adapter. Application repositories use that same PgClient, so conversation transitions, domain writes, and scheduling still share a transaction. This layer never migrates the database.

`@tfx/cloudflare/Alchemy.worker` declares the two Durable Object bindings, Node compatibility, CPU limit, and five-minute recovery cron. The app supplies the entrypoint and its bindings, including secrets and Hyperdrive. Alchemy credentials and the database origin stay application-owned.

Application code uses `JobScheduler` for `schedule`, `cancel`, and `inspect`. A declaration plus `conflictKey` replaces the active schedule for that entity. `JobRuntime` owns bounded execution, failed-job inspection, and release after operator review. Its layer supplies both services; applications that only schedule can use `JobScheduler.layer` without job implementations. Claims, leases, migrations, and heartbeats stay behind the execution API. The PostgreSQL server runner remains supported.

## Webhook lifetime and ordering

The public Worker checks Telegram's secret header before decoding at most 1 MiB of JSON with the generated `Update` schema. It routes accepted updates through `Partitioning.byChat(UpdateRoutingScope.fromUpdate(...))`, exactly like the polling runtime. This includes chat, user-only, business-connection, and update-only fallback identities.

Each Durable Object holds `blockConcurrencyWhile` across dispatch **and scoped cleanup**. SQL remains authoritative; the object stores no conversation or domain data. Distinct inputs in one partition cannot overtake an accepted input during its asynchronous database or Telegram work. Different partitions can execute concurrently.

This preserves arrival order at the object, not numerical `update_id` order. The registration command enforces `max_connections=1` to limit upstream reordering. Telegram retries and network delays can still change arrival order before the object receives an update. No transport can infer the intended order of an input that has not arrived. A platform crash can interrupt an update between a committed mutation and storing its dispatch outcome, just as a polling-process crash can. This migration does not claim exactly-once processing across that window.

The internal object request does not inherit the public caller's abort signal. After acceptance, a disconnect cannot abandon dispatch while a later request uses the same graph. Telegram operations have a whole-operation 5-second timeout, including response decoding. Dispatch has a 10-second deadline, leaving 20 seconds before Cloudflare's 30-second `blockConcurrencyWhile` limit for cancellation, rollback, deduplication finalization, and pool closure. Cleanup is awaited, not detached. A platform reset or unavailable database can still prevent cleanup from finishing; SQL leases, fencing, and transactions remain necessary.

The Worker returns HTTP 200 only for existing acknowledgeable `DispatchOutcome`s: `Handled`, `HandledWithOutputFailure`, or `PermanentInvalid`. Retryable failures, fatal outcomes, defects, and whole-dispatch deadlines return 503. It does not turn a generic timeout into success. The existing router distinguishes committed conversation output failures from processing failures. A completed duplicate returns its stored outcome without repeating output.

## Transactions and replay

`BotRuntime.dispatch` reuses the polling runtime's durable claim, heartbeat, completion, and release protocol. It starts neither polling nor a keyed executor; the Durable Object supplies transport serialization.

Each invocation builds and closes one scoped SQL pool through Hyperdrive with `prepare:false`. No pool crosses Worker events. `TfxPostgres.servicesLayer` and `RepositoriesLive.repositoriesLayer` acquire repositories without migrations. The graph includes `JobRuntime`, but no `BotRuntime` source or continuous `JobWorker` fiber. Explicit operator commands apply migrations before cutover, including tfx migration 5 for the wakeup outbox.

SQL conversation locks, instance/revision checks, and the domain transaction adapter coordinate conversation state with domain changes. Pet mutations recheck owner or caregiver access inside their transaction. Food replay identity stays `(botId, updateId, petId)`, so one update can feed several pets. Food timestamps stay anchored to Telegram's message date, not Worker processing time. These checks are still required across different chat objects that mutate the same pet.

## Native scheduling and recovery

PostgreSQL jobs, leases, retries, and notification-delivery state remain authoritative. A database trigger writes a coalesced, revisioned wakeup intent whenever a job changes. The intent commits or rolls back with the job and the surrounding application transaction. The outbox contains no Telegram payloads.

After dispatch and scoped cleanup, the Worker asks the bot's `JobWakeup` object to reconcile. The object reads outbox receipts before querying the earliest SQL deadline, persists its alarm, and only then acknowledges those receipts. A concurrent change replaces the receipt revision, so an older acknowledgement cannot erase it. Failed handoff does not change a committed update's HTTP outcome. The five-minute cron repeats reconciliation after a missed handoff or platform outage. Cron does not execute jobs.

A Durable Object has one alarm. This adapter uses one wakeup object per bot and SQL namespace, with every schedule persisted in PostgreSQL rather than DO memory. It arms the earliest runnable deadline or lease expiry. Chat objects are transport gates, not owners of pets or schedules. This favors a small, coordinated executor over per-chat scheduling that would misrepresent shared-pet ownership. One bot must use its own tfx job table namespace, just as with the server runner.

An alarm persists a 30-second recovery wakeup before claiming work, recovers expired notification sends, and executes at most 50 jobs with a 10-second processing deadline. It then reconciles the next deadline. A remaining backlog causes another native alarm rather than waiting for cron. Interrupted work retains its SQL lease, which becomes a future alarm deadline. Reconciliation has its own 10-second deadline. The object's gate serializes alarm execution with reconciliation so an older snapshot cannot overwrite a newer alarm.

Object eviction loses no schedule. Alarm delivery can duplicate or arrive late; SQL claims and fencing still decide execution. Alarms normally run at the persisted deadline without minute scanning, but this is not an exact-time or exactly-once delivery guarantee. Missed handoffs can wait for the recovery cron, and platform or database outages can delay work further. Job handlers must finish within the event budget and remain replay-safe. This adapter does not move application state to DO SQLite or introduce Queues or Workflows without a use case. Conversation expiration retains its existing SQL and lazy-load semantics.

Telegram sends are not blindly retried. Existing definitive failure policy remains in the notification dispatcher. Ambiguous network failures, decode failures, and expired `sending` leases become terminal `unknown`, not a resend request. Operators must reconcile those deliveries before taking manual action.

## Validation boundary

The integration suite bundles the production entrypoint through a test-only alarm-control subclass. It runs native Worker requests, Durable Objects, alarms, Hyperdrive's local TCP binding, and recovery cron events in workerd against real PostgreSQL. It covers duplicate wakeups, replacement, cancellation, a persisted alarm and execution lease across emulator restart, a failed post-commit handoff, shared pets across chats, and ambiguous sends. PostgreSQL tests cover outbox rollback, stale acknowledgements, and lease and retry deadlines. Only outgoing Telegram HTTP is mocked. Local Hyperdrive emulation proves wire-driver compatibility, not connectivity, TLS, or permissions of a live Cloudflare origin. Those require an approved staging deployment.

Alchemy `2.0.0-beta.84` and `@alchemy.run/cloudflare` `2.0.0-beta.84` accept Effect `^4.0.5`; the workspace uses one Effect `4.0.6`. `@cloudflare/workers-types` `5.20261012.1` matches Alchemy's runtime type pin. The normal check includes `tsconfig.cloudflare.json`, with strict source checking and a scoped `skipLibCheck:true`. The Cloudflare package uses the same declaration-check exception. Worker code uses Workers globals and native handler/state types, not DOM-only Node declarations. Other app and library declaration checks remain strict.

The exception covers verified upstream declaration defects in current releases: Alchemy's `ContainerConfiguration` type predicate conflicts with `exactOptionalPropertyTypes`, its SQL barrel references optional `mysql2/promise`, and Miniflare `4.20260730.0` references unpublished `shared/ratelimit/zod` paths and a mismatched `MockAgent` generic. Loading the intended Workers globals resolves Alchemy's otherwise missing `Ai` and `AiGateway` names. There are no ambient `any` replacements.

The transitive `capnp-es` `0.0.16` package declares a TypeScript `^5.7.3 || ^6.0.0` peer, while this workspace uses TypeScript `7.0.2`. Installation reports that peer warning; the workspace compiler stays unchanged. The scoped infrastructure check and real workerd execution validate our use of these dependencies rather than assuming peer compatibility.

See [Deploy Carneloot to Cloudflare](deploy-cloudflare.md) for the cutover procedure. The stack follows the [official Alchemy v2 documentation index](https://v2.alchemy.run/llms.txt), not Alchemy v1's async resource API.
