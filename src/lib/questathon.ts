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
  return (
    safeText(record.account ?? record.company ?? record.entity ?? record.name ?? record.account_name ?? record.customer) ||
    "Unknown account"
  );
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
    const candidateNames = [
      findAccountName(record),
      coerceAccountName(record.account),
      coerceAccountName(record.company),
      coerceAccountName(record.entity),
      coerceAccountName(record.name),
      coerceAccountName(record.account_name),
      coerceAccountName(record.customer),
    ].filter((value): value is string => !!value);

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
  const targetRecords = candidateRecords.filter((record) => recordMatchesTargetAccount(record));
  const normalized = buildAccountSet(targetRecords.length > 0 ? targetRecords : candidateRecords);

  return normalized.length > 0 ? normalized : ACCOUNT_NAMES.map((name) => buildEmptyAccount(name));
}

async function requestQuestathon<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const token = process.env.AQ_TOKEN;
  if (!token) {
    return null;
  }

  const now = Date.now();
  const gap = cache.lastRequestAt ? now - cache.lastRequestAt : Number.POSITIVE_INFINITY;

  if (gap < 60000) {
    const waitTime = 60000 - gap;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  cache.lastRequestAt = Date.now();
  cache.nextRequestAt = cache.lastRequestAt + 60000;

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
  const exportPayload = await requestQuestathon<Record<string, unknown> | Record<string, unknown>[] | unknown[]>("/api/public/v1/export");
  if (!exportPayload) return ACCOUNT_NAMES.map((name) => buildEmptyAccount(name));

  const items = Array.isArray(exportPayload)
    ? exportPayload
    : Array.isArray((exportPayload as Record<string, unknown>).data)
      ? ((exportPayload as Record<string, unknown>).data as Record<string, unknown>[])
      : toRecordList((exportPayload as Record<string, unknown>).records ?? (exportPayload as Record<string, unknown>).items ?? (exportPayload as Record<string, unknown>).results);

  const normalized = buildAccountSet(items.map((item) => item as Record<string, unknown>));
  return normalized.length > 0 ? normalized : ACCOUNT_NAMES.map((name) => buildEmptyAccount(name));
}

async function maybeLoadAdditionalSignals(): Promise<void> {
  if (!process.env.AQ_TOKEN) return;
  try {
    await requestQuestathon("/api/public/v1/signals");
    await requestQuestathon("/api/public/v1/schema");
    await requestQuestathon("/api/public/v1/pack/A/all");
    await requestQuestathon("/api/public/v1/pack/B/all");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown downstream sync error";
    cache.lastError = message;
  }
}

export async function processQueuedRequests(): Promise<boolean> {
  if (!process.env.AQ_TOKEN) return false;

  const item = await lockNextQueuedRequest();
  if (!item) return false;

  const baseUrl = process.env.QUESTATHON_BASE_URL || "https://questathon.aihackerscollective.com";

  try {
    const response = await fetch(`${baseUrl}${item.endpoint}`, {
      method: item.method,
      headers: {
        Authorization: `Bearer ${process.env.AQ_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: item.payload ? JSON.stringify(item.payload) : undefined,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    await finishQueuedRequest(item.id, true);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown request queue failure";
    await finishQueuedRequest(item.id, false, message);
    return false;
  }
}

export async function syncQuestathonData(): Promise<DashboardSnapshot> {
  await ensureDatabaseReady();

  if (!process.env.AQ_TOKEN || !process.env.QUESTATHON_BASE_URL) {
    const fallback = await loadPersistenceState<DashboardSnapshot>("questathon-dashboard", {
      accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
      lastSyncedAt: null,
      status: "idle",
      message: "No AQ_TOKEN configured. Server-side sync is disabled until a valid token is supplied.",
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

  const cached = await loadCacheEntry<DashboardSnapshot>("questathon-dashboard");
  if (cached && cached.lastSyncedAt) {
    cache.data = cached;
    cache.lastUpdated = Date.now();
    return cached;
  }

  if (cache.pendingPromise) {
    return (await cache.pendingPromise) ?? {
      accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
      lastSyncedAt: null,
      status: "idle",
      message: "Server-side sync is queued.",
      rateLimit: {
        perMinute: 1,
        nextAvailableAt: cache.nextRequestAt ? new Date(cache.nextRequestAt).toISOString() : null,
        lastRequestAt: cache.lastRequestAt ? new Date(cache.lastRequestAt).toISOString() : null,
      },
    };
  }

  cache.pendingPromise = (async () => {
    try {
      const accounts = await fetchAndNormalizeExport();
      await maybeLoadAdditionalSignals();

      const snapshot: DashboardSnapshot = {
        accounts,
        lastSyncedAt: new Date().toISOString(),
        status: "ready",
        message: "Questathon sync completed. Values are limited to data returned by the upstream API.",
        rateLimit: {
          perMinute: 1,
          nextAvailableAt: cache.nextRequestAt ? new Date(cache.nextRequestAt).toISOString() : null,
          lastRequestAt: cache.lastRequestAt ? new Date(cache.lastRequestAt).toISOString() : null,
        },
      };

      await saveCacheEntry("questathon-dashboard", snapshot, 300000);
      await savePersistenceState("questathon-dashboard", snapshot);
      cache.data = snapshot;
      cache.lastUpdated = Date.now();
      cache.lastError = null;
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sync failure";
      const snapshot: DashboardSnapshot = {
        accounts: ACCOUNT_NAMES.map((name) => buildEmptyAccount(name)),
        lastSyncedAt: cache.data?.lastSyncedAt ?? null,
        status: "error",
        message,
        rateLimit: {
          perMinute: 1,
          nextAvailableAt: cache.nextRequestAt ? new Date(cache.nextRequestAt).toISOString() : null,
          lastRequestAt: cache.lastRequestAt ? new Date(cache.lastRequestAt).toISOString() : null,
        },
      };
      await savePersistenceState("questathon-dashboard", snapshot);
      cache.data = snapshot;
      cache.lastError = message;
      return snapshot;
    } finally {
      cache.pendingPromise = null;
    }
  })();

  return await cache.pendingPromise;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  await ensureDatabaseReady();

  if (cache.data && cache.lastUpdated && Date.now() - cache.lastUpdated < 30000) {
    return cache.data;
  }

  const databaseCached = await loadCacheEntry<DashboardSnapshot>("questathon-dashboard");
  if (databaseCached && databaseCached.lastSyncedAt) {
    cache.data = databaseCached;
    cache.lastUpdated = Date.now();
    return databaseCached;
  }

  const snapshot = await syncQuestathonData();
  return snapshot;
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
