ALTER TABLE prompt_templates ADD COLUMN opening_script TEXT;

ALTER TABLE outbound_launches ADD COLUMN callee_name TEXT;
ALTER TABLE outbound_launches ADD COLUMN opening_script TEXT;
