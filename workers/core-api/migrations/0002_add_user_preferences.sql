-- Migration number: 0002     2026-07-12T22:00:00.000Z
-- Add preferences JSON column to users table for per-user settings (confidence threshold override, default reviewer name)

ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT NULL;
