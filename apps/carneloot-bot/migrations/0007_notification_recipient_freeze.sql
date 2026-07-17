ALTER TABLE carneloot.notification_events
  ADD COLUMN recipients_materialized_at timestamptz,
  ADD COLUMN food_timestamp_explicit boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT notification_events_food_timestamp_shape CHECK (
    food_timestamp_explicit = false OR kind = 'food-added'
  );
