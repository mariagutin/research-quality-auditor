-- =============================================================================
-- Synthetic test for the review lifecycle, operation leases, and concurrency
-- functions (migration 20261112000000_review_lifecycle_and_operation_leases.sql).
--
-- DATABASE BEHAVIOUR ONLY. This proves the lease/fence/guard logic in Postgres.
-- It does NOT touch Storage, and it does NOT prove Storage protection (the token
-- path policy + real upload paths are a later migration and must be tested there).
-- "Staleness" is simulated by setting op_heartbeat_at into the past; the functions
-- judge it with the database clock (now()).
--
-- As one synthetic signed-in user it checks:
--   1. begin_upload creates a review as `uploading` with a lease token + heartbeat.
--   2. finish_upload is fenced (wrong token / not-uploading refused) and, on the
--      happy path, inserts documents and moves uploading -> draft; shape rules hold.
--   3. retry_upload: refused while ACTIVE; allowed once RECOVERABLE (confirmed
--      failed or stale); records a fixed-target reminder for the RETIRED token; the
--      live token is never a dead token; reminders accumulate across retries.
--   4. touch_review_op refreshes activity for the current lease only; an obsolete
--      or confirmed-failed attempt cannot renew the lease.
--   5. fail_review_op: uploading -> op_failed_at set; processing -> `failed`.
--   6. begin_review_op transition table (active vs recoverable), incl. no re-run of
--      a complete review and no competing active deletion.
--   7. finalize_review_deletion: fenced; creates the whole-prefix cleanup record,
--      deletes the row + cascade (incl. decisions and dead-attempt reminders); the
--      BEFORE DELETE guard forbids deleting a review with no cleanup record.
--   8. decision guard: making/changing/deleting a decision is refused while the
--      review is busy (uploading/processing/deleting) and allowed when complete;
--      the review's own deletion cascade is permitted (section 7 proves this).
--
-- SAFETY: synthetic data only; one transaction that ends in ROLLBACK; local,
-- disposable Supabase only -- never hosted.
--
-- HOW TO RUN (see supabase/tests/README.md):
--   docker exec -i supabase_db_research-quality-auditor \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < supabase/tests/review_lifecycle_test.sql
-- =============================================================================

\set ON_ERROR_STOP on

begin;

insert into auth.users (instance_id, id, aud, role, email) values
  ('00000000-0000-0000-0000-000000000000',
   '00000000-0000-0000-0000-00000000000a',
   'authenticated', 'authenticated', 'anna@synthetic.test');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', false);
set role authenticated;

do $$ begin raise notice 'SETUP: one synthetic signed-in user'; end $$;

-- A helper to force a review into a precise lease state (owner update under RLS).
-- Used to simulate staleness with the database clock and to reset before cases.
create function pg_temp.set_state(
  p_id uuid, p_status text, p_token uuid,
  p_heartbeat timestamptz, p_failed timestamptz
) returns void language sql as $$
  update public.reviews
     set processing_status = p_status, op_token = p_token,
         op_heartbeat_at = p_heartbeat, op_failed_at = p_failed
   where id = p_id;
$$;

-- ===========================================================================
-- 1. begin_upload creates the review as `uploading` BEFORE any file is sent.
-- ===========================================================================
do $$
declare v_rid uuid; v_tok uuid; v_status text; v_hb timestamptz; v_owner uuid;
begin
  select review_id, op_token into v_rid, v_tok from public.begin_upload('Interview report.md');
  select processing_status, op_heartbeat_at, user_id, op_token
    into v_status, v_hb, v_owner,  v_tok
    from public.reviews where id = v_rid;
  if v_status <> 'uploading' then raise exception 'FAIL 1: expected uploading, got %', v_status; end if;
  if v_tok is null then raise exception 'FAIL 1: op_token not assigned'; end if;
  if v_hb is null then raise exception 'FAIL 1: op_heartbeat_at not set'; end if;
  if v_owner <> auth.uid() then raise exception 'FAIL 1: review not owned by caller'; end if;
  raise notice 'PASS 1: begin_upload created an uploading review with a lease token + heartbeat';
end $$;

-- ===========================================================================
-- 2. finish_upload: fenced + happy path + shape rules.
-- ===========================================================================
do $$
declare
  v_rid uuid; v_tok uuid; v_bad uuid := gen_random_uuid();
  v_docs jsonb; v_status text; n int; v_raised boolean;
begin
  select review_id, op_token into v_rid, v_tok from public.begin_upload('Study.md');
  v_docs := jsonb_build_array(
    jsonb_build_object('role','report','filename','Study.md',
      'storage_path', 'a/'||v_rid||'/'||v_tok||'/Study.md'),
    jsonb_build_object('role','transcript','filename','p03.md',
      'storage_path', 'a/'||v_rid||'/'||v_tok||'/p03.md','participant_id','P03')
  );

  -- 2a. Wrong token is refused (fence) and writes nothing.
  v_raised := false;
  begin perform public.finish_upload(v_rid, v_bad, v_docs);
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 2a: finish_upload accepted a wrong token'; end if;
  select processing_status into v_status from public.reviews where id = v_rid;
  if v_status <> 'uploading' then raise exception 'FAIL 2a: fenced finish changed status to %', v_status; end if;
  select count(*) into n from public.documents where review_id = v_rid;
  if n <> 0 then raise exception 'FAIL 2a: fenced finish inserted documents'; end if;

  -- 2b. Shape rule: a transcript with a blank participant id is rejected.
  v_raised := false;
  begin
    perform public.finish_upload(v_rid, v_tok, jsonb_build_array(
      jsonb_build_object('role','report','filename','Study.md','storage_path','p/r'),
      jsonb_build_object('role','transcript','filename','p.md','storage_path','p/t','participant_id','  ')
    ));
  exception when others then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 2b: blank participant id accepted'; end if;

  -- 2c. Happy path: correct token -> documents inserted, review -> draft, lease cleared.
  perform public.finish_upload(v_rid, v_tok, v_docs);
  select processing_status, op_token into v_status, v_tok from public.reviews where id = v_rid;
  if v_status <> 'draft' then raise exception 'FAIL 2c: expected draft, got %', v_status; end if;
  if v_tok is not null then raise exception 'FAIL 2c: op_token not cleared on finish'; end if;
  select count(*) into n from public.documents where review_id = v_rid;
  if n <> 2 then raise exception 'FAIL 2c: expected 2 documents, got %', n; end if;

  -- 2d. A second finish (lease already cleared) is refused.
  v_raised := false;
  begin perform public.finish_upload(v_rid, v_bad, v_docs);
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 2d: finish accepted after the review left uploading'; end if;

  raise notice 'PASS 2: finish_upload fenced on token/state, enforced shape, moved uploading->draft';
end $$;

-- ===========================================================================
-- 3. retry_upload: active refused; recoverable allowed; fixed-target reminder;
--    live token is never a dead token; reminders accumulate.
-- ===========================================================================
do $$
declare v_rid uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; n int; v_raised boolean;
begin
  select review_id, op_token into v_rid, v_t1 from public.begin_upload('Retryable.md');

  -- 3a. While ACTIVE (fresh heartbeat, not failed), retry is refused.
  v_raised := false;
  begin perform public.retry_upload(v_rid);
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 3a: retry allowed on an active upload'; end if;

  -- 3b. Confirmed failure makes it RECOVERABLE immediately (no waiting for timeout).
  if not public.fail_review_op(v_rid, v_t1) then raise exception 'FAIL 3b: fail_review_op did not record failure'; end if;
  v_t2 := public.retry_upload(v_rid);
  if v_t2 is null or v_t2 = v_t1 then raise exception 'FAIL 3b: retry did not stamp a fresh token'; end if;

  -- Reminder exists for the RETIRED token T1, and NOT for the live token T2.
  select count(*) into n from public.review_dead_upload_attempts where review_id = v_rid and token = v_t1;
  if n <> 1 then raise exception 'FAIL 3b: no reminder for retired token T1'; end if;
  select count(*) into n from public.review_dead_upload_attempts where review_id = v_rid and token = v_t2;
  if n <> 0 then raise exception 'FAIL 3b: live token T2 wrongly recorded as a dead attempt'; end if;

  -- 3c. After a retry the review is active again under T2 -> retry refused.
  v_raised := false;
  begin perform public.retry_upload(v_rid);
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 3c: retry allowed on freshly re-stamped active upload'; end if;

  -- 3d. Make T2 stale (database-time staleness) -> retry allowed; reminders accumulate.
  perform pg_temp.set_state(v_rid, 'uploading', v_t2, now() - interval '3 minutes', null);
  v_t3 := public.retry_upload(v_rid);
  if v_t3 is null or v_t3 in (v_t1, v_t2) then raise exception 'FAIL 3d: retry did not stamp a new token after staleness'; end if;
  select count(*) into n from public.review_dead_upload_attempts where review_id = v_rid;
  if n <> 2 then raise exception 'FAIL 3d: expected 2 reminders (T1,T2), got %', n; end if;
  select count(*) into n from public.review_dead_upload_attempts where review_id = v_rid and token = v_t3;
  if n <> 0 then raise exception 'FAIL 3d: live token T3 wrongly recorded as a dead attempt'; end if;

  raise notice 'PASS 3: retry refused while active; allowed when recoverable; fixed-target reminders for retired tokens only';
end $$;

-- ===========================================================================
-- 4. touch_review_op: only the current, non-failed lease can renew activity.
-- ===========================================================================
do $$
declare v_rid uuid; v_tok uuid; v_old uuid := gen_random_uuid(); v_before timestamptz;
begin
  select review_id, op_token into v_rid, v_tok from public.begin_upload('Heartbeat.md');
  perform pg_temp.set_state(v_rid, 'uploading', v_tok, now() - interval '1 minute', null);
  select op_heartbeat_at into v_before from public.reviews where id = v_rid;

  -- 4a. Current token refreshes the heartbeat.
  if not public.touch_review_op(v_rid, v_tok) then raise exception 'FAIL 4a: current lease could not refresh'; end if;
  if (select op_heartbeat_at from public.reviews where id = v_rid) <= v_before then
    raise exception 'FAIL 4a: heartbeat did not move forward'; end if;

  -- 4b. An OBSOLETE token cannot renew the lease.
  if public.touch_review_op(v_rid, v_old) then raise exception 'FAIL 4b: an obsolete token renewed the lease'; end if;

  -- 4c. A CONFIRMED-FAILED attempt cannot renew itself back to active.
  perform public.fail_review_op(v_rid, v_tok);   -- uploading -> op_failed_at set
  if public.touch_review_op(v_rid, v_tok) then raise exception 'FAIL 4c: a failed attempt renewed the lease'; end if;

  raise notice 'PASS 4: only the current, non-failed lease can refresh activity (obsolete/failed cannot)';
end $$;

-- ===========================================================================
-- 5. fail_review_op: uploading -> op_failed_at; processing -> `failed`.
-- ===========================================================================
do $$
declare v_rid uuid; v_tok uuid; v_status text; v_failed timestamptz;
begin
  -- uploading branch
  select review_id, op_token into v_rid, v_tok from public.begin_upload('FailUpload.md');
  if not public.fail_review_op(v_rid, v_tok) then raise exception 'FAIL 5: upload fail not recorded'; end if;
  select processing_status, op_failed_at into v_status, v_failed from public.reviews where id = v_rid;
  if v_status <> 'uploading' or v_failed is null then raise exception 'FAIL 5: uploading fail should set op_failed_at and keep status'; end if;

  -- processing branch: a plain draft review -> processing, then fail -> failed.
  insert into public.reviews (id, user_id, name) values (gen_random_uuid(), auth.uid(), 'Check.md')
    returning id into v_rid;
  v_tok := public.begin_review_op(v_rid, 'processing');
  if v_tok is null then raise exception 'FAIL 5: could not start a check on a draft review'; end if;
  if not public.fail_review_op(v_rid, v_tok) then raise exception 'FAIL 5: check fail not recorded'; end if;
  select processing_status, op_token into v_status, v_tok from public.reviews where id = v_rid;
  if v_status <> 'failed' or v_tok is not null then raise exception 'FAIL 5: processing fail should set failed and clear token (got %)', v_status; end if;

  raise notice 'PASS 5: fail_review_op marks uploading via op_failed_at and processing via `failed`';
end $$;

-- ===========================================================================
-- 6. begin_review_op transition table (active vs recoverable).
-- ===========================================================================
do $$
declare
  v_rid uuid;
  v_fresh timestamptz := now();
  v_stale timestamptz := now() - interval '3 minutes';
  v_sometok uuid := gen_random_uuid();
begin
  insert into public.reviews (id, user_id, name) values (gen_random_uuid(), auth.uid(), 'Matrix.md')
    returning id into v_rid;

  -- draft -> processing allowed; draft -> deleting allowed.
  perform pg_temp.set_state(v_rid,'draft',null,null,null);
  if public.begin_review_op(v_rid,'processing') is null then raise exception 'FAIL 6: draft->processing refused'; end if;
  perform pg_temp.set_state(v_rid,'draft',null,null,null);
  if public.begin_review_op(v_rid,'deleting') is null then raise exception 'FAIL 6: draft->deleting refused'; end if;

  -- complete -> processing REFUSED (no re-run); complete -> deleting allowed.
  perform pg_temp.set_state(v_rid,'complete',null,null,null);
  if public.begin_review_op(v_rid,'processing') is not null then raise exception 'FAIL 6: complete->processing allowed (re-run!)'; end if;
  perform pg_temp.set_state(v_rid,'complete',null,null,null);
  if public.begin_review_op(v_rid,'deleting') is null then raise exception 'FAIL 6: complete->deleting refused'; end if;

  -- failed (check) -> processing allowed (retry on saved files); failed -> deleting allowed.
  perform pg_temp.set_state(v_rid,'failed',null,null,null);
  if public.begin_review_op(v_rid,'processing') is null then raise exception 'FAIL 6: failed->processing refused'; end if;
  perform pg_temp.set_state(v_rid,'failed',null,null,null);
  if public.begin_review_op(v_rid,'deleting') is null then raise exception 'FAIL 6: failed->deleting refused'; end if;

  -- uploading (any) -> processing REFUSED (must finish upload first).
  perform pg_temp.set_state(v_rid,'uploading',v_sometok,v_fresh,null);
  if public.begin_review_op(v_rid,'processing') is not null then raise exception 'FAIL 6: uploading->processing allowed'; end if;

  -- ACTIVE uploading -> deleting BLOCKED (files preserved).
  perform pg_temp.set_state(v_rid,'uploading',v_sometok,v_fresh,null);
  if public.begin_review_op(v_rid,'deleting') is not null then raise exception 'FAIL 6: active uploading->deleting allowed'; end if;
  -- STALE uploading -> deleting allowed (reclaim + clean).
  perform pg_temp.set_state(v_rid,'uploading',v_sometok,v_stale,null);
  if public.begin_review_op(v_rid,'deleting') is null then raise exception 'FAIL 6: stale uploading->deleting refused'; end if;

  -- ACTIVE processing -> processing & deleting BLOCKED.
  perform pg_temp.set_state(v_rid,'processing',v_sometok,v_fresh,null);
  if public.begin_review_op(v_rid,'processing') is not null then raise exception 'FAIL 6: active processing->processing allowed'; end if;
  perform pg_temp.set_state(v_rid,'processing',v_sometok,v_fresh,null);
  if public.begin_review_op(v_rid,'deleting') is not null then raise exception 'FAIL 6: active processing->deleting allowed'; end if;
  -- STALE processing -> processing (retry) & deleting (reclaim) allowed.
  perform pg_temp.set_state(v_rid,'processing',v_sometok,v_stale,null);
  if public.begin_review_op(v_rid,'processing') is null then raise exception 'FAIL 6: stale processing->processing refused'; end if;
  perform pg_temp.set_state(v_rid,'processing',v_sometok,v_stale,null);
  if public.begin_review_op(v_rid,'deleting') is null then raise exception 'FAIL 6: stale processing->deleting refused'; end if;

  -- ACTIVE deleting -> deleting BLOCKED (no competing deletion).
  perform pg_temp.set_state(v_rid,'deleting',v_sometok,v_fresh,null);
  if public.begin_review_op(v_rid,'deleting') is not null then raise exception 'FAIL 6: competing active deletion allowed'; end if;
  -- RECOVERABLE deleting (confirmed failed) -> deleting allowed (recover, new token).
  perform pg_temp.set_state(v_rid,'deleting',v_sometok,v_fresh, now());
  if public.begin_review_op(v_rid,'deleting') is null then raise exception 'FAIL 6: failed deleting could not be recovered'; end if;

  raise notice 'PASS 6: begin_review_op transition table holds (active vs recoverable; no re-run; no competing deletion)';
end $$;

-- ===========================================================================
-- 7. finalize_review_deletion: fence, cleanup record, cascade (incl. decision),
--    and the BEFORE DELETE guard.
-- ===========================================================================
do $$
declare
  v_rid uuid := gen_random_uuid();
  v_did uuid := gen_random_uuid();   -- report document
  v_qid uuid := gen_random_uuid();   -- quotation
  v_iid uuid := gen_random_uuid();   -- issue
  v_tok uuid; v_bad uuid := gen_random_uuid(); n int; v_raised boolean; v_prefix text;
begin
  -- Build a COMPLETE review with a document, quotation, issue, decision, and a
  -- leftover dead-attempt reminder (to prove the cascade clears it too).
  insert into public.reviews (id, user_id, name, processing_status) values (v_rid, auth.uid(), 'ToDelete.md', 'complete');
  insert into public.documents (id, review_id, user_id, role, filename, storage_path)
    values (v_did, v_rid, auth.uid(), 'report', 'r.md', 'a/'||v_rid||'/t/r.md');
  insert into public.quotations (id, review_id, report_document_id, user_id, original_text, start_offset, end_offset, checking_result)
    values (v_qid, v_rid, v_did, auth.uid(), 'quote', 0, 5, 'has_issues');
  insert into public.issues (id, review_id, quotation_id, user_id, issue_type, explanation)
    values (v_iid, v_rid, v_qid, auth.uid(), 'quote_not_found', 'x');
  insert into public.review_decisions (issue_id, user_id, decision) values (v_iid, auth.uid(), 'dismiss');
  insert into public.review_dead_upload_attempts (review_id, user_id, token) values (v_rid, auth.uid(), gen_random_uuid());

  v_prefix := auth.uid()::text || '/' || v_rid::text;

  -- 7a. A raw delete WITHOUT a cleanup record is refused by the guard.
  v_raised := false;
  begin delete from public.reviews where id = v_rid;
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 7a: review deleted without a cleanup record'; end if;

  -- 7b. Enter deleting, then finalize with the WRONG token -> refused.
  v_tok := public.begin_review_op(v_rid, 'deleting');
  if v_tok is null then raise exception 'FAIL 7b: could not enter deleting from complete'; end if;
  v_raised := false;
  begin perform public.finalize_review_deletion(v_rid, v_bad);
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 7b: finalize accepted a wrong delete token'; end if;
  if (select count(*) from public.reviews where id = v_rid) <> 1 then raise exception 'FAIL 7b: fenced finalize deleted the row'; end if;

  -- 7c. Finalize with the correct token: creates the cleanup record and deletes the
  --     review row + cascade (documents, quotations, issues, DECISIONS, reminders).
  if not public.finalize_review_deletion(v_rid, v_tok) then raise exception 'FAIL 7c: finalize returned false'; end if;
  if (select count(*) from public.reviews where id = v_rid) <> 0 then raise exception 'FAIL 7c: review row survived finalize'; end if;
  select count(*) into n from public.review_file_cleanups where user_id = auth.uid() and prefix = v_prefix;
  if n <> 1 then raise exception 'FAIL 7c: whole-prefix cleanup record not created'; end if;
  select count(*) into n from public.review_decisions where issue_id = v_iid;
  if n <> 0 then raise exception 'FAIL 7c: decision survived the deletion cascade (guard blocked it?)'; end if;
  select count(*) into n from public.review_dead_upload_attempts where review_id = v_rid;
  if n <> 0 then raise exception 'FAIL 7c: dead-attempt reminders survived the cascade'; end if;

  raise notice 'PASS 7: finalize fenced; cleanup record created; row+decision+reminders cascaded; delete guard enforced';
end $$;

-- ===========================================================================
-- 8. Decision guard: busy blocks make/change/delete; complete allows make/change.
-- ===========================================================================
do $$
declare
  v_rid uuid := gen_random_uuid();
  v_did uuid := gen_random_uuid();
  v_qid uuid := gen_random_uuid();
  v_i1 uuid := gen_random_uuid();
  v_i2 uuid := gen_random_uuid();
  v_decid uuid; v_raised boolean;
