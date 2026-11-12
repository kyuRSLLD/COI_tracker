-- Apply only after independent review to a dedicated pilot database. Never run at startup.
-- The application role needs SELECT, INSERT, UPDATE and DELETE on this table.
-- The separate config table must be provisioned by an administrator; the app
-- role gets SELECT only, never INSERT, UPDATE, DELETE, TRUNCATE or ownership.
CREATE TABLE public.pilot_rate_config_v1 (
  singleton boolean PRIMARY KEY CHECK (singleton = true),
  key_check bytea NOT NULL CHECK (octet_length(key_check) = 32)
);
CREATE TABLE public.pilot_rate_buckets_v1 (
  bucket_key bytea NOT NULL CHECK (octet_length(bucket_key) = 32),
  minute bigint NOT NULL,
  hits integer NOT NULL CHECK (hits > 0 AND hits <= 1000000),
  PRIMARY KEY (bucket_key, minute)
);
CREATE INDEX pilot_rate_buckets_v1_expiry ON public.pilot_rate_buckets_v1 (minute);
