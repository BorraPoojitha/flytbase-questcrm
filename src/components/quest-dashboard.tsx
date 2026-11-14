"use client";

import { useEffect, useMemo, useState } from "react";

import type { AccountCard, DashboardSnapshot } from "@/lib/questathon";

type BadgeTone = "neutral" | "verified" | "told" | "claim";

const fallbackAccounts = [
  "Eastern Counties Police Alliance",
  "Aldermoor Industrial Group",
];

function badgeTone(status: string): BadgeTone {
  if (status === "verified") return "verified";
  if (status === "told") return "told";
  if (status === "claim") return "claim";
  return "neutral";
}

function ValueBadge({ status }: { status: string }) {
  const tone = badgeTone(status);
  const classes = {
    neutral: "bg-slate-100 text-slate-700",
    verified: "bg-emerald-100 text-emerald-800",
    told: "bg-amber-100 text-amber-800",
    claim: "bg-rose-100 text-rose-800",
  }[tone];

  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${classes}`}>{status}</span>;
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-base font-semibold text-slate-900">{title}</h3>
      {children}
    </section>
  );
}

export function QuestDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [noteState, setNoteState] = useState({
    account: "Eastern Counties Police Alliance",
    kind: "internal",
    title: "",
    text: "",
  });
  const [noteFeedback, setNoteFeedback] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const response = await fetch("/api/questathon/dashboard", { cache: "no-store" });
        const payload = (await response.json()) as DashboardSnapshot;
        setSnapshot(payload);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load the dashboard.");
      }
    }

    load();
    const timer = window.setInterval(load, 30000);
    return () => window.clearInterval(timer);
  }, []);

  async function submitNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNoteFeedback(null);

    try {
      const response = await fetch("/api/admin/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify(noteState),
      });
      const payload = (await response.json()) as { success?: boolean; message?: string; error?: string };

      if (!response.ok) {
        throw new Error(payload.error || payload.message || "Note submission failed.");
      }

      setNoteFeedback(payload.message || "Note submitted to the upstream queue.");
      setNoteState((current) => ({ ...current, title: "", text: "" }));
    } catch (submitError) {
      setNoteFeedback(submitError instanceof Error ? submitError.message : "Note submission failed.");
    }
  }

  const accounts = useMemo(() => {
    if (!snapshot || snapshot.accounts.length === 0) {
      return fallbackAccounts.map((name) => ({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name,
        status: "idle" as const,
        bookValue: [],
        powerMap: [],
        nextMoves: [],
        risks: [],
        knowledgeGaps: [],
      }));
    }

    return snapshot.accounts;
  }, [snapshot]);

  const syncLabel = snapshot?.lastSyncedAt ? new Date(snapshot.lastSyncedAt).toLocaleString() : "No successful sync yet";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-700">FlytBase</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950">Questathon CRM</h1>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
            <div>Last successful sync: {syncLabel}</div>
            <div className="mt-1 text-xs text-slate-500">
              Status: {snapshot?.status ?? "idle"} {snapshot?.message ? `• ${snapshot.message}` : ""}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Admin notes</h2>
          <form onSubmit={submitNote} className="grid gap-3 md:grid-cols-2">
            <input
              value={adminKey}
              onChange={(event) => setAdminKey(event.target.value)}
              type="password"
              placeholder="Admin secret"
              className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none ring-0 focus:border-cyan-500"
            />
            <select
              value={noteState.account}
              onChange={(event) => setNoteState((current) => ({ ...current, account: event.target.value }))
              }
              className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-cyan-500"
            >
              {fallbackAccounts.map((accountName) => (
                <option key={accountName} value={accountName}>{accountName}</option>
              ))}
            </select>
            <input
              value={noteState.kind}
              onChange={(event) => setNoteState((current) => ({ ...current, kind: event.target.value }))
              }
              placeholder="Kind"
              className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-cyan-500"
            />
            <input
              value={noteState.title}
              onChange={(event) => setNoteState((current) => ({ ...current, title: event.target.value }))
              }
              placeholder="Title"
              className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-cyan-500"
            />
            <textarea
              value={noteState.text}
              onChange={(event) => setNoteState((current) => ({ ...current, text: event.target.value }))
              }
              placeholder="Note text"
              rows={4}
              className="md:col-span-2 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-cyan-500"
            />
            <button
              type="submit"
              className="md:col-span-2 rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800"
            >
              Save note
            </button>
          </form>
          {noteFeedback ? <p className="mt-3 text-sm text-slate-700">{noteFeedback}</p> : null}
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          {accounts.map((account: AccountCard) => (
            <div key={account.id} className="space-y-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Account</p>
                  <h2 className="text-2xl font-bold text-slate-900">{account.name}</h2>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
                  {account.status}
                </span>
              </div>

              <SectionCard title="Book value">
                <div className="space-y-2">
                  {(account.bookValue.length ? account.bookValue : [
                    { label: "Deals", value: "Unknown", status: "unknown" },
                    { label: "Original currencies", value: "Unknown", status: "unknown" },
                    { label: "Supported amount", value: "Unknown", status: "unknown" },
                    { label: "Verification status", value: "Unknown", status: "unknown" },
                    { label: "Source IDs", value: "Unknown", status: "unknown" },
                    { label: "Evidence", value: "Unknown", status: "unknown" },
                  ]).map((field) => (
                    <div key={field.label} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
                      <div className="font-medium text-slate-700">{field.label}</div>
                      <div className="flex items-center gap-2 text-sm text-slate-900">
                        <span className="break-all">{field.value || "Unknown"}</span>
                        <ValueBadge status={field.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Power map">
                <div className="space-y-2">
                  {(account.powerMap.length ? account.powerMap : [
                    { label: "Decision-makers", value: "Unknown", status: "unknown" },
                    { label: "Payers", value: "Unknown", status: "unknown" },
                    { label: "Users", value: "Unknown", status: "unknown" },
                    { label: "Blockers", value: "Unknown", status: "unknown" },
                    { label: "Relationship status", value: "Unknown", status: "unknown" },
                  ]).map((field) => (
                    <div key={field.label} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
                      <div className="font-medium text-slate-700">{field.label}</div>
                      <div className="flex items-center gap-2 text-sm text-slate-900">
                        <span className="break-all">{field.value || "Unknown"}</span>
                        <ValueBadge status={field.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Top three next moves">
                <div className="space-y-2">
                  {(account.nextMoves.length ? account.nextMoves : [
                    { label: "Priority", value: "Unknown", status: "unknown" },
                    { label: "Task", value: "Unknown", status: "unknown" },
                    { label: "Owner", value: "Unknown", status: "unknown" },
                    { label: "Due date", value: "Unknown", status: "unknown" },
                    { label: "Related deal", value: "Unknown", status: "unknown" },
                    { label: "Source", value: "Unknown", status: "unknown" },
                  ]).map((field) => (
                    <div key={field.label} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
                      <div className="font-medium text-slate-700">{field.label}</div>
                      <div className="flex items-center gap-2 text-sm text-slate-900">
                        <span className="break-all">{field.value || "Unknown"}</span>
                        <ValueBadge status={field.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Risks">
                <div className="space-y-2">
                  {(account.risks.length ? account.risks : [
                    { label: "Deadlines", value: "Unknown", status: "unknown" },
                    { label: "Stalled deals", value: "Unknown", status: "unknown" },
                    { label: "Cold stakeholders", value: "Unknown", status: "unknown" },
                    { label: "Blockers", value: "Unknown", status: "unknown" },
                  ]).map((field) => (
                    <div key={field.label} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:flex-row md:items-center md:justify-between">
                      <div className="font-medium text-slate-700">{field.label}</div>
                      <div className="flex items-center gap-2 text-sm text-slate-900">
                        <span className="break-all">{field.value || "Unknown"}</span>
                        <ValueBadge status={field.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Knowledge gaps">
                <div className="space-y-2">
                  {(account.knowledgeGaps.length ? account.knowledgeGaps : [
                    { label: "Missing fact", value: "Unknown", status: "unknown" },
                    { label: "Why it matters", value: "Unknown", status: "unknown" },
                    { label: "Who can answer", value: "Unknown", status: "unknown" },
                  ]).map((field) => (
                    <div key={field.label} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 md:flex-row md:items-start md:justify-between">
                      <div className="font-medium text-slate-700">{field.label}</div>
                      <div className="flex items-center gap-2 text-sm text-slate-900">
                        <span className="break-all">{field.value || "Unknown"}</span>
                        <ValueBadge status={field.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
