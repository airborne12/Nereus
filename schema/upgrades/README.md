# Telemetry schema upgrades

## Preserve nested attribute strings

Fresh installations use VARIANT for span events, span links and metric exemplars.
The old ARRAY/STRUCT/MAP columns can lose escapes during JSON Stream Load and return
invalid JSON over MySQL. VARIANT accepts the same Collector payload and preserves
newlines, quotes, backslashes and Unicode.

For an existing installation on Doris 4.1.5 or later:

1. Stop every Collector and other process that writes telemetry to the database.
2. Install the server dependencies and run with Node 24:

   ```sh
   DORIS_HOST=127.0.0.1 DORIS_PORT=9030 DORIS_DB=otel \
     node schema/upgrades/002_complex_attributes.ts --writers-stopped
   ```

   Set DORIS_USER and DORIS_PASSWORD if required. The script preserves table
   partitions, properties, indexes and rows. It compares row counts before each
   atomic table swap. Readers can continue using the original table names.

3. Verify the five changed tables, then restart the writers.

Each original table remains at `<table>_before_complex_variant`, under its existing
retention policy. Keep these backups until verification is complete. The script
skips columns already using VARIANT and refuses to overwrite a backup from an
incomplete attempt. If it fails, inspect the tables before restarting or retrying.

To roll back a completed table while writers are stopped:

```sql
ALTER TABLE otel.otel_traces REPLACE WITH TABLE otel_traces_before_complex_variant
    PROPERTIES('swap' = 'true');
```

Apply the same operation to each changed metric table. After rollback, the backup
name contains the migrated table. A rollback after ingestion resumes needs a plan
to retain the newly ingested rows.

The migration preserves the values already stored. It cannot reconstruct string
characters that were lost before the upgrade; re-export the original telemetry
when those historical values are needed.
