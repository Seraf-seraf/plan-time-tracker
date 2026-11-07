CREATE INDEX IF NOT EXISTS tracker_journal_tool_match ON tracker_journal(
  owner_id,plan_id,source_id,session_id,event_type,
  json_extract(payload_json,'$.data.operationId'),step_id,received_at,occurred_at
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tracker_journal_corrections ON tracker_journal(
  owner_id,correction_of_event_id,received_at
) WHERE correction_of_event_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tracker_journal_history_tools ON tracker_journal(
  owner_id,plan_id,event_type,server_sequence,received_at,occurred_at,step_id
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tracker_journal_attempt_start ON tracker_journal(
  owner_id,attempt_id,event_type,occurred_at
) WHERE command_id IS NOT NULL;
