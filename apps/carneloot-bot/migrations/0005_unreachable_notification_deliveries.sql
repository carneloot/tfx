ALTER TABLE carneloot.notification_deliveries
  DROP CONSTRAINT notification_deliveries_chat_safe,
  DROP CONSTRAINT notification_deliveries_state_shape,
  ALTER COLUMN recipient_chat_id DROP NOT NULL,
  ADD CONSTRAINT notification_deliveries_chat_safe CHECK (recipient_chat_id IS NULL OR (recipient_chat_id <> 0 AND recipient_chat_id BETWEEN -9007199254740991 AND 9007199254740991)),
  ADD CONSTRAINT notification_deliveries_state_shape CHECK (
    (status = 'pending' AND recipient_chat_id IS NOT NULL AND sending_started_at IS NULL AND sending_lease_expires_at IS NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NULL AND sent_at IS NULL AND failed_at IS NULL AND unknown_at IS NULL) OR
    (status = 'sending' AND recipient_chat_id IS NOT NULL AND sending_started_at IS NOT NULL AND sending_lease_expires_at IS NOT NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NULL AND sent_at IS NULL AND failed_at IS NULL AND unknown_at IS NULL) OR
    (status = 'sent' AND recipient_chat_id IS NOT NULL AND sending_started_at IS NOT NULL AND sending_lease_expires_at IS NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NOT NULL AND octet_length(telegram_bot_id) > 0 AND telegram_message_id IS NOT NULL AND safe_error_json IS NULL AND sent_at IS NOT NULL AND failed_at IS NULL AND unknown_at IS NULL) OR
    (status = 'failed' AND sending_lease_expires_at IS NULL AND ((retryable = true AND recipient_chat_id IS NOT NULL AND sending_started_at IS NOT NULL AND retry_at IS NOT NULL) OR (retryable = false AND retry_at IS NULL AND ((recipient_chat_id IS NULL AND sending_started_at IS NULL AND attempt_generation = 0 AND attempt_count = 0) OR (recipient_chat_id IS NOT NULL AND sending_started_at IS NOT NULL)))) AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NOT NULL AND sent_at IS NULL AND failed_at IS NOT NULL AND unknown_at IS NULL) OR
    (status = 'unknown' AND recipient_chat_id IS NOT NULL AND sending_started_at IS NOT NULL AND sending_lease_expires_at IS NULL AND retry_at IS NULL AND retryable = false AND telegram_bot_id IS NULL AND telegram_message_id IS NULL AND safe_error_json IS NOT NULL AND sent_at IS NULL AND failed_at IS NULL AND unknown_at IS NOT NULL)
  );
