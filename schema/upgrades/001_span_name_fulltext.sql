-- For tables created before span_name had a tokenized index (DorisStack 285f28c and earlier).
-- Run with: sed "s/\${DB}/otel/g" schema/upgrades/001_span_name_fulltext.sql | mysql -h<fe> -P9030 -uroot
-- Doris applies each ALTER asynchronously; BUILD INDEX indexes the rows written before it.
ALTER TABLE ${DB}.otel_traces DROP INDEX idx_span_name;
ALTER TABLE ${DB}.otel_traces ADD INDEX idx_span_name (span_name) USING INVERTED
    PROPERTIES ("parser" = "unicode", "lower_case" = "true", "support_phrase" = "true");
BUILD INDEX idx_span_name ON ${DB}.otel_traces;
