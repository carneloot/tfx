CREATE TABLE carneloot.notification_events (
  id uuid NOT NULL,
  bot_id text NOT NULL,
  kind text NOT NULL,
  owner_user_id uuid NOT NULL,
  pet_id uuid,
  food_entry_id uuid,
  scheduled_for timestamptz,
  status text NOT NULL,
  dedupe_key text NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT notification_events_pk PRIMARY KEY (id),
  CONSTRAINT notification_events_owner_fk FOREIGN KEY (owner_user_id) REFERENCES carneloot.users(id) ON DELETE RESTRICT,
  CONSTRAINT notification_events_pet_fk FOREIGN KEY (pet_id) REFERENCES carneloot.pets(id) ON DELETE CASCADE,
  CONSTRAINT notification_events_food_fk FOREIGN KEY (food_entry_id) REFERENCES carneloot.pet_food_entries(id) ON DELETE SET NULL,
  CONSTRAINT notification_events_status_check CHECK (status IN ('scheduled','dispatching','completed','cancelled')),
  CONSTRAINT notification_events_bot_nonempty CHECK (octet_length(bot_id) BETWEEN 1 AND 128),
  CONSTRAINT notification_events_kind_nonempty CHECK (octet_length(kind) BETWEEN 1 AND 128),
  CONSTRAINT notification_events_dedupe_nonempty CHECK (octet_length(dedupe_key) BETWEEN 1 AND 512),
  CONSTRAINT notification_events_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT notification_events_job_key UNIQUE (job_id),
  CONSTRAINT notification_events_lifecycle_shape CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL) OR
    (status IN ('scheduled','dispatching') AND completed_at IS NULL AND cancelled_at IS NULL)
  )
);
CREATE TABLE carneloot.notification_deliveries (
  id uuid NOT NULL,
  event_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  recipient_chat_id bigint NOT NULL,
  recipient_role text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  attempt_generation bigint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  sending_started_at timestamptz,
  sending_lease_expires_at timestamptz,
  retry_at timestamptz,
  retryable boolean NOT NULL DEFAULT false,
  telegram_bot_id text,
  telegram_message_id bigint,
  safe_error_json jsonb,
  sent_at timestamptz,
  failed_at timestamptz,
  unknown_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT notification_deliveries_pk PRIMARY KEY (id),
  CONSTRAINT notification_deliveries_event_fk FOREIGN KEY (event_id) REFERENCES carneloot.notification_events(id) ON DELETE CASCADE,
  CONSTRAINT notification_deliveries_recipient_fk FOREIGN KEY (recipient_user_id) REFERENCES carneloot.users(id) ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_recipient_key UNIQUE (event_id,recipient_user_id,channel),
  CONSTRAINT notification_deliveries_status_check CHECK (status IN ('pending','sending','sent','failed','unknown')),
  CONSTRAINT notification_deliveries_chat_safe CHECK (recipient_chat_id <> 0 AND recipient_chat_id BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT notification_deliveries_role_check CHECK (octet_length(recipient_role) BETWEEN 1 AND 64 AND recipient_role ~ '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'),
  CONSTRAINT notification_deliveries_channel_check CHECK (octet_length(channel) BETWEEN 1 AND 64 AND channel ~ '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'),
  CONSTRAINT notification_deliveries_attempt_safe CHECK (attempt_generation BETWEEN 0 AND 9007199254740991 AND attempt_count BETWEEN 0 AND 2147483647),
  CONSTRAINT notification_deliveries_message_safe CHECK (telegram_message_id IS NULL OR telegram_message_id BETWEEN 1 AND 9007199254740991),
  CONSTRAINT notification_deliveries_state_shape CHECK (
    (status = 'pending' AND sending_started_at IS NULL AND sending_lease_expires_at IS NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NULL AND sent_at IS NULL AND failed_at IS NULL AND unknown_at IS NULL) OR
    (status = 'sending' AND sending_started_at IS NOT NULL AND sending_lease_expires_at IS NOT NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NULL AND sent_at IS NULL AND failed_at IS NULL AND unknown_at IS NULL) OR
    (status = 'sent' AND sending_started_at IS NOT NULL AND sending_lease_expires_at IS NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NOT NULL AND octet_length(telegram_bot_id) > 0 AND telegram_message_id IS NOT NULL AND safe_error_json IS NULL AND sent_at IS NOT NULL AND failed_at IS NULL AND unknown_at IS NULL) OR
    (status = 'failed' AND sending_started_at IS NOT NULL AND sending_lease_expires_at IS NULL AND ((retryable = true AND retry_at IS NOT NULL) OR (retryable = false AND retry_at IS NULL)) AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NOT NULL AND sent_at IS NULL AND failed_at IS NOT NULL AND unknown_at IS NULL) OR
    (status = 'unknown' AND sending_started_at IS NOT NULL AND sending_lease_expires_at IS NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NOT NULL AND sent_at IS NULL AND failed_at IS NULL AND unknown_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX notification_deliveries_sent_message_key ON carneloot.notification_deliveries (telegram_bot_id,recipient_chat_id,telegram_message_id) WHERE status='sent';
CREATE INDEX notification_events_due_idx ON carneloot.notification_events (status,scheduled_for,id);
CREATE INDEX notification_deliveries_claim_idx ON carneloot.notification_deliveries (event_id,status,retry_at,id);
CREATE INDEX notification_deliveries_recovery_idx ON carneloot.notification_deliveries (sending_lease_expires_at,id) WHERE status='sending';
