// Generated from migrations/0007_notification_recipient_freeze.sql; do not edit.
export const migration0007Sql =
	"ALTER TABLE carnebot.notification_events\n  ADD COLUMN recipients_materialized_at timestamptz,\n  ADD COLUMN food_timestamp_explicit boolean NOT NULL DEFAULT false,\n  ADD CONSTRAINT notification_events_food_timestamp_shape CHECK (\n    food_timestamp_explicit = false OR kind = 'food-added'\n  );\n";
export const migration0007Checksum =
	'4ce6e536d700d8597a13cf3b9fe2b9ceb40b09ed0eeeb21a11b10bc5a751c6c2';
