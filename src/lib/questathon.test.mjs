import test from "node:test";
import assert from "node:assert/strict";

import { decideDashboardRefresh, isDashboardSnapshotValid } from "./questathon-helpers.ts";

function makeAccount(name, id) {
  return {
    id,
    name,
    status: "ready",
    bookValue: [],
    powerMap: [],
    nextMoves: [],
    risks: [],
    knowledgeGaps: [],
  };
}

function makeSnapshot({
  firstName = "Unknown",
  firstId = "unknown",
  secondName = "Unknown",
  secondId = "unknown",
} = {}) {
  return {
    accounts: [
      makeAccount(firstName, firstId),
      makeAccount(secondName, secondId),
    ],
    lastSyncedAt: "2026-11-14T00:00:00.000Z",
    status: "ready",
    message: "Questathon sync completed.",
    rateLimit: {
      perMinute: 1,
      nextAvailableAt: null,
      lastRequestAt: null,
    },
  };
}

test("rejects a snapshot whose first two accounts are still Unknown", () => {
  const snapshot = makeSnapshot({
    firstName: "Unknown",
    firstId: "unknown",
    secondName: "Unknown",
    secondId: "unknown",
  });

  assert.equal(isDashboardSnapshotValid(snapshot), false);

  const decision = decideDashboardRefresh(snapshot, {
    inFlight: false,
    nowMs: Date.now(),
    nextAvailableAtMs: null,
  });

  assert.equal(decision.action, "refresh");
  assert.equal(decision.snapshot, snapshot);
});

test("reuses a valid snapshot when the dashboard data is ready", () => {
  const snapshot = makeSnapshot({
    firstName: "Eastern Counties Police Alliance",
    firstId: "ecpa-001",
    secondName: "Aldermoor Industrial Group",
    secondId: "aig-001",
  });

  assert.equal(isDashboardSnapshotValid(snapshot), true);

  const decision = decideDashboardRefresh(snapshot, {
    inFlight: false,
    nowMs: Date.now(),
    nextAvailableAtMs: null,
  });

  assert.equal(decision.action, "reuse");
  assert.equal(decision.snapshot, snapshot);
});

test("treats an invalid cached snapshot as stale when a rate-limited refresh is still blocked", () => {
  const snapshot = makeSnapshot({
    firstName: "Unknown",
    firstId: "unknown",
    secondName: "Aldermoor Industrial Group",
    secondId: "aig-001",
  });

  assert.equal(isDashboardSnapshotValid(snapshot), false);

  const decision = decideDashboardRefresh(snapshot, {
    inFlight: false,
    nowMs: 1_000,
    nextAvailableAtMs: 60_000,
  });

  assert.equal(decision.action, "stale");
  assert.ok(decision.snapshot);
  assert.equal(decision.snapshot.status, "stale");
});