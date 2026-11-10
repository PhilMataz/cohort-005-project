import { useEffect } from "react";
import {
  data,
  isRouteErrorResponse,
  Link,
  redirect,
  useFetcher,
} from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { AlertTriangle, ReceiptText } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { requireAdmin } from "~/lib/access.server";
import {
  decideRefundRequest,
  listOpenRefundRequests,
  type OpenRefundRequest,
  type RefundDecisionResult,
} from "~/lib/refund-decisions.server";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

const decisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
    // Optional when approving: an empty box means no reason.
    reason: z
      .string()
      .trim()
      .max(1000, "Please keep the reason under 1000 characters.")
      .optional()
      .transform((reason) => reason || null),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    reason: z
      .string({ required_error: "Tell the Learner why you are declining." })
      .trim()
      .min(1, "Tell the Learner why you are declining.")
      .max(1000, "Please keep the reason under 1000 characters."),
  }),
]);

const UNDECIDED_RESPONSES: Record<
  Extract<RefundDecisionResult, { decided: false }>["why"],
  { message: string; status: number }
> = {
  "not-found": { message: "Refund request not found.", status: 404 },
  "already-decided": {
    message: "This refund request has already been decided.",
    status: 409,
  },
};

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Decide open refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return { refundRequests: listOpenRefundRequests() };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, decisionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  const { intent, refundRequestId, reason } = parsed.data;
  const result = decideRefundRequest(
    refundRequestId,
    admin.id,
    intent === "approve"
      ? { outcome: "approve", reason }
      : { outcome: "decline", reason }
  );

  if (!result.decided) {
    const { message, status } = UNDECIDED_RESPONSES[result.why];
    throw data(message, { status });
  }

  return redirect("/admin/refunds");
}

function formatWaiting(hours: number) {
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${Math.floor(hours / 24)} days`;
}

function formatWatched(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m watched`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m watched`;
}

function ProgressLine({
  label,
  progress,
  lessonCount,
}: {
  label: string;
  progress: { lessonsCompleted: number; secondsWatched: number } | null;
  lessonCount: number;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">
        {progress
          ? `${progress.lessonsCompleted} of ${lessonCount} lessons · ${formatWatched(progress.secondsWatched)}`
          : "Not recorded"}
      </dd>
    </div>
  );
}

function RefundRequestCard({
  refundRequest,
}: {
  refundRequest: OpenRefundRequest;
}) {
  const fetcher = useFetcher<typeof action>();
  const isDeciding = fetcher.state !== "idle";
  const errors =
    fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : null;

  useEffect(() => {
    const firstError = errors ? Object.values(errors)[0] : undefined;
    if (fetcher.state === "idle" && firstError) toast.error(firstError);
  }, [fetcher.state, errors]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/courses/${refundRequest.courseSlug}`}
              className="text-lg font-semibold hover:underline"
            >
              {refundRequest.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {refundRequest.learnerName} ({refundRequest.learnerEmail}) ·{" "}
              {formatPrice(refundRequest.amountPaid)} paid on{" "}
              {new Date(refundRequest.purchasedAt).toLocaleDateString()}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
            Waiting {formatWaiting(refundRequest.hoursWaiting)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Their reason · asked on{" "}
            {new Date(refundRequest.requestedAt).toLocaleDateString()}
          </p>
          <p className="mt-1 text-sm">{refundRequest.reason}</p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <ProgressLine
            label="Progress when they asked"
            progress={refundRequest.progressWhenRequested}
            lessonCount={refundRequest.lessonCount}
          />
          <ProgressLine
            label="Progress now"
            progress={refundRequest.progressNow}
            lessonCount={refundRequest.lessonCount}
          />
        </dl>
        <fetcher.Form method="post" className="space-y-3">
          <input type="hidden" name="refundRequestId" value={refundRequest.id} />
          <div className="space-y-2">
            <Label htmlFor={`reason-${refundRequest.id}`}>
              Reason for the Learner
            </Label>
            <Textarea
              id={`reason-${refundRequest.id}`}
              name="reason"
              rows={2}
              aria-invalid={errors?.reason ? true : undefined}
              placeholder="Required to decline, optional to approve. The Learner reads this."
            />
            {errors?.reason && (
              <p className="text-sm text-destructive">{errors.reason}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              name="intent"
              value="approve"
              disabled={isDeciding}
            >
              Approve and refund {formatPrice(refundRequest.amountPaid)}
            </Button>
            <Button
              type="submit"
              name="intent"
              value="decline"
              variant="outline"
              disabled={isDeciding}
            >
              Decline
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Approving ends their access to the course and keeps their progress.
            Declining is final. Either way the Learner is emailed.
          </p>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund requests</h1>
        <p className="mt-1 text-muted-foreground">
          Open requests, oldest first.
        </p>
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <ReceiptText className="mx-auto mb-3 size-10" />
            No refund requests are waiting.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) => (
            <RefundRequestCard
              key={refundRequest.id}
              refundRequest={refundRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    title =
      error.status === 401
        ? "Sign in required"
        : error.status === 403
          ? "Access denied"
          : `Error ${error.status}`;
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/admin/refunds">
          <Button>Back to refund requests</Button>
        </Link>
      </div>
    </div>
  );
}
