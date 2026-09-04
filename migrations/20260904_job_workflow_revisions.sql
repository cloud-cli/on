-- Run this migration once against an existing runner database before deploying
-- the revision-reference queue code. SQLite does not support ADD COLUMN IF NOT
-- EXISTS, so do not rerun these two ALTER statements.
ALTER TABLE jobs ADD COLUMN workflow_revision INTEGER;
ALTER TABLE jobs ADD COLUMN required_tags TEXT NOT NULL DEFAULT '[]';

-- Preserve current tag routing for historical jobs created before this column.
UPDATE jobs
SET required_tags = COALESCE(json_extract(payload, '$.tags'), '[]')
WHERE required_tags = '[]';

-- Existing jobs can use the currently published workflow revision. Jobs for
-- unknown or unpublished workflows remain historical records but cannot run.
UPDATE jobs
SET workflow_revision = (
  SELECT active_revision FROM workflows WHERE workflows.id = jobs.workflow_id
)
WHERE workflow_revision IS NULL;

-- Do not let an old pending job fail repeatedly when no DB workflow revision
-- exists for it. Completed jobs retain their history untouched.
UPDATE jobs
SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP
WHERE status IN ('pending', 'running') AND workflow_revision IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_pending_created ON jobs(status, created_at);
