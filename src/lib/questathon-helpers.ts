export type SourceStatus = "claim" | "told" | "verified" | "unknown";
export type DashboardStatus = "idle" | "ready" | "stale" | "error";

export interface NormalizedValue {
  label: string;
  value: string;
  status: SourceStatus;
  source?: string;
  evidenceUrl?: string;
}

export interface AccountCard {
  id: string;
  name: string;
  status: DashboardStatus;
  bookValue: NormalizedValue[];
  powerMap: NormalizedValue[];
  nextMoves: NormalizedValue[];
  risks: NormalizedValue[];
  knowledgeGaps: NormalizedValue[];
}

export interface DashboardSnapshot {
  accounts: AccountCard[];
  lastSyncedAt: string | null;
  status: DashboardStatus;
  message: string;
  rateLimit: {
    perMinute: number;
    nextAvailableAt: string | null;
    lastRequestAt: string | null;
  };
}

const ACCOUNT_NAMES = [
  "Eastern Counties Police Alliance",
  "Aldermoor Industrial Group",
] as const;

function isUnknownResourceValue(value: unknown): boolean {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "" || ["unknown", "unknown account", "n/a", "na", "none", "not available", "null", "undefined"].includes(raw);
}

function isAccountSlotReady(account: AccountCard | null | undefined): boolean {
  if (!account) return false;
  const name = String(account.name ?? "").trim();
  const id = String(account.id ?? "").trim();
  return name.length > 0 && !isUnknownResourceValue(name) && id.length > 0 && !isUnknownResourceValue(id);
}

export function buildEmptyAccount(name: string): AccountCard {
  return {
    id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    status: "idle",
    bookValue: [
      { label: "Deals", value: "Unknown", status: "unknown" },
      { label: "Original currencies", value: "Unknown", status: "unknown" },
      { label: "Supported amount", value: "Unknown", status: "unknown" },
      { label: "Verification status", value: "Unknown", status: "unknown" },
      { label: "Source IDs", value: "Unknown", status: "unknown" },
      { label: "Evidence", value: "Unknown", status: "unknown" },
    ],
    powerMap: [
      { label: "Decision-makers", value: "Unknown", status: "unknown" },
      { label: "Payers", value: "Unknown", status: "unknown" },
      { label: "Users", value: "Unknown", status: "unknown" },
      { label: "Blockers", value: "Unknown", status: "unknown" },
      { label: "Relationship status", value: "Unknown", status: "unknown" },
    ],
    nextMoves: [
      { label: "Priority", value: "Unknown", status: "unknown" },
      { label: "Task", value: "Unknown", status: "unknown" },
      { label: "Owner", value: "Unknown", status: "unknown" },
      { label: "Due date", value: "Unknown", status: "unknown" },
      { label: "Related deal", value: "Unknown", status: "unknown" },
      { label: "Source", value: "Unknown", status: "unknown" },
    ],
    risks: [
      { label: "Deadlines", value: "Unknown", status: "unknown" },
      { label: "Stalled deals", value: "Unknown", status: "unknown" },
      { label: "Cold stakeholders", value: "Unknown", status: "unknown" },
      { label: "Blockers", value: "Unknown", status: "unknown" },
    ],
    knowledgeGaps: [
      { label: "Missing fact", value: "Unknown", status: "unknown" },
      { label: "Why it matters", value: "Unknown", status: "unknown" },
      { label: "Who can answer", value: "Unknown", status: "unknown" },
    ],
  };
}

function statusRateLimit(nextAvailableAtMs: number | null, lastRequestAtMs: number | null): DashboardSnapshot["rateLimit"] {
  return {
    perMinute: 1,
    nextAvailableAt: nextAvailableAtMs ? new Date(nextAvailableAtMs).toISOString() : null,
    lastRequestAt: lastRequestAtMs ? new Date(lastRequestAtMs).toISOString() : null,
  };
}

function buildStaleSnapshot(snapshot: DashboardSnapshot | null, message: string, nextAvailableAtMs: number | null, lastRequestAtMs: number | null): DashboardSnapshot {
  const fallback = snapshot ?? {
    accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
    lastSyncedAt: null,
    status: "stale",
    message,
    rateLimit: statusRateLimit(nextAvailableAtMs, lastRequestAtMs),
  };

  return {
    ...fallback,
    status: "stale",
    message,
    rateLimit: statusRateLimit(nextAvailableAtMs, lastRequestAtMs),
  };
}

function buildRefreshInProgressSnapshot(snapshot: DashboardSnapshot | null, nextAvailableAtMs: number | null, lastRequestAtMs: number | null): DashboardSnapshot {
  const message = "A Questathon refresh is already running. Waiting for the latest valid data.";
  const fallback = snapshot ?? {
    accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
    lastSyncedAt: null,
    status: "stale",
    message,
    rateLimit: statusRateLimit(nextAvailableAtMs, lastRequestAtMs),
  };

  return {
    ...fallback,
    status: "stale",
    message,
    rateLimit: statusRateLimit(nextAvailableAtMs, lastRequestAtMs),
  };
}

export function isDashboardSnapshotValid(snapshot: DashboardSnapshot | null | undefined): boolean {
  if (!snapshot || !Array.isArray(snapshot.accounts) || snapshot.accounts.length < 2) {
    return false;
  }

  return snapshot.accounts.slice(0, 2).every((account) => isAccountSlotReady(account));
}

export function decideDashboardRefresh(
  snapshot: DashboardSnapshot | null,
  opts: {
    inFlight: boolean;
    nowMs: number;
    nextAvailableAtMs: number | null;
    lastRequestAtMs?: number | null;
  },
): { action: "reuse" | "refresh" | "stale"; snapshot: DashboardSnapshot | null; nextAvailableAt: string | null } {
  if (!snapshot || !snapshot.lastSyncedAt) {
    return { action: "refresh", snapshot: null, nextAvailableAt: null };
  }

  if (isDashboardSnapshotValid(snapshot)) {
    return { action: "reuse", snapshot, nextAvailableAt: snapshot.rateLimit.nextAvailableAt ?? null };
  }

  if (opts.inFlight) {
    return {
      action: "stale",
      snapshot: buildRefreshInProgressSnapshot(snapshot, opts.nextAvailableAtMs, opts.lastRequestAtMs ?? null),
      nextAvailableAt: opts.nextAvailableAtMs ? new Date(opts.nextAvailableAtMs).toISOString() : null,
    };
  }

  if (opts.nextAvailableAtMs && opts.nowMs < opts.nextAvailableAtMs) {
    return {
      action: "stale",
      snapshot: buildStaleSnapshot(
        snapshot,
        "Persisted dashboard snapshot is invalid. A refresh is queued, but the Questathon request rate limit is still active.",
        opts.nextAvailableAtMs,
        opts.lastRequestAtMs ?? null,
      ),
      nextAvailableAt: new Date(opts.nextAvailableAtMs).toISOString(),
    };
  }

  return {
    action: "refresh",
    snapshot,
    nextAvailableAt: opts.nextAvailableAtMs ? new Date(opts.nextAvailableAtMs).toISOString() : null,
  };
}
