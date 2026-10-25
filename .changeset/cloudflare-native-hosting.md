---
'@tfx/cloudflare': minor
'@tfx/postgres': minor
'tfx': minor
---

Add Cloudflare event hosting, Alchemy resources, and Durable Object job alarms backed by a transactional PostgreSQL wakeup outbox. Keep PostgreSQL authoritative for conversations, domain writes, and schedules.

Move application scheduling and cancellation from `JobRuntime` to `JobScheduler`, which also exposes job inspection. `JobRuntime.layer` supplies both services. PostgreSQL migration 5 adds the recoverable wakeup handoff. Existing PostgreSQL server execution remains supported.
