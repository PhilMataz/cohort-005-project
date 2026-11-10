import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "~/db/schema";

// The routes talk to the real schema, in a fresh in-memory database per test.
const testDb = vi.hoisted(() => ({
  current: undefined as unknown as ReturnType<typeof drizzle<typeof schema>>,
}));

vi.mock("~/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const value = Reflect.get(testDb.current, prop);
        return typeof value === "function" ? value.bind(testDb.current) : value;
      },
    }
  ),
}));

import { loader, action } from "./admin.refunds";
import { action as requestRefundAction } from "./courses.$slug.refund";
import { loader as coursePageLoader } from "./courses.$slug";
import { loader as settingsLoader } from "./settings";
import { action as purchaseAction } from "./courses.$slug.purchase";
import { loader as studentsLoader } from "./instructor.$courseId.students";
import { loader as analyticsLoader } from "./instructor.analytics";
import { getAccess } from "~/lib/access.server";
import { setCurrentUserId } from "~/lib/session";

const {
  users,
  categories,
  courses,
  modules,
  lessons,
  purchases,
  enrollments,
  lessonProgress,
  videoWatchEvents,
  UserRole,
  CourseStatus,
  LessonProgressStatus,
} = schema;

const NOW = new Date(2026, 10, 9, 12, 0, 0);

function hoursAfterNow(hours: number) {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000);
}

function seedUser(name: string, role: schema.UserRole) {
  return testDb.current
    .insert(users)
    .values({
      name,
      email: `${name.split(" ")[0].toLowerCase()}@example.com`,
      role,
    })
    .returning()
    .get();
}

function seedPlatform() {
  const admin = seedUser("Ada Admin", UserRole.Admin);
  const instructor = seedUser("Ina Instructor", UserRole.Instructor);
  const category = testDb.current
    .insert(categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();
  return { admin, instructor, category };
}

function seedCourse(
  instructorId: number,
  categoryId: number,
  { title, slug, lessonCount }: { title: string; slug: string; lessonCount: number }
) {
  const db = testDb.current;
  const course = db
    .insert(courses)
    .values({
      title,
      slug,
      description: title,
      salesCopy: title,
      instructorId,
      categoryId,
      status: CourseStatus.Published,
      price: 7900,
      pppEnabled: false,
    })
    .returning()
    .get();
  const mod = db
    .insert(modules)
    .values({ courseId: course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  const lessonIds = Array.from(
    { length: lessonCount },
    (_, i) =>
      db
        .insert(lessons)
        .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
        .returning()
        .get().id
  );
  return { course, lessonIds };
}

/** A Purchase and its Enrollment, as the purchase page makes them. */
function buyCourse(learnerId: number, courseId: number, amountPaid = 7900) {
  const purchase = testDb.current
    .insert(purchases)
    .values({
      userId: learnerId,
      courseId,
      amountPaid,
      country: "US",
      createdAt: NOW.toISOString(),
    })
    .returning()
    .get();
  testDb.current
    .insert(enrollments)
    .values({ userId: learnerId, courseId, enrolledAt: NOW.toISOString() })
    .run();
  return purchase;
}

function completeLessons(learnerId: number, lessonIds: number[]) {
  for (const lessonId of lessonIds) {
    testDb.current
      .insert(lessonProgress)
      .values({
        userId: learnerId,
        lessonId,
        status: LessonProgressStatus.Completed,
      })
      .run();
  }
}

function watch(learnerId: number, lessonId: number, seconds: number) {
  testDb.current
    .insert(videoWatchEvents)
    .values({
      userId: learnerId,
      lessonId,
      eventType: "progress",
      positionSeconds: seconds,
    })
    .run();
}

function rate(learnerId: number, courseId: number, rating: number) {
  testDb.current
    .insert(schema.courseRatings)
    .values({ userId: learnerId, courseId, rating })
    .run();
}

async function cookieFor(userId: number) {
  const setCookie = await setCurrentUserId(
    new Request("http://localhost/"),
    userId
  );
  return setCookie.split(";")[0];
}

type Outcome = { status: number | undefined; message?: unknown };

async function settle(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    const result = await run();
    if (result instanceof Response) return { status: result.status };
    if (result && typeof result === "object" && "init" in result) {
      const shaped = result as { data: unknown; init: ResponseInit | null };
      return { status: shaped.init?.status, message: shaped.data };
    }
    return { status: 200, message: result };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status };
    const rejection = thrown as { data: unknown; init: ResponseInit | null };
    return { status: rejection.init?.status, message: rejection.data };
  }
}

/** The Learner asks for a refund through the course page's form. */
async function askForRefund(
  learnerId: number,
  slug: string,
  reason = "This course is not right for me after all."
) {
  const request = new Request(`http://localhost/courses/${slug}/refund`, {
    method: "POST",
    headers: {
      Cookie: await cookieFor(learnerId),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ reason }),
  });
  const outcome = await settle(() =>
    requestRefundAction({
      request,
      params: { slug },
      context: {},
    } as Parameters<typeof requestRefundAction>[0])
  );
  expect(outcome.status).toBe(302);
}

