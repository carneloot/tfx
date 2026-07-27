CREATE TABLE carneloot.food_reply_operations (
  bot_id text NOT NULL,
  update_id bigint NOT NULL,
  kind text NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT food_reply_operations_pk PRIMARY KEY (bot_id, update_id),
  CONSTRAINT food_reply_operations_bot_id_nonempty CHECK (length(btrim(bot_id)) > 0),
  CONSTRAINT food_reply_operations_update_id_safe CHECK (update_id >= 0 AND update_id <= 9007199254740991),
  CONSTRAINT food_reply_operations_kind_nonempty CHECK (length(btrim(kind)) > 0)
);

CREATE INDEX pet_food_entries_source_message_idx
  ON carneloot.pet_food_entries (source_bot_id, source_message_chat_id, source_message_id)
  WHERE source_message_chat_id IS NOT NULL AND source_message_id IS NOT NULL;
