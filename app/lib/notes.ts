import { z } from "zod";

// ─── Note body ───
// The one rule for what a Note may hold, shared by the Lesson page's form
// parsing and the service that writes Notes. Client-safe: no database imports.

export const MAX_NOTE_LENGTH = 2000;

/** Plain text, trimmed, 1–2,000 characters. Never rendered as Markdown. */
export const noteBodySchema = z
  .string()
  .trim()
  .min(1, "Write something before saving your note.")
  .max(
    MAX_NOTE_LENGTH,
    `A note can be at most ${MAX_NOTE_LENGTH.toLocaleString("en")} characters.`
  );
