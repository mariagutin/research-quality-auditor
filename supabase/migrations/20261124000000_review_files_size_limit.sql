-- Migration: per-file size ceiling on the `review-files` Storage bucket (SEC-02)
-- Created: 2026-11-24
--
-- SEC-02 requires a documented, enforced size ceiling on uploaded .md files. The
-- application re-verifies size, file count, and the per-review total at the save
-- and check boundaries (lib/reviews/budgets.ts, finish-save.ts, run-check.ts), but
-- the FIRST and hardest gate is Storage itself: with a bucket `file_size_limit`,
-- an oversized PUT is refused by Storage before it ever reaches application code.
--
-- Limit: 115 KiB = 117,760 bytes per object (report or transcript). The per-review
-- total (1,495 KiB) and the transcript count (<= 12) are not expressible on the
-- bucket, so they are enforced in application code; this ceiling caps any single
-- object. See ADR-0011.
--
-- Idempotent: an UPDATE of the existing bucket row created in
-- 20261110000000_create_review_files_storage_bucket.sql. Changing the ceiling
-- later is a one-line UPDATE in a new migration.

update storage.buckets
set file_size_limit = 117760  -- 115 * 1024
where id = 'review-files';
