-- Migration 007: Photo Walk — place text + photo_persons
-- THOUG-132 · Seth v0.3 Photo Walk. Corrected per Gemini pre-build review
-- (2026-07-03): subscriber_id is DENORMALIZED onto photo_persons so every RLS
-- policy is a single-column check — never a join through media_assets →
-- rot_moments (D1 Approved-with-Adjustment; the BLOCKER fix).
--
-- Run as a single transaction (no enum changes, so no split needed).
-- DO NOT APPLY without explicit authorization (schema-first rule).
--
-- Pre-flight verified live 2026-07-03 (project uuzzfeaevxilwizaittq):
--   - rot_moments has NO place column (D2: place_text is new, free text only)
--   - media_assets(asset_id uuid PK) exists; persons(id text PK) exists
--   - current_subscriber_id() exists (SECURITY DEFINER, subscribers.auth_user_id)

ALTER TABLE rot_moments ADD COLUMN place_text text;

CREATE TABLE photo_persons (
  photo_person_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES media_assets(asset_id) ON DELETE CASCADE,
  person_id text REFERENCES persons(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  match_confidence text NOT NULL DEFAULT 'unmatched'
    CHECK (match_confidence IN ('exact','fuzzy','ambiguous','unmatched')),
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','committed','removed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_photo_persons_subscriber ON photo_persons (subscriber_id);
CREATE INDEX idx_photo_persons_asset ON photo_persons (asset_id);
CREATE INDEX idx_photo_persons_person ON photo_persons (person_id)
  WHERE person_id IS NOT NULL;

ALTER TABLE photo_persons ENABLE ROW LEVEL SECURITY;

CREATE POLICY photo_persons_owner ON photo_persons
  USING (subscriber_id = current_subscriber_id())
  WITH CHECK (subscriber_id = current_subscriber_id());
