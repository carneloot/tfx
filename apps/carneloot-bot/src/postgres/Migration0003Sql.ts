// Generated from migrations/0003_pet_food_source_constraints.sql; do not edit.
export const migration0003Sql =
	'ALTER TABLE carnebot.pet_food_entries\n  ADD CONSTRAINT pet_food_entries_source_bot_nonempty CHECK (octet_length(source_bot_id) > 0),\n  ADD CONSTRAINT pet_food_entries_source_update_safe CHECK (source_update_id BETWEEN 0 AND 9007199254740991),\n  ADD CONSTRAINT pet_food_entries_source_message_id_safe CHECK (source_message_id IS NULL OR source_message_id BETWEEN 1 AND 9007199254740991),\n  ADD CONSTRAINT pet_food_entries_source_chat_id_safe CHECK (source_message_chat_id IS NULL OR (source_message_chat_id <> 0 AND source_message_chat_id BETWEEN -9007199254740991 AND 9007199254740991));\n';
export const migration0003Checksum =
	'5f6e958b8f4dc580c9e6383481a4299433b0f93d6b3d69ccc01b30cfd501fd1e';
