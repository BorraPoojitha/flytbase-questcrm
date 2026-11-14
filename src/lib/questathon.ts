import {
  ensureDatabaseReady,
  withDbClient,
} from "@/lib/db";
import {
  enqueueRequest,
  finishQueuedRequest,
  lockNextQueuedRequest,
} from "@/lib/request-queue";
import {
  loadCacheEntry,
  loadPersistenceState,
  recordNotesAudit,
  saveCacheEntry,
  savePersistenceState,
} from "@/lib/persisted-state";

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

const cache: {
  data: DashboardSnapshot | null;
  lastUpdated: number | null;
  lastError: string | null;
  lastRequestAt: number | null;
  nextRequestAt: number | null;
  pendingPromise: Promise<DashboardSnapshot> | null;
} = {
  data: null,
  lastUpdated: null,
  lastError: null,
  lastRequestAt: null,
  nextRequestAt: null,
  pendingPromise: null,
};

const UNKNOWN_VALUE = "Unknown";

function makeEmptySnapshot(message = "No data available yet."): DashboardSnapshot {
  return {
    accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
    lastSyncedAt: null,
    status: "error",
    message,
    rateLimit: {
      perMinute: 1,
      nextAvailableAt: null,
      lastRequestAt: null,
    },
  };
}

function findNestedRecordCandidates(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== "object") {
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => findNestedRecordCandidates(entry, out));
    return out;
  }

  const record = value as Record<string, unknown>;
  const looksLikeRecord =
    typeof record.name === "string" ||
    typeof record.account === "string" ||
    typeof record.company === "string" ||
    typeof record.entity === "string" ||
    typeof record.account_name === "string" ||
    typeof record.customer === "string" ||
    Array.isArray(record.stakeholders) ||
    Array.isArray(record.deals) ||
    Array.isArray(record.offers) ||
    Array.isArray(record.opportunities) ||
    Array.isArray(record.facts) ||
    Array.isArray(record.risks);

  if (looksLikeRecord) {
    out.push(record);
  }

  Object.values(record).forEach((nested) => findNestedRecordCandidates(nested, out));
  return out;
}

function extractExportRecords(exportPayload: unknown): Record<string, unknown>[] {
  if (!exportPayload) return [];

  if (Array.isArray(exportPayload)) {
    return exportPayload.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }

  if (typeof exportPayload === "object") {
    const root = exportPayload as Record<string, unknown>;
    const directCandidates = [
      root.data,
      root.records,
      root.items,
      root.results,
      root.accounts,
      root.deals,
      root.clients,
      root.partners,
      root.customers,
      root.entities,
    ];

    for (const candidate of directCandidates) {
      const values = Array.isArray(candidate)
        ? candidate.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : candidate && typeof candidate === "object"
          ? [candidate as Record<string, unknown>]
          : [];
      if (values.length > 0) {
        return values;
      }
    }

    const nested = findNestedRecordCandidates(root);
    if (nested.length > 0) return nested;
  }

  return [];
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry) => toStringValue(entry))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const str = toStringValue(value).trim();
  return str && str !== UNKNOWN_VALUE ? [str] : [];
}

function coerceAccountName(value: unknown): string | null {
  const raw = toStringValue(value).trim();
  if (!raw || raw === UNKNOWN_VALUE) return null;
  return raw;
}

function readNestedValue(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function recordMatchesTargetAccount(record: Record<string, unknown>): boolean {
  const candidateNames = [
    coerceAccountName(record.account),
    coerceAccountName(record.company),
    coerceAccountName(record.entity),
    coerceAccountName(record.name),
    coerceAccountName(record.account_name),
    coerceAccountName(record.customer),
    ...normalizeStringArray(readNestedValue(record, ["account", "name"])),
    ...normalizeStringArray(readNestedValue(record, ["company", "name"])),
  ].filter((value): value is string => !!value);

  if (candidateNames.length === 0) return false;
  return candidateNames.some((name) => ACCOUNT_NAMES.some((target) => target.toLowerCase() === name.toLowerCase()));
}

function DEFAULT_SNAPSHOT(): DashboardSnapshot {
  return {
    accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
    lastSyncedAt: null,
    status: "idle",
    message: "Sync has not run yet.",
    rateLimit: {
      perMinute: 1,
      nextAvailableAt: null,
      lastRequestAt: null,
    },
  };
}

function UNKNOWN_SNAPSHOT(message: string): DashboardSnapshot {
  return {
    accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
    lastSyncedAt: null,
    status: "error",
    message,
    rateLimit: {
      perMinute: 1,
      nextAvailableAt: null,
      lastRequestAt: null,
    },
  };
}

function getSyncErrorSnapshot(message: string): DashboardSnapshot {
  return {
    accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
    lastSyncedAt: null,
    status: "error",
    message,
    rateLimit: {
      perMinute: 1,
      nextAvailableAt: null,
      lastRequestAt: null,
    },
  };
}

function isEmptyDashboardSnapshot(snapshot: DashboardSnapshot | null | undefined): boolean {
  if (!snapshot) return true;
  return !snapshot.lastSyncedAt && snapshot.accounts.every((account) => account.bookValue.every((field) => field.value === UNKNOWN_VALUE));
}

function normalizeStatus(value: unknown): SourceStatus {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["verified", "confirmed", "checked", "validated"].includes(raw)) return "verified";
  if (["told", "stated", "reported"].includes(raw)) return "told";
  if (["claim", "claimed", "asserted"].includes(raw)) return "claim";
  return "unknown";
}

function toStringValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return UNKNOWN_VALUE;
  if (typeof value === "string") return value.trim() || UNKNOWN_VALUE;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toStringValue(item)).join(", ");
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return UNKNOWN_VALUE;
    return keys.map((key) => `${key}: ${toStringValue((value as Record<string, unknown>)[key])}`).join("; ");
  }
  return String(value);
}

function safeText(value: unknown): string {
  const text = toStringValue(value);
  return text === UNKNOWN_VALUE ? UNKNOWN_VALUE : text;
}

function findAccountName(record: Record<string, unknown>): string {
  const candidateNames = collectCandidateNameValues(record);
  return candidateNames[0] || "Unknown account";
}

function collectCandidateNameValues(record: Record<string, unknown>): string[] {
  const candidateValues = [
    record.account,
    record.company,
    record.entity,
    record.name,
    record.account_name,
    record.customer,
    readNestedValue(record, ["account", "name"]),
    readNestedValue(record, ["company", "name"]),
    readNestedValue(record, ["entity", "name"]),
    readNestedValue(record, ["customer", "name"]),
  ];

  return candidateValues
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        const nestedName = nested.name ?? nested.account ?? nested.company ?? nested.entity ?? nested.customer ?? nested.account_name;
        if (typeof nestedName === "string") return [nestedName];
      }
      return [];
    })
    .map((value) => toStringValue(value).trim())
    .filter((value): value is string => !!value && value !== UNKNOWN_VALUE);
}

function matchAccountName(name: string): string {
  const normalized = name.trim();
  return ACCOUNT_NAMES.find((accountName) => accountName.toLowerCase() === normalized.toLowerCase()) ?? normalized;
}

function toRecordList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

