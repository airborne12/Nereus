-- Alerts on dashboard tiles: an alert watches either a saved search (its match count) or one tile
-- (its first series; with a group by, the group that breaches). Removing the tile removes them.

ALTER TABLE alerts ALTER COLUMN saved_search_id DROP NOT NULL;
ALTER TABLE alerts ADD COLUMN dashboard_id BIGINT REFERENCES dashboards (id) ON DELETE CASCADE;
ALTER TABLE alerts ADD COLUMN tile_id TEXT;
ALTER TABLE alerts ADD COLUMN last_group TEXT;
ALTER TABLE alerts ADD CONSTRAINT alerts_one_target CHECK (
    (saved_search_id IS NOT NULL) <> (dashboard_id IS NOT NULL) AND (dashboard_id IS NULL) = (tile_id IS NULL));
CREATE INDEX alerts_dashboard_idx ON alerts (dashboard_id);

ALTER TABLE alert_history ADD COLUMN grp TEXT;
