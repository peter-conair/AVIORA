-- Columns that ask for a number, not a tick (docs/64).
--
-- "ชั่งน้ำหนัก (kg.)" appears at every stage of the 6WNY sheet. Recorded as a
-- tick it says the scales were used and throws away what they said, which is
-- the only thing the customer actually cares about.

ALTER TABLE tracker_steps ADD COLUMN IF NOT EXISTS capture_unit text;
ALTER TABLE tracker_marks ADD COLUMN IF NOT EXISTS value numeric(10,2);
