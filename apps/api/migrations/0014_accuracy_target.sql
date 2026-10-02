-- Precision mode: answers below this measured confidence are not
-- classified (the best guess is still returned separately).
alter table coverage_budgets add column if not exists accuracy_target numeric(4,3) not null default 0.93;
alter table coverage_bulk_results add column if not exists likely_line_type text;
