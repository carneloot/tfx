// Generated from migrations/0003_pet_food_source_constraints.sql; do not edit.
export const migration0003Sql =
	'ALTER TABLE carneloot.pet_food_entries\n  ADD CONSTRAINT pet_food_entries_source_bot_nonempty CHECK (octet_length(source_bot_id) > 0),\n  ADD CONSTRAINT pet_food_entries_source_update_safe CHECK (source_update_id BETWEEN 0 AND 9007199254740991),\n  ADD CONSTRAINT pet_food_entries_source_message_id_safe CHECK (source_message_id IS NULL OR source_message_id BETWEEN 1 AND 9007199254740991),\n  ADD CONSTRAINT pet_food_entries_source_chat_id_safe CHECK (source_message_chat_id IS NULL OR (source_message_chat_id <> 0 AND source_message_chat_id BETWEEN -9007199254740991 AND 9007199254740991));\n';
export const migration0003Checksum =
	'9ee2fb3bf11a4d70b6fda472995db312673b4af6365fb025f9cc09dd3443c861';
