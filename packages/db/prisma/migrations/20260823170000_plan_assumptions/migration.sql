-- Planning assumptions (docs/69).
--
-- Only ever used where a member's own history is too thin to measure the rate.
-- On the goal row because an assumption belongs to the plan it was made for.

ALTER TABLE business_goals
  ADD COLUMN IF NOT EXISTS assumed_order_value_minor integer,
  ADD COLUMN IF NOT EXISTS assumed_contact_rate      integer,
  ADD COLUMN IF NOT EXISTS assumed_conversion_rate   integer;
