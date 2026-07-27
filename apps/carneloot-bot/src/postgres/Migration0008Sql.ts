// Generated from migrations/0008_food_reply_operations.sql; do not edit.
export const migration0008Sql =
	'CREATE TABLE carneloot.food_reply_operations (\n  bot_id text NOT NULL,\n  update_id bigint NOT NULL,\n  kind text NOT NULL,\n  result_json jsonb NOT NULL,\n  created_at timestamptz NOT NULL,\n  CONSTRAINT food_reply_operations_pk PRIMARY KEY (bot_id, update_id),\n  CONSTRAINT food_reply_operations_bot_id_nonempty CHECK (length(btrim(bot_id)) > 0),\n  CONSTRAINT food_reply_operations_update_id_safe CHECK (update_id >= 0 AND update_id <= 9007199254740991),\n  CONSTRAINT food_reply_operations_kind_nonempty CHECK (length(btrim(kind)) > 0)\n);\n\nCREATE INDEX pet_food_entries_source_message_idx\n  ON carneloot.pet_food_entries (source_bot_id, source_message_chat_id, source_message_id)\n  WHERE source_message_chat_id IS NOT NULL AND source_message_id IS NOT NULL;\n';
export const migration0008Checksum =
	'566621c1f86e2e8a9550a62c2f6b98379db056d875c97b2367942497dbfe4551';
