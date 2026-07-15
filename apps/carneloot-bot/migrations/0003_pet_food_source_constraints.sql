ALTER TABLE carneloot.pet_food_entries
  ADD CONSTRAINT pet_food_entries_source_bot_nonempty CHECK (octet_length(source_bot_id) > 0),
  ADD CONSTRAINT pet_food_entries_source_update_safe CHECK (source_update_id BETWEEN 0 AND 9007199254740991),
  ADD CONSTRAINT pet_food_entries_source_message_id_safe CHECK (source_message_id IS NULL OR source_message_id BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT pet_food_entries_source_chat_id_safe CHECK (source_message_chat_id IS NULL OR (source_message_chat_id <> 0 AND source_message_chat_id BETWEEN -9007199254740991 AND 9007199254740991));
