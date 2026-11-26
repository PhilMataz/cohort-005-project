import { useFetcher } from "react-router";
import { Bookmark, BookmarkCheck, NotebookPen } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { MAX_NOTE_LENGTH } from "~/lib/notes";
import { formatRelativeTime } from "~/lib/utils";

// ─── Bookmarks and Notes on the Lesson page ───
// The bookmark toggle beside the Lesson title and the note box under the
// video. Both post to the Lesson route's action (`toggle-bookmark`,
// `save-note`), which checks content access. See GLOSSARY.md.

export function BookmarkToggle({ bookmarked }: { bookmarked: boolean }) {
  const fetcher = useFetcher<{ ok: boolean }>();
  const isSaving = fetcher.state !== "idle";

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="toggle-bookmark" />
      <Button type="submit" variant="outline" size="sm" disabled={isSaving}>
        {bookmarked ? (
          <BookmarkCheck className="mr-1.5 size-4" />
        ) : (
          <Bookmark className="mr-1.5 size-4" />
        )}
        {bookmarked ? "Bookmarked" : "Bookmark"}
      </Button>
    </fetcher.Form>
  );
}

export function LessonNote({
  note,
}: {
  note: { body: string; updatedAt: string } | null;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const isSaving = fetcher.state !== "idle";
  const error = fetcher.data?.error;

  return (
    <Card className="mb-8">
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-center gap-2">
          <NotebookPen className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Your notes</h2>
        </div>

        <fetcher.Form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="save-note" />
          {/* Plain text, never Markdown: shown back exactly as typed. */}
          <Textarea
            name="body"
            rows={6}
            maxLength={MAX_NOTE_LENGTH}
            defaultValue={note?.body ?? ""}
            placeholder="Only you can read this."
            className="resize-y"
          />
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={isSaving}>
              {isSaving ? "Saving..." : "Save note"}
            </Button>
            {note && !error && (
              <span
                suppressHydrationWarning
                className="text-xs text-muted-foreground"
              >
                Last edited {formatRelativeTime(note.updatedAt)}
              </span>
            )}
            {error && <span className="text-sm text-red-600">{error}</span>}
          </div>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}
