CREATE TABLE carneloot.pet_food_settings (
  pet_id uuid NOT NULL,
  day_start time,
  timezone text,
  reminder_delay_ms bigint,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pet_food_settings_pk PRIMARY KEY (pet_id),
  CONSTRAINT pet_food_settings_pet_fk FOREIGN KEY (pet_id) REFERENCES carneloot.pets(id) ON DELETE CASCADE,
  CONSTRAINT pet_food_settings_day_start_timezone_pair CHECK ((day_start IS NULL) = (timezone IS NULL)),
  CONSTRAINT pet_food_settings_reminder_delay_range CHECK (reminder_delay_ms IS NULL OR reminder_delay_ms BETWEEN 1 AND 2592000000)
);
CREATE TABLE carneloot.pet_food_entries (
  id uuid NOT NULL,
  pet_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  amount_mg bigint NOT NULL,
  fed_at timestamptz NOT NULL,
  source_bot_id text NOT NULL,
  source_update_id bigint NOT NULL,
  source_message_chat_id bigint,
  source_message_id bigint,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pet_food_entries_pk PRIMARY KEY (id),
  CONSTRAINT pet_food_entries_pet_fk FOREIGN KEY (pet_id) REFERENCES carneloot.pets(id) ON DELETE CASCADE,
  CONSTRAINT pet_food_entries_recorded_by_fk FOREIGN KEY (recorded_by) REFERENCES carneloot.users(id) ON DELETE RESTRICT,
  CONSTRAINT pet_food_entries_amount_range CHECK (amount_mg BETWEEN 1 AND 100000000),
  CONSTRAINT pet_food_entries_source_key UNIQUE (source_bot_id, source_update_id, pet_id)
);
CREATE INDEX pet_food_entries_latest_idx ON carneloot.pet_food_entries (pet_id, fed_at DESC, created_at DESC, id DESC);