function buildEmptyAccount(name: string): AccountCard {
  return {
    id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    status: "idle",
    bookValue: [
      { label: "Deals", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Original currencies", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Supported amount", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Verification status", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Source IDs", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Evidence", value: UNKNOWN_VALUE, status: "unknown" },
    ],
    powerMap: [
      { label: "Decision-makers", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Payers", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Users", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Blockers", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Relationship status", value: UNKNOWN_VALUE, status: "unknown" },
    ],
    nextMoves: [
      { label: "Priority", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Task", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Owner", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Due date", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Related deal", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Source", value: UNKNOWN_VALUE, status: "unknown" },
    ],
    risks: [
      { label: "Deadlines", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Stalled deals", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Cold stakeholders", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Blockers", value: UNKNOWN_VALUE, status: "unknown" },
    ],
    knowledgeGaps: [
      { label: "Missing fact", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Why it matters", value: UNKNOWN_VALUE, status: "unknown" },
      { label: "Who can answer", value: UNKNOWN_VALUE, status: "unknown" },
    ],
  };
}

function normalizeAccountRecord(rawAccount: Record<string, unknown>, fallbackName?: string): AccountCard {
  const sourceAccount = rawAccount && typeof rawAccount === "object" ? rawAccount : {};
  const name = matchAccountName(findAccountName(sourceAccount) || fallbackName || "Unknown account");
  const account = buildEmptyAccount(name);

  const stakeholders = Array.isArray(sourceAccount.stakeholders) ? (sourceAccount.stakeholders as Record<string, unknown>[]) : [];
  const offers = Array.isArray(sourceAccount.offers) ? (sourceAccount.offers as Record<string, unknown>[]) : [];
  const facts = Array.isArray(sourceAccount.facts) ? (sourceAccount.facts as Record<string, unknown>[]) : [];
  const opportunities = Array.isArray(sourceAccount.opportunities) ? (sourceAccount.opportunities as Record<string, unknown>[]) : [];
  const deadlines = Array.isArray(sourceAccount.deadlines) ? (sourceAccount.deadlines as Record<string, unknown>[]) : [];

  const stakeholderNames = stakeholders
    .map((stakeholder) => safeText(stakeholder.name ?? stakeholder.role))
    .filter((value) => value !== UNKNOWN_VALUE);

  const decisionMakers = stakeholderNames.length > 0 ? stakeholderNames.join(", ") : UNKNOWN_VALUE;
  const relationshipStatus = stakeholders.length > 0
    ? stakeholders.map((stakeholder) => `${safeText(stakeholder.name ?? stakeholder.role)}: ${safeText(stakeholder.relationship)}`).join("; ")
    : UNKNOWN_VALUE;

  const blockerText = opportunities
    .map((opportunity) => opportunity.blocker)
    .filter((value) => value && typeof value === "object")
    .map((blocker) => safeText((blocker as Record<string, unknown>).text ?? (blocker as Record<string, unknown>).status))
    .join("; ");

  const offerIds = offers.map((offer) => safeText(offer.id)).filter((value) => value !== UNKNOWN_VALUE);
  const offerValues = offers.map((offer) => safeText(offer.value)).filter((value) => value !== UNKNOWN_VALUE);
  const factsStatusSignal = facts.some((fact) => normalizeStatus(fact.status) === "verified")
    ? "verified"
    : facts.some((fact) => normalizeStatus(fact.status) === "told")
      ? "told"
      : facts.some((fact) => normalizeStatus(fact.status) === "claim")
        ? "claim"
        : "unknown";

  account.bookValue = [
    {
      label: "Deals",
      value: offers.length > 0 ? `${offers.length} offer(s)` : opportunities.length > 0 ? `${opportunities.length} opportunity(ies)` : UNKNOWN_VALUE,
      status: factsStatusSignal as SourceStatus,
    },
    { label: "Original currencies", value: "Unknown", status: "unknown" as SourceStatus },
    { label: "Supported amount", value: offerValues.length > 0 ? offerValues.join(", ") : UNKNOWN_VALUE, status: factsStatusSignal as SourceStatus },
    { label: "Verification status", value: factsStatusSignal === "unknown" ? "Unknown" : factsStatusSignal, status: factsStatusSignal as SourceStatus },
    { label: "Source IDs", value: offerIds.length > 0 ? offerIds.join(", ") : UNKNOWN_VALUE, status: "unknown" as SourceStatus },
    {
      label: "Evidence",
      value: sourceAccount.files ? safeText((sourceAccount.files as Record<string, unknown>[]).map((file) => file.id ?? file.title).join(", ")) : UNKNOWN_VALUE,
      status: "unknown" as SourceStatus,
    },
  ];

  account.powerMap = [
    { label: "Decision-makers", value: decisionMakers, status: "unknown" as SourceStatus },
    { label: "Payers", value: UNKNOWN_VALUE, status: "unknown" as SourceStatus },
    { label: "Users", value: stakeholderNames.length > 0 ? stakeholderNames.join(", ") : UNKNOWN_VALUE, status: "unknown" as SourceStatus },
    { label: "Blockers", value: blockerText || UNKNOWN_VALUE, status: blockerText ? ("told" as SourceStatus) : ("unknown" as SourceStatus) },
    { label: "Relationship status", value: relationshipStatus, status: "unknown" as SourceStatus },
  ];

  const nextMoveFields: Array<{ label: string; value: string; status: SourceStatus }> = [
    { label: "Priority", value: offers.length > 0 ? safeText(offers[0].status) : UNKNOWN_VALUE, status: normalizeStatus(offers[0]?.status) },
    { label: "Task", value: offers.length > 0 ? safeText(offers[0].title) : UNKNOWN_VALUE, status: normalizeStatus(offers[0]?.status) },
    { label: "Owner", value: offers.length > 0 ? safeText(offers[0].pitch_to) : UNKNOWN_VALUE, status: normalizeStatus(offers[0]?.status) },
    { label: "Due date", value: UNKNOWN_VALUE, status: "unknown" },
    { label: "Related deal", value: offers.length > 0 ? safeText(offers[0].id) : UNKNOWN_VALUE, status: normalizeStatus(offers[0]?.status) },
    { label: "Source", value: offers.length > 0 ? safeText(offers[0].id) : UNKNOWN_VALUE, status: normalizeStatus(offers[0]?.status) },
  ];

  account.nextMoves = nextMoveFields;

  account.risks = [
    {
      label: "Deadlines",
      value: deadlines.length > 0 ? deadlines.map((deadline) => safeText((deadline as Record<string, unknown>).text ?? deadline)).join("; ") : "No public deadline disclosed",
      status: deadlines.length > 0 ? ("told" as SourceStatus) : ("unknown" as SourceStatus),
    },
    {
      label: "Stalled deals",
      value: offers.some((offer) => safeText(offer.status) === "declined")
        ? offers.filter((offer) => safeText(offer.status) === "declined").map((offer) => safeText(offer.title)).join(", ")
        : "No stalled deal disclosed",
      status: offers.some((offer) => safeText(offer.status) === "declined") ? ("told" as SourceStatus) : ("unknown" as SourceStatus),
    },
    {
      label: "Cold stakeholders",
      value: stakeholders.some((stakeholder) => safeText(stakeholder.relationship) === "neutral")
        ? stakeholders.filter((stakeholder) => safeText(stakeholder.relationship) === "neutral").map((stakeholder) => safeText(stakeholder.name)).join(", ")
        : "No cold stakeholder disclosed",
      status: stakeholders.some((stakeholder) => safeText(stakeholder.relationship) === "neutral") ? ("told" as SourceStatus) : ("unknown" as SourceStatus),
    },
    { label: "Blockers", value: blockerText || "No blocker disclosed", status: blockerText ? ("told" as SourceStatus) : ("unknown" as SourceStatus) },
  ];

  account.knowledgeGaps = [
    { label: "Missing fact", value: "Original currency and payer data are not in the public export.", status: "unknown" as SourceStatus },
    { label: "Why it matters", value: "Finance and procurement need currency and funding ownership to validate the deal value and budget route.", status: "told" as SourceStatus },
    { label: "Who can answer", value: stakeholderNames.length > 0 ? stakeholderNames.join(", ") : "Unknown stakeholder contact", status: "unknown" as SourceStatus },
  ];

  return account;
}

function buildAccountSet(records: Record<string, unknown>[]): AccountCard[] {
  const byName = new Map<string, Record<string, unknown>>();

  records.forEach((record) => {
    const candidateNames = collectCandidateNameValues(record);

    for (const candidate of candidateNames) {
      const matched = matchAccountName(candidate);
      if (!matched || matched === "Unknown account") continue;
      byName.set(matched, record);
    }
  });

  const accounts = ACCOUNT_NAMES.map((accountName) => {
    const accountRecord = byName.get(accountName) ?? {};
    return normalizeAccountRecord(accountRecord, accountName);
  });

  return accounts.filter((account) => account.name !== "Unknown account");
}

function normalizeAccountPayload(exportPayload: unknown): AccountCard[] {
  const candidateRecords = extractExportRecords(exportPayload);
  const directAccountNodes = Array.isArray(exportPayload) ? exportPayload : ((exportPayload as Record<string, unknown>)?.accounts ?? []);
  const accountLists = Array.isArray(directAccountNodes) ? directAccountNodes : [];
  const effectiveRecords = accountLists.length > 0 ? accountLists : candidateRecords;

  const targetRecords = effectiveRecords.filter((record) => {
    if (!record || typeof record !== "object") return false;
    const nameValue = record.name ?? (record as Record<string, unknown>).account ?? (record as Record<string, unknown>).company ?? (record as Record<string, unknown>).entity;
    const idValue = (record as Record<string, unknown>).id ?? (record as Record<string, unknown>).account_id ?? (record as Record<string, unknown>).accountId;
    if (typeof nameValue === "string" && typeof idValue === "string") {
      return ACCOUNT_NAMES.some((target) => target.toLowerCase() === String(nameValue).toLowerCase());
    }
    return recordMatchesTargetAccount(record as Record<string, unknown>);
  });

  const normalized = buildAccountSet(targetRecords.length > 0 ? targetRecords : effectiveRecords);

  const matches = normalized.length > 0 ? normalized : ACCOUNT_NAMES.map((name) => buildEmptyAccount(name));
  const readySnapshot: DashboardSnapshot = {
    accounts: matches,
    lastSyncedAt: new Date().toISOString(),
    status: "ready",
    message: "Questathon sync completed.",
    rateLimit: {
      perMinute: 1,
      nextAvailableAt: null,
      lastRequestAt: null,
    },
  };

  logSafeSyncDiagnostics(readySnapshot, {
    accountMatches: matches.length,
    candidateRecords: exportPayload && typeof exportPayload === "object" ? Object.keys(exportPayload as Record<string, unknown>).length : 0,
    targetMatches: matches.filter((account) => account.name !== "Unknown account").length,
  });
  return matches;
}

const DASHBOARD_CACHE_KEY = "questathon-dashboard";
const REFRESH_IN_FLIGHT_KEY = "questathon-dashboard-refresh-in-flight";
const LAST_REQUEST_AT_KEY = "questathon-last-request-at";
const RATE_LIMIT_MS = 60000;
const REFRESH_LOCK_TTL_MS = 180000;

type RefreshLockState = {
  active: boolean;
  lockedAt: number | null;
  expiresAt: number | null;
};

const EMPTY_REFRESH_LOCK: RefreshLockState = {
  active: false,
  lockedAt: null,
  expiresAt: null,
};

function isRefreshLockActive(lockState: RefreshLockState | boolean | null | undefined): boolean {
  if (typeof lockState === "boolean") return lockState;
  if (!lockState || !lockState.active) return false;
  if (!lockState.expiresAt) return true;
  return Date.now() < lockState.expiresAt;
}

async function getRefreshLockState(): Promise<RefreshLockState> {
  const state = await loadPersistenceState<RefreshLockState>(REFRESH_IN_FLIGHT_KEY, EMPTY_REFRESH_LOCK);
  if (!state.active) {
    return EMPTY_REFRESH_LOCK;
  }

  if (state.expiresAt && Date.now() > state.expiresAt) {
    return EMPTY_REFRESH_LOCK;
  }

  return state;
}

async function acquireRefreshLock(): Promise<boolean> {
  const now = Date.now();
  const current = await getRefreshLockState();
  if (isRefreshLockActive(current)) {
    return false;
  }

  await savePersistenceState(REFRESH_IN_FLIGHT_KEY, {
    active: true,
    lockedAt: now,
    expiresAt: now + REFRESH_LOCK_TTL_MS,
  });
  return true;
}

async function releaseRefreshLock(): Promise<void> {
  await savePersistenceState(REFRESH_IN_FLIGHT_KEY, EMPTY_REFRESH_LOCK);
}

function buildRateLimit(rateLimit: { perMinute: number; nextAvailableAt: string | null; lastRequestAt: string | null }): DashboardSnapshot["rateLimit"] {
  return {
    perMinute: rateLimit.perMinute,
    nextAvailableAt: rateLimit.nextAvailableAt,
    lastRequestAt: rateLimit.lastRequestAt,
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
    rateLimit: statusRateLimit(nextAvailableAtMs, fallback.rateLimit.lastRequestAt ? Date.parse(fallback.rateLimit.lastRequestAt) : lastRequestAtMs),
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
    rateLimit: statusRateLimit(nextAvailableAtMs, fallback.rateLimit.lastRequestAt ? Date.parse(fallback.rateLimit.lastRequestAt) : lastRequestAtMs),
  };
}

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

export function isDashboardSnapshotValid(snapshot: DashboardSnapshot | null | undefined): boolean {
  if (!snapshot || !Array.isArray(snapshot.accounts) || snapshot.accounts.length < 2) {
    return false;
  }

  return snapshot.accounts.slice(0, 2).every((account) => isAccountSlotReady(account));
}

export function decideDashboardRefresh(snapshot: DashboardSnapshot | null, opts: { inFlight: boolean; nowMs: number; nextAvailableAtMs: number | null }): { action: "reuse" | "refresh" | "stale"; snapshot: DashboardSnapshot | null; nextAvailableAt: string | null } {
  if (!snapshot || !snapshot.lastSyncedAt) {
    return { action: "refresh", snapshot: null, nextAvailableAt: null };
  }

  if (isDashboardSnapshotValid(snapshot)) {
    return { action: "reuse", snapshot, nextAvailableAt: snapshot.rateLimit.nextAvailableAt ?? null };
  }

  if (opts.inFlight) {
    return {
      action: "stale",
      snapshot: buildRefreshInProgressSnapshot(snapshot, opts.nextAvailableAtMs, cache.lastRequestAt ?? (snapshot.rateLimit.lastRequestAt ? Date.parse(snapshot.rateLimit.lastRequestAt) : null)),
      nextAvailableAt: opts.nextAvailableAtMs ? new Date(opts.nextAvailableAtMs).toISOString() : null,
    };
  }

  if (opts.nextAvailableAtMs && opts.nowMs < opts.nextAvailableAtMs) {
    return {
      action: "stale",
      snapshot: buildStaleSnapshot(snapshot, "Persisted dashboard snapshot is invalid. A refresh is queued, but the Questathon request rate limit is still active.", opts.nextAvailableAtMs, cache.lastRequestAt ?? (snapshot.rateLimit.lastRequestAt ? Date.parse(snapshot.rateLimit.lastRequestAt) : null)),
      nextAvailableAt: new Date(opts.nextAvailableAtMs).toISOString(),
    };
  }

  return {
    action: "refresh",
    snapshot,
    nextAvailableAt: opts.nextAvailableAtMs ? new Date(opts.nextAvailableAtMs).toISOString() : null,
  };
}

async function getRateLimitState(): Promise<{ lastRequestAt: number | null }> {
  return loadPersistenceState<{ lastRequestAt: number | null }>(LAST_REQUEST_AT_KEY, { lastRequestAt: null });
}

async function requestQuestathon<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const token = process.env.AQ_TOKEN;
  if (!token) {
    return null;
  }

  const rateLimitState = await getRateLimitState();
  const lastKnownRequestAt = cache.lastRequestAt ?? rateLimitState.lastRequestAt ?? null;
  const nextAllowedAt = lastKnownRequestAt ? lastKnownRequestAt + RATE_LIMIT_MS : null;

  if (nextAllowedAt && Date.now() < nextAllowedAt) {
    const waitTime = nextAllowedAt - Date.now();
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  cache.lastRequestAt = Date.now();
  cache.nextRequestAt = cache.lastRequestAt + RATE_LIMIT_MS;
  await savePersistenceState(LAST_REQUEST_AT_KEY, { lastRequestAt: cache.lastRequestAt });

  const response = await fetch(`${process.env.QUESTATHON_BASE_URL || "https://questathon.aihackerscollective.com"}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Questathon request failed (${path}): ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function fetchAndNormalizeExport(): Promise<AccountCard[]> {
  const exportPayload = await requestQuestathon<Record<string, unknown> | Record<string, unknown>[] | unknown[]>('/api/public/v1/export');
  if (!exportPayload) return ACCOUNT_NAMES.map((name) => buildEmptyAccount(name));

  const normalized = normalizeAccountPayload(exportPayload);
  return normalized.length > 0 ? normalized : ACCOUNT_NAMES.map((name) => buildEmptyAccount(name));
}

async function maybeLoadAdditionalSignals(): Promise<void> {
  if (!process.env.AQ_TOKEN) return;

  try {
    await requestQuestathon('/api/public/v1/signals');
    await requestQuestathon('/api/public/v1/schema');
    await requestQuestathon('/api/public/v1/pack/A/all');
    await requestQuestathon('/api/public/v1/pack/B/all');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown downstream sync error';
    cache.lastError = message;
  }
}

export async function processQueuedRequests(): Promise<boolean> {
  if (!process.env.AQ_TOKEN) return false;

  const item = await lockNextQueuedRequest();
  if (!item) return false;

  const baseUrl = process.env.QUESTATHON_BASE_URL || 'https://questathon.aihackerscollective.com';

  try {
    const response = await fetch(`${baseUrl}${item.endpoint}`, {
      method: item.method,
      headers: {
        Authorization: `Bearer ${process.env.AQ_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: item.payload ? JSON.stringify(item.payload) : undefined,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    await finishQueuedRequest(item.id, true);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown request queue failure';
    await finishQueuedRequest(item.id, false, message);
    return false;
  }
}

export async function syncQuestathonData(): Promise<DashboardSnapshot> {
  await ensureDatabaseReady();

  if (!process.env.AQ_TOKEN || !process.env.QUESTATHON_BASE_URL) {
    const fallback = await loadPersistenceState<DashboardSnapshot>(DASHBOARD_CACHE_KEY, {
      accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
      lastSyncedAt: null,
      status: 'idle',
      message: 'No AQ_TOKEN configured. Server-side sync is disabled until a valid token is supplied.',
      rateLimit: {
        perMinute: 1,
        nextAvailableAt: null,
        lastRequestAt: null,
      },
    });
    cache.data = fallback;
    return fallback;
  }

  await processQueuedRequests();

  const cached = await loadCacheEntry<DashboardSnapshot>(DASHBOARD_CACHE_KEY);
  const lockState = await getRefreshLockState();
  const rateState = await getRateLimitState();
  const nextAvailableAtMs = rateState.lastRequestAt ? rateState.lastRequestAt + RATE_LIMIT_MS : null;

  if (cached && cached.lastSyncedAt && isDashboardSnapshotValid(cached)) {
    cache.data = cached;
    cache.lastUpdated = Date.now();
    return cached;
  }

  const invalidDecision = decideDashboardRefresh(cached ?? null, {
    inFlight: isRefreshLockActive(lockState) || !!cache.pendingPromise,
    nowMs: Date.now(),
    nextAvailableAtMs,
  });

  if (invalidDecision.action === 'stale') {
    cache.data = invalidDecision.snapshot ?? cached ?? null;
    cache.lastUpdated = Date.now();
    return invalidDecision.snapshot ?? cached ?? buildStaleSnapshot(null, 'Questathon dashboard snapshot is stale and waiting for refresh.', nextAvailableAtMs, rateState.lastRequestAt);
  }

  if (cache.pendingPromise) {
    return await cache.pendingPromise;
  }

  const inFlightGuard = async (): Promise<DashboardSnapshot> => {
    try {
      const acquired = await acquireRefreshLock();
      if (!acquired) {
        const activeLock = await getRefreshLockState();
        const staleSnapshot = cached ?? {
          accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
          lastSyncedAt: null,
          status: "stale",
          message: "A Questathon fetch is already running. Waiting for the latest data.",
          rateLimit: statusRateLimit(nextAvailableAtMs, rateState.lastRequestAt ?? cache.lastRequestAt ?? null),
        };

        const snapshot = {
          ...staleSnapshot,
          status: "stale",
          message: isRefreshLockActive(activeLock)
            ? "A Questathon fetch is already running. Waiting for the latest data."
            : "The previous refresh lock expired; another sync will start shortly.",
          rateLimit: statusRateLimit(nextAvailableAtMs, rateState.lastRequestAt ?? cache.lastRequestAt ?? null),
        } as DashboardSnapshot;

        cache.data = snapshot;
        cache.lastUpdated = Date.now();
        return snapshot;
      }

      const accounts = await fetchAndNormalizeExport();
      await maybeLoadAdditionalSignals();

      const validationSnapshot: DashboardSnapshot = {
        accounts,
        lastSyncedAt: new Date().toISOString(),
        status: isDashboardSnapshotValid({
          accounts,
          lastSyncedAt: new Date().toISOString(),
          status: "ready",
          message: "",
          rateLimit: { perMinute: 1, nextAvailableAt: null, lastRequestAt: null },
        })
          ? "ready"
          : "error",
        message: isDashboardSnapshotValid({
          accounts,
          lastSyncedAt: new Date().toISOString(),
          status: "ready",
          message: "",
          rateLimit: { perMinute: 1, nextAvailableAt: null, lastRequestAt: null },
        })
          ? "Questathon sync completed. Values are limited to data returned by the upstream API."
          : "Questathon refresh failed validation: both target account names and IDs remain unknown.",
        rateLimit: statusRateLimit(nextAvailableAtMs, rateState.lastRequestAt ?? cache.lastRequestAt ?? null),
      };

      if (!isDashboardSnapshotValid(validationSnapshot)) {
        const preserved = cached ?? {
          accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
          lastSyncedAt: null,
          status: "error",
          message: "Questathon refresh failed validation: both target account names and IDs remain unknown.",
          rateLimit: statusRateLimit(nextAvailableAtMs, rateState.lastRequestAt ?? cache.lastRequestAt ?? null),
        };

        const invalid: DashboardSnapshot = {
          ...preserved,
          status: "error",
          message: "Questathon refresh failed validation: both target account names and IDs remain unknown. Previous snapshot preserved for diagnosis.",
          rateLimit: statusRateLimit(nextAvailableAtMs, rateState.lastRequestAt ?? cache.lastRequestAt ?? null),
        };

        cache.data = invalid;
        cache.lastUpdated = Date.now();
        return invalid;
      }

      await saveCacheEntry(DASHBOARD_CACHE_KEY, validationSnapshot, 300000);
      await savePersistenceState(DASHBOARD_CACHE_KEY, validationSnapshot);
      cache.data = validationSnapshot;
      cache.lastUpdated = Date.now();
      cache.lastError = null;
      return validationSnapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sync failure";
      const preserved = cached ?? {
        accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
        lastSyncedAt: null,
        status: "error",
        message,
        rateLimit: statusRateLimit(nextAvailableAtMs, rateState.lastRequestAt ?? cache.lastRequestAt ?? null),
      };

      const snapshot: DashboardSnapshot = {
        ...preserved,
        status: "error",
        message: `Questathon sync failed: ${message}. Previous snapshot preserved for diagnosis.`,
        rateLimit: statusRateLimit(nextAvailableAtMs, rateState.lastRequestAt ?? cache.lastRequestAt ?? null),
      };

      cache.data = snapshot;
      cache.lastUpdated = Date.now();
      cache.lastError = message;
      return snapshot;
    } finally {
      cache.pendingPromise = null;
      await releaseRefreshLock();
    }
  };

  cache.pendingPromise = inFlightGuard();
  return await cache.pendingPromise;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  await ensureDatabaseReady();

  if (cache.data && cache.lastUpdated && Date.now() - cache.lastUpdated < 30000) {
    return cache.data;
  }

  const databaseCached = await loadCacheEntry<DashboardSnapshot>(DASHBOARD_CACHE_KEY);
  if (databaseCached && databaseCached.lastSyncedAt && isDashboardSnapshotValid(databaseCached)) {
    cache.data = databaseCached;
    cache.lastUpdated = Date.now();
    return databaseCached;
  }

  if (databaseCached && databaseCached.lastSyncedAt) {
    const refreshLock = await getRefreshLockState();
    const rateState = await getRateLimitState();
    const nextAvailableAtMs = rateState.lastRequestAt ? rateState.lastRequestAt + RATE_LIMIT_MS : null;
    const decision = decideDashboardRefresh(databaseCached, {
      inFlight: isRefreshLockActive(refreshLock) || !!cache.pendingPromise,
      nowMs: Date.now(),
      nextAvailableAtMs: nextAvailableAtMs,
    });

    if (decision.action === 'stale') {
      cache.data = decision.snapshot ?? databaseCached;
      cache.lastUpdated = Date.now();
      return decision.snapshot ?? databaseCached;
    }

    if (decision.action === 'reuse') {
      cache.data = decision.snapshot ?? databaseCached;
      cache.lastUpdated = Date.now();
      return decision.snapshot ?? databaseCached;
    }
  }

  return syncQuestathonData();
}

export async function queueNoteWrite(input: {
  account: string;
  kind: string;
  title: string;
  text: string;
}): Promise<{ success: boolean; queued: boolean; id?: string; message: string }> {
  if (!input.account || !input.kind || !input.title || !input.text) {
    return { success: false, queued: false, message: "account, kind, title and text are required." };
  }

  const payload = {
    account: input.account,
    kind: input.kind,
    title: input.title,
    text: input.text,
  };

  const queueItem = await enqueueRequest("/api/public/v1/notes", "POST", payload);

  await recordNotesAudit({
    account: input.account,
    kind: input.kind,
    title: input.title,
    text: input.text,
    source: "admin",
  });

  return {
    success: true,
    queued: true,
    id: queueItem.id,
    message: "Note accepted into the shared request queue. Actual upstream write status remains pending verification.",
  };
}

export async function getNotesAudit(limit = 10) {
  return withDbClient(async (client) => {
    const result = await client.query(
      `SELECT account, kind, title, text, source, created_at
       FROM notes_audit ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );

    return result.rows;
  });
}

function getSafeSyncDiagnostics(snapshot: DashboardSnapshot | null, source: { accountMatches?: number; candidateRecords?: number; targetMatches?: number; cacheAgeMs?: number | null; lastError?: string | null } = {}) {
  return {
    accountMatches: source.accountMatches ?? 0,
    candidateRecords: source.candidateRecords ?? 0,
    targetMatches: source.targetMatches ?? 0,
    cacheAgeMs: source.cacheAgeMs ?? null,
    status: snapshot?.status ?? "idle",
    lastSyncedAt: snapshot?.lastSyncedAt ?? null,
    totalAccounts: snapshot?.accounts.length ?? 0,
    lastError: source.lastError ?? cache.lastError ?? null,
  };
}

function logSafeSyncDiagnostics(snapshot: DashboardSnapshot | null, source: { accountMatches?: number; candidateRecords?: number; targetMatches?: number; cacheAgeMs?: number | null; lastError?: string | null } = {}) {
  const info = getSafeSyncDiagnostics(snapshot, source);
  console.info(
    `[Questathon] status=${info.status} lastSyncedAt=${info.lastSyncedAt ?? "none"} accountMatches=${info.accountMatches} targetMatches=${info.targetMatches} candidateRecords=${info.candidateRecords} totalAccounts=${info.totalAccounts} cacheAgeMs=${info.cacheAgeMs ?? "n/a"} lastError=${info.lastError ? "present" : "none"}`,
  );
}

function getRateLimitWindowEnd(): string | null {
  if (!cache.lastRequestAt) return null;
  return new Date(cache.lastRequestAt + 60000).toISOString();
}

async function withRefreshLock<T>(action: () => Promise<T>): Promise<T> {
  const lockKey = "questathon-dashboard-refresh-in-flight";
  const current = await loadPersistenceState<boolean>(lockKey, false);
  if (current) {
    throw new Error("Questathon dashboard refresh already in progress.");
  }

  await savePersistenceState(lockKey, true);
  try {
    return await action();
  } finally {
    await savePersistenceState(lockKey, false);
  }
}
