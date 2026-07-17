// Generated from migrations/0007_notification_recipient_freeze.sql; do not edit.
export const migration0007Sql =
	"ALTER TABLE carneloot.notification_events\n  ADD COLUMN recipients_materialized_at timestamptz,\n  ADD COLUMN food_timestamp_explicit boolean NOT NULL DEFAULT false,\n  ADD CONSTRAINT notification_events_food_timestamp_shape CHECK (\n    food_timestamp_explicit = false OR kind = 'food-added'\n  );\n";
export const migration0007Checksum =
	'b2f598cdeafa78e594e078686809855c5890449e224aa098f3389c8e28af98dd';
