-- Two durable facts the successor transition needs (spec §7.9a third check: an
-- observation proves what was true when it was taken, so the ability to act must
-- be revoked, not merely reported).
--
-- 1. REVOCATION. A successor takes an attempt's PR and capacity only after
--    observing that attempt's sandbox stopped; that observation says nothing
--    about a start issued a moment later. The takeover therefore marks the
--    attempt revoked in the SAME transition, and the attempt's sandbox refuses
--    every later start. The column is also the one durable "known stopped" fact
--    the cap counts read: an expired row whose attempt may still act holds a
--    slot until this is set (or until its launch row proves no paid work was
--    ever sent).
ALTER TABLE review_launches ADD COLUMN revoked_ms INTEGER;

-- 2. DISPATCH INTENT. A fresh recovery claim can read a run `in_progress`
--    before the first terminal update lands and then send the same update
--    again. Recording the intent in the same fenced write that acquires the
--    action, BEFORE the request, makes "a terminal update was sent" durable:
--    from then on the outcome is unknown and may only be DISCOVERED (readback),
--    never re-sent. A validated response clears it (the dispatch resolved), and
--    so does a definitively pre-send refusal (nothing left the Worker).
ALTER TABLE review_checks ADD COLUMN terminal_dispatch_ms INTEGER;
