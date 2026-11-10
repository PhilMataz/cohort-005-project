import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

// The route talks to the real schema, in a fresh in-memory database per test.
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

import { loader } from "./settings";
import { setCurrentUserId } from "~/lib/session";

const {
  users,
  categories,
  courses,
  purchases,
  refunds,
  UserRole,
  CourseStatus,
  RefundStatus,
} = schema;

function seedLearner(name = "Liam Learner") {
  return testDb.current
    .insert(users)
    .values({
      name,
      email: `${name.split(" ")[0].toLowerCase()}@example.com`,
      role: UserRole.Learner,
    })
    .returning()
    .get();
}

function seedCourse(title: string, slug: string) {
  const db = testDb.current;
  const instructor =
    db.select().from(users).where(eq(users.role, UserRole.Instructor)).get() ??
    db
      .insert(users)
      .values({
        name: "Ina Instructor",
        email: "ina@example.com",
        role: UserRole.Instructor,
      })
      .returning()
      .get();
  const category =
    db.select().from(categories).get() ??
    db
      .insert(categories)
      .values({ name: "Programming", slug: "programming" })
      .returning()
      .get();
  return db
    .insert(courses)
    .values({
      title,
      slug,
      description: title,
      salesCopy: title,
      instructorId: instructor.id,
      categoryId: category.id,
      status: CourseStatus.Published,
      price: 7900,
    })
    .returning()
    .get();
}

function seedRefundRequest(
  learnerId: number,
  courseId: number,
  {
    status,
    amountPaid,
    reason,
    requestedAt,
  }: {
    status: schema.RefundStatus;
    amountPaid: number;
    reason: string;
    requestedAt: string;
  }
) {
  const purchase = testDb.current
    .insert(purchases)
    .values({ userId: learnerId, courseId, amountPaid, country: "US" })
    .returning()
    .get();
  testDb.current
    .insert(refunds)
    .values({ purchaseId: purchase.id, status, reason, requestedAt })
    .run();
}

async function loadSettings(userId: number) {
  const setCookie = await setCurrentUserId(
    new Request("http://localhost/"),
    userId
  );
  return loader({
    request: new Request("http://localhost/settings", {
      headers: { Cookie: setCookie.split(";")[0] },
    }),
    params: {},
    context: {},
  } as Parameters<typeof loader>[0]);
}

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb.current = drizzle(sqlite, { schema });
  migrate(testDb.current, { migrationsFolder: "drizzle" });
});

describe("Settings, Refund Requests", () => {
  it("lists every Refund Request the Learner has made, newest first, with a plain-language status", async () => {
    const learner = seedLearner();
    const typescript = seedCourse("Introduction to TypeScript", "typescript");
    const react = seedCourse("React Basics", "react");
    const node = seedCourse("Node in Depth", "node");
    seedRefundRequest(learner.id, typescript.id, {
      status: RefundStatus.Approved,
      amountPaid: 7900,
      reason: "Not what I expected at all.",
      requestedAt: "2026-11-01T10:00:00.000Z",
    });
    seedRefundRequest(learner.id, react.id, {
      status: RefundStatus.Declined,
      amountPaid: 3950,
      reason: "Changed my mind about it.",
      requestedAt: "2026-11-03T10:00:00.000Z",
    });
    seedRefundRequest(learner.id, node.id, {
      status: RefundStatus.Requested,
      amountPaid: 4900,
      reason: "Too advanced for me right now.",
      requestedAt: "2026-11-05T10:00:00.000Z",
    });

    const { refundRequests } = await loadSettings(learner.id);

    expect(refundRequests).toEqual([
      expect.objectContaining({
        courseTitle: "Node in Depth",
        amountPaid: 4900,
        reason: "Too advanced for me right now.",
        requestedAt: "2026-11-05T10:00:00.000Z",
        statusLabel: "Waiting for review",
      }),
      expect.objectContaining({
        courseTitle: "React Basics",
        amountPaid: 3950,
        reason: "Changed my mind about it.",
        requestedAt: "2026-11-03T10:00:00.000Z",
        statusLabel: "Declined",
      }),
      expect.objectContaining({
        courseTitle: "Introduction to TypeScript",
        amountPaid: 7900,
        reason: "Not what I expected at all.",
        requestedAt: "2026-11-01T10:00:00.000Z",
        statusLabel: "Refunded",
      }),
    ]);
  });

  it("leaves out other Learners' Refund Requests", async () => {
    const learner = seedLearner();
    const other = seedLearner("Olga Other");
    const course = seedCourse("Introduction to TypeScript", "typescript");
    seedRefundRequest(other.id, course.id, {
      status: RefundStatus.Requested,
      amountPaid: 7900,
      reason: "Not what I expected at all.",
      requestedAt: "2026-11-01T10:00:00.000Z",
    });

    const { refundRequests } = await loadSettings(learner.id);

    expect(refundRequests).toEqual([]);
  });
});
