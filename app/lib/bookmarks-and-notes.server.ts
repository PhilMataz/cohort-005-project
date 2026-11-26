import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";
import { noteBodySchema } from "~/lib/notes";

// ─── Bookmarks and Notes ───
// What a Student attaches to a Lesson for themselves and nobody else. See
// GLOSSARY.md for the language.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Every read is scoped to one Student: nothing here lets anyone read
// another person's Bookmarks or Notes. Content access is the caller's job —
// the Lesson page action checks it before calling in.

export type Db = BetterSQLite3Database<typeof schema>;

type Note = typeof notes.$inferSelect;

/**
 * One Student on one Lesson: the pair every Bookmark and Note hangs off, and
 * the pair the unique indexes are on.
 */
export type StudentLesson = { userId: number; lessonId: number };

/** Matches the row a table holds for this Student on this Lesson. */
function rowFor(table: typeof bookmarks | typeof notes, at: StudentLesson) {
  return and(eq(table.userId, at.userId), eq(table.lessonId, at.lessonId));
}

export function isBookmarked(db: Db, at: StudentLesson) {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(rowFor(bookmarks, at))
    .get();
}

/**
 * Adds the Student's Bookmark on the Lesson, or removes it if there is one.
 * Returns whether the Lesson is now bookmarked. The unique index on
 * (user, lesson) means a racing second toggle can never add a duplicate.
 */
export function toggleBookmark(db: Db, at: StudentLesson, now: Date): boolean {
  const removed = db
    .delete(bookmarks)
    .where(rowFor(bookmarks, at))
    .returning({ id: bookmarks.id })
    .all();
  if (removed.length > 0) return false;

  db.insert(bookmarks)
    .values({ ...at, createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return true;
}

export function findNote(db: Db, at: StudentLesson) {
  return db.select().from(notes).where(rowFor(notes, at)).get();
}

export type SaveNoteResult =
  { ok: true; note: Note } | { ok: false; error: string };

/**
 * Creates the Student's Note on the Lesson, or replaces its body if there is
 * one. Either way "last edited" (`updatedAt`) moves to `now`; `createdAt` is
 * kept on a re-save. An over-long or empty body is refused, never truncated.
 */
export function saveNote(
  db: Db,
  at: StudentLesson,
  body: string,
  now: Date
): SaveNoteResult {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid note",
    };
  }

  const savedAt = now.toISOString();
  const note = db
    .insert(notes)
    .values({
      ...at,
      body: parsed.data,
      createdAt: savedAt,
      updatedAt: savedAt,
    })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data, updatedAt: savedAt },
    })
    .returning()
    .get();

  return { ok: true, note };
}

const lessonRef = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  moduleTitle: modules.title,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

/** The Student's Bookmarks, newest first, each with its Lesson and Course. */
export function listBookmarks(db: Db, userId: number) {
  return db
    .select({ id: bookmarks.id, createdAt: bookmarks.createdAt, ...lessonRef })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

/** The Student's Notes, last edited first, each with its Lesson and Course. */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...lessonRef,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