begin
  insert into public.reviews (id, user_id, name, processing_status) values (v_rid, auth.uid(), 'Decide.md', 'complete');
  insert into public.documents (id, review_id, user_id, role, filename, storage_path)
    values (v_did, v_rid, auth.uid(), 'report', 'r.md', 'p');
  insert into public.quotations (id, review_id, report_document_id, user_id, original_text, start_offset, end_offset, checking_result)
    values (v_qid, v_rid, v_did, auth.uid(), 'q', 0, 1, 'has_issues');
  insert into public.issues (id, review_id, quotation_id, user_id, issue_type, explanation)
    values (v_i1, v_rid, v_qid, auth.uid(), 'quote_not_found', 'x'),
           (v_i2, v_rid, v_qid, auth.uid(), 'quote_not_found', 'y');

  -- 8a. On a COMPLETE review, making and changing a decision is allowed.
  insert into public.review_decisions (issue_id, user_id, decision) values (v_i1, auth.uid(), 'dismiss')
    returning id into v_decid;
  update public.review_decisions set decision = 'investigate' where id = v_decid;

  -- 8b. While PROCESSING, make/change/delete are all refused.
  perform pg_temp.set_state(v_rid,'processing',gen_random_uuid(),now(),null);
  v_raised := false;
  begin insert into public.review_decisions (issue_id, user_id, decision) values (v_i2, auth.uid(), 'dismiss');
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 8b: made a decision while processing'; end if;

  v_raised := false;
  begin update public.review_decisions set decision = 'needs_correction' where id = v_decid;
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 8b: changed a decision while processing'; end if;

  v_raised := false;
  begin delete from public.review_decisions where id = v_decid;
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 8b: deleted a decision while processing'; end if;

  -- 8c. While DELETING, a decision change is refused too.
  perform pg_temp.set_state(v_rid,'deleting',gen_random_uuid(),now(),null);
  v_raised := false;
  begin update public.review_decisions set decision = 'dismiss' where id = v_decid;
  exception when sqlstate 'P0001' then v_raised := true; end;
  if not v_raised then raise exception 'FAIL 8c: changed a decision while deleting'; end if;

  -- 8d. Back to complete: changes are allowed again.
  perform pg_temp.set_state(v_rid,'complete',null,null,null);
  update public.review_decisions set decision = 'dismiss' where id = v_decid;

  raise notice 'PASS 8: decision make/change/delete blocked while busy; allowed when complete';
end $$;

-- ===========================================================================
-- 9. review_op_active (migration 20261112020000): ACTIVE (busy, not failed, fresh)
--    vs RECOVERABLE (confirmed-failed or stale). Drives the UI's Delete/Retry gating.
-- ===========================================================================
do $$
declare
  v_rid uuid;
  v_fresh timestamptz := now();
  v_stale timestamptz := now() - interval '3 minutes';
  v_tok uuid := gen_random_uuid();
begin
  insert into public.reviews (id, user_id, name) values (gen_random_uuid(), auth.uid(), 'OpActive')
    returning id into v_rid;

  -- Idle states are never active.
  perform pg_temp.set_state(v_rid, 'draft', null, null, null);
  if public.review_op_active(v_rid) then raise exception 'FAIL 9: draft reported active'; end if;
  perform pg_temp.set_state(v_rid, 'complete', null, null, null);
  if public.review_op_active(v_rid) then raise exception 'FAIL 9: complete reported active'; end if;

  -- processing: fresh+not-failed = ACTIVE; stale OR confirmed-failed = recoverable.
  perform pg_temp.set_state(v_rid, 'processing', v_tok, v_fresh, null);
  if not public.review_op_active(v_rid) then raise exception 'FAIL 9: fresh processing not active'; end if;
  perform pg_temp.set_state(v_rid, 'processing', v_tok, v_stale, null);
  if public.review_op_active(v_rid) then raise exception 'FAIL 9: stale processing reported active'; end if;
  perform pg_temp.set_state(v_rid, 'processing', v_tok, v_fresh, now());
  if public.review_op_active(v_rid) then raise exception 'FAIL 9: confirmed-failed processing reported active'; end if;

  -- uploading: fresh = ACTIVE (blocks Delete); stale = recoverable (Delete enabled).
  perform pg_temp.set_state(v_rid, 'uploading', v_tok, v_fresh, null);
  if not public.review_op_active(v_rid) then raise exception 'FAIL 9: fresh uploading not active'; end if;
  perform pg_temp.set_state(v_rid, 'uploading', v_tok, v_stale, null);
  if public.review_op_active(v_rid) then raise exception 'FAIL 9: stale uploading reported active'; end if;

  -- deleting: fresh = ACTIVE (Retry disabled); stale/failed = recoverable (Retry enabled).
  perform pg_temp.set_state(v_rid, 'deleting', v_tok, v_fresh, null);
  if not public.review_op_active(v_rid) then raise exception 'FAIL 9: fresh deleting not active'; end if;
  perform pg_temp.set_state(v_rid, 'deleting', v_tok, v_stale, null);
  if public.review_op_active(v_rid) then raise exception 'FAIL 9: stale deleting reported active'; end if;
  perform pg_temp.set_state(v_rid, 'deleting', v_tok, v_fresh, now());
  if public.review_op_active(v_rid) then raise exception 'FAIL 9: confirmed-failed deleting reported active'; end if;

  raise notice 'PASS 9: review_op_active distinguishes active vs recoverable (failed/stale) on database time';
end $$;

reset role;
select set_config('request.jwt.claims', '', false);

do $$ begin raise notice '================  ALL CHECKS PASSED  ================'; end $$;

rollback;
