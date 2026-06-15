-- T-08-08: add sales_records_book_id_idx for efficient cumulative GROUP BY book_id
-- The existing unique (book_id, year_month) covers leading-column lookups but
-- a dedicated single-column index helps the planner choose it for GROUP BY book_id
-- without the year_month column in the predicate.
CREATE INDEX IF NOT EXISTS "sales_records_book_id_idx" ON "sales_records" ("book_id");