async function loadRefundRequests(userId: number) {
  const request = new Request("http://localhost/admin/refunds", {
    headers: { Cookie: await cookieFor(userId) },
  });
  return loader({
    request,
    params: {},
    context: {},
  } as Parameters<typeof loader>[0]);
}

async function decide(userId: number, form: Record<string, string>) {
  const request = new Request("http://localhost/admin/refunds", {
    method: "POST",
    headers: {
      Cookie: await cookieFor(userId),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  return settle(() =>
    action({
      request,
      params: {},
      context: {},
    } as Parameters<typeof action>[0])
  );
}

async function loadCoursePage(userId: number, slug: string) {
  const request = new Request(`http://localhost/courses/${slug}`, {
    headers: { Cookie: await cookieFor(userId) },
  });
  return coursePageLoader({
    request,
    params: { slug },
    context: {},
  } as Parameters<typeof coursePageLoader>[0]);
}

async function loadSettings(userId: number) {
  const request = new Request("http://localhost/settings", {
    headers: { Cookie: await cookieFor(userId) },
  });
  return settingsLoader({
    request,
    params: {},
    context: {},
  } as Parameters<typeof settingsLoader>[0]);
}

/** The emails sent so far, which go to the server log. */
function sentEmails() {
  return vi
    .mocked(console.log)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith("[email]"));
}

/** A Learner with an open Refund Request on a course with 4 lessons. */
async function seedOpenRefundRequest() {
  const { admin, instructor, category } = seedPlatform();
  const liam = seedUser("Liam Learner", UserRole.Learner);
  const { course, lessonIds } = seedCourse(instructor.id, category.id, {
    title: "Introduction to TypeScript",
    slug: "typescript",
    lessonCount: 4,
  });
  buyCourse(liam.id, course.id, 3950);
  completeLessons(liam.id, lessonIds.slice(0, 1));
  await askForRefund(liam.id, "typescript");
  const [open] = (await loadRefundRequests(admin.id)).refundRequests;
  return { admin, instructor, liam, course, lessonIds, refundRequestId: String(open.id) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});

  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb.current = drizzle(sqlite, { schema });
  migrate(testDb.current, { migrationsFolder: "drizzle" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Refund Requests, on the Admin screen", () => {
  it("lists open requests oldest first, with Progress when asked and now", async () => {
    const { admin, instructor, category } = seedPlatform();
    const liam = seedUser("Liam Learner", UserRole.Learner);
    const maya = seedUser("Maya Learner", UserRole.Learner);
    const typescript = seedCourse(instructor.id, category.id, {
      title: "Introduction to TypeScript",
      slug: "typescript",
      lessonCount: 4,
    });
    const react = seedCourse(instructor.id, category.id, {
      title: "React Basics",
      slug: "react",
      lessonCount: 4,
    });

    buyCourse(maya.id, react.course.id, 4900);
    buyCourse(liam.id, typescript.course.id, 7900);

    completeLessons(liam.id, typescript.lessonIds.slice(0, 1));
    watch(liam.id, typescript.lessonIds[0], 600);
    await askForRefund(liam.id, "typescript", "Bought the wrong course.");

    vi.setSystemTime(hoursAfterNow(5));
    await askForRefund(maya.id, "react", "Too basic for what I need.");

    // Liam keeps learning while his request waits.
    completeLessons(liam.id, typescript.lessonIds.slice(1, 2));
    watch(liam.id, typescript.lessonIds[1], 300);

    vi.setSystemTime(hoursAfterNow(3 * 24));
    const { refundRequests } = await loadRefundRequests(admin.id);

    expect(refundRequests).toMatchObject([
      {
        courseTitle: "Introduction to TypeScript",
        learnerName: "Liam Learner",
        amountPaid: 7900,
        reason: "Bought the wrong course.",
        requestedAt: NOW.toISOString(),
        hoursWaiting: 72,
        lessonCount: 4,
        progressWhenRequested: { lessonsCompleted: 1, secondsWatched: 600 },
        progressNow: { lessonsCompleted: 2, secondsWatched: 900 },
      },
      {
        courseTitle: "React Basics",
        learnerName: "Maya Learner",
        amountPaid: 4900,
        reason: "Too basic for what I need.",
        hoursWaiting: 67,
        progressWhenRequested: { lessonsCompleted: 0, secondsWatched: 0 },
        progressNow: { lessonsCompleted: 0, secondsWatched: 0 },
      },
    ]);
  });

  it.each([
    ["an Instructor", UserRole.Instructor],
    ["a Learner", UserRole.Learner],
  ])("cannot be seen or decided by %s", async (_label, role) => {
    const { admin, instructor, category } = seedPlatform();
    const liam = seedUser("Liam Learner", UserRole.Learner);
    const { course } = seedCourse(instructor.id, category.id, {
      title: "Introduction to TypeScript",
      slug: "typescript",
      lessonCount: 4,
    });
    buyCourse(liam.id, course.id);
    await askForRefund(liam.id, "typescript");
    const [open] = (await loadRefundRequests(admin.id)).refundRequests;
    const outsider =
      role === UserRole.Instructor
        ? instructor
        : seedUser("Otto Learner", UserRole.Learner);

    const seen = await settle(() => loadRefundRequests(outsider.id));
    const approved = await decide(outsider.id, {
      intent: "approve",
      refundRequestId: String(open.id),
    });

    expect(seen.status).toBe(403);
    expect(approved.status).toBe(403);
  });
});

describe("Approving a Refund Request", () => {
  it("refunds the amount paid and ends the Learner's access to the course", async () => {
    const { admin, liam, refundRequestId } = await seedOpenRefundRequest();

    const outcome = await decide(admin.id, {
      intent: "approve",
      refundRequestId,
    });

    expect(outcome.status).toBe(302);
    expect((await loadRefundRequests(admin.id)).refundRequests).toEqual([]);
    expect((await loadSettings(liam.id)).refundRequests).toMatchObject([
      { statusLabel: "Refunded", amountRefunded: 3950 },
    ]);
    expect(await loadCoursePage(liam.id, "typescript")).toMatchObject({
      enrolled: false,
      lessonProgressMap: {},
    });
  });

  it("emails the Learner the amount refunded, and that their Progress is kept", async () => {
    const { admin, refundRequestId } = await seedOpenRefundRequest();

    await decide(admin.id, { intent: "approve", refundRequestId });

    const email = sentEmails().at(-1);
    expect(email).toContain("to=liam@example.com");
    expect(email).toContain(
      "subject=Your refund is approved: Introduction to TypeScript"
    );
    expect(email).toContain("We have refunded $39.50");
    expect(email).toContain("no longer have access");
    expect(email).toContain("your progress is kept");
  });

  it("can be decided by an Admin on their own Purchase", async () => {
    const { admin, instructor, category } = seedPlatform();
    const { course } = seedCourse(instructor.id, category.id, {
      title: "Introduction to TypeScript",
      slug: "typescript",
      lessonCount: 4,
    });
    buyCourse(admin.id, course.id);
    await askForRefund(admin.id, "typescript");
    const [open] = (await loadRefundRequests(admin.id)).refundRequests;

    const outcome = await decide(admin.id, {
      intent: "approve",
      refundRequestId: String(open.id),
    });

    expect(outcome.status).toBe(302);
  });
});

describe("Declining a Refund Request", () => {
  it("needs a reason", async () => {
    const { admin, refundRequestId } = await seedOpenRefundRequest();

    const outcome = await decide(admin.id, {
      intent: "decline",
      refundRequestId,
      reason: "   ",
    });

    expect(outcome).toEqual({
      status: 400,
      message: { errors: { reason: "Tell the Learner why you are declining." } },
    });
    expect((await loadRefundRequests(admin.id)).refundRequests).toHaveLength(1);
  });

  it("refunds nothing and leaves the Learner's access in place", async () => {
    const { admin, liam, refundRequestId } = await seedOpenRefundRequest();

    const outcome = await decide(admin.id, {
      intent: "decline",
      refundRequestId,
      reason: "You have finished most of the hands-on project.",
    });

    expect(outcome.status).toBe(302);
    expect((await loadSettings(liam.id)).refundRequests).toMatchObject([
      {
        statusLabel: "Declined",
        amountRefunded: null,
        decisionReason: "You have finished most of the hands-on project.",
      },
    ]);
    expect(await loadCoursePage(liam.id, "typescript")).toMatchObject({
      enrolled: true,
    });
  });

  it("emails the Learner the reason, and that their access continues", async () => {
    const { admin, refundRequestId } = await seedOpenRefundRequest();

    await decide(admin.id, {
      intent: "decline",
      refundRequestId,
      reason: "You have finished most of the hands-on project.",
    });

    const email = sentEmails().at(-1);
    expect(email).toContain("to=liam@example.com");
    expect(email).toContain(
      "subject=Your refund request was declined: Introduction to TypeScript"
    );
    expect(email).toContain("You have finished most of the hands-on project.");
    expect(email).toContain("You keep your access to the course");
  });
});

describe("After a Refund", () => {
  it("the Learner cannot reach the course's content", async () => {
    const { admin, liam, course, refundRequestId } =
      await seedOpenRefundRequest();
    await decide(admin.id, { intent: "approve", refundRequestId });

    const access = await getAccess(
      new Request("http://localhost/", {
        headers: { Cookie: await cookieFor(liam.id) },
      }),
      course.id
    );

    expect(access).toMatchObject({ enrolled: false, canViewContent: false });
  });

  it("buying the course again brings the earlier Progress back", async () => {
    const { admin, liam, lessonIds, refundRequestId } =
      await seedOpenRefundRequest();
    await decide(admin.id, { intent: "approve", refundRequestId });

    const outcome = await settle(async () =>
      purchaseAction({
        request: new Request("http://localhost/courses/typescript/purchase", {
          method: "POST",
          headers: {
            Cookie: await cookieFor(liam.id),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ intent: "confirm-purchase" }),
        }),
        params: { slug: "typescript" },
        context: {},
      } as Parameters<typeof purchaseAction>[0])
    );

    expect(outcome.status).toBe(302);
    expect(await loadCoursePage(liam.id, "typescript")).toMatchObject({
      enrolled: true,
      lessonProgressMap: { [lessonIds[0]]: LessonProgressStatus.Completed },
    });
  });
});

describe("After a Refund, for the course and its Instructor", () => {
  async function seedRefundedAndStayingLearners() {
    const { admin, instructor, liam, course, refundRequestId } =
      await seedOpenRefundRequest();
    const maya = seedUser("Maya Learner", UserRole.Learner);
    buyCourse(maya.id, course.id);
    rate(liam.id, course.id, 1);
    rate(maya.id, course.id, 5);
    await decide(admin.id, { intent: "approve", refundRequestId });
    return { instructor, liam, maya, course };
  }

  it("the refunded Learner's rating no longer counts towards the average", async () => {
    const { maya } = await seedRefundedAndStayingLearners();

    const { ratingSummary } = await loadCoursePage(maya.id, "typescript");

    expect(ratingSummary).toEqual({ average: 5, count: 1 });
  });

  it("the refunded Learner leaves the Instructor's student list", async () => {
    const { instructor, course } = await seedRefundedAndStayingLearners();

    const { students } = await studentsLoader({
      request: new Request(`http://localhost/instructor/${course.id}/students`, {
        headers: { Cookie: await cookieFor(instructor.id) },
      }),
      params: { courseId: String(course.id) },
      context: {},
    } as Parameters<typeof studentsLoader>[0]);

    expect(students.map((student) => student.name)).toEqual(["Maya Learner"]);
  });

  it("the Instructor's revenue is shown after the Refund", async () => {
    const { instructor } = await seedRefundedAndStayingLearners();

    const url = new URL("http://localhost/instructor/analytics?range=all");
    const { summary } = await analyticsLoader({
      request: new Request(url, {
        headers: { Cookie: await cookieFor(instructor.id) },
      }),
      url,
      params: {},
      context: {},
    } as unknown as Parameters<typeof analyticsLoader>[0]);

    // Maya's $79.00 stays; Liam's $39.50 was refunded.
    expect(summary).toMatchObject({ grossCents: 7900, purchaseCount: 2 });
  });
});

describe("A decided Refund Request", () => {
  it.each([
    ["approved", { intent: "approve" }],
    ["declined", { intent: "decline", reason: "Outside our policy." }],
  ])("cannot be decided again once %s", async (_label, firstDecision) => {
    const { admin, refundRequestId } = await seedOpenRefundRequest();
    await decide(admin.id, { ...firstDecision, refundRequestId });

    const again = await decide(admin.id, {
      intent: "approve",
      refundRequestId,
    });

    expect(again).toEqual({
      status: 409,
      message: "This refund request has already been decided.",
    });
  });
});
