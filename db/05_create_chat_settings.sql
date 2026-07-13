ALTER TABLE chats ADD COLUMN IF NOT EXISTS host_only_controls BOOLEAN DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS allow_video BOOLEAN DEFAULT true;
ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS notify_messages BOOLEAN DEFAULT true;
ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS notify_video BOOLEAN DEFAULT true;
ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS sound_enabled BOOLEAN DEFAULT true;
ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS show_participants BOOLEAN DEFAULT true;
