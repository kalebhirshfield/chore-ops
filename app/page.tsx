"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

type ChoreId = "bathroom" | "kitchen" | "bins";
type Chore = {
  id: ChoreId;
  name: string;
  detail: string;
  cadence: string;
  day: string;
};
type Team = { id: string; name: string };
type Assignment = {
  chore_id: ChoreId;
  team_id: string;
  completed_at: string | null;
  bin_type: "general_waste" | "recycling" | null;
};

const chores: Chore[] = [
  { id: "bathroom", name: "Cleaning bathrooms", detail: "Give both bathrooms a proper reset", cadence: "Every week", day: "Any day" },
  { id: "kitchen", name: "Cleaning kitchen + conservatory", detail: "Wipe down surfaces and sweep the floors", cadence: "Every week", day: "Any day" },
  { id: "bins", name: "Take out the bins", detail: "General waste and recycling rotate weekly", cadence: "One bin each week", day: "Monday / Tuesday" },
];

function getMonday(date = new Date()) {
  const monday = new Date(date);
  const day = monday.getDay();
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
  return monday.toISOString().slice(0, 10);
}

function displayDate(date: string) {
  const parsedDate = date.includes("T") ? new Date(date) : new Date(`${date}T12:00:00`);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(parsedDate);
}

function addDays(date: string, days: number) {
  return new Date(new Date(`${date}T12:00:00`).getTime() + days * 86400000).toISOString();
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [today, setToday] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const weekStart = today ? getMonday(new Date(today)) : "";

  useEffect(() => {
    queueMicrotask(() => setToday(new Date().toISOString()));
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setAuthError(sessionError.message);
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session || !weekStart) return;
    let cancelled = false;

    async function loadWeek() {
      setLoading(true);
      setError("");
      const [teamsResult, assignmentsResult] = await Promise.all([
        supabase.from("teams").select("id, name").order("created_at"),
        supabase.from("weekly_assignments").select("chore_id, team_id, completed_at, bin_type").eq("week_start", weekStart),
      ]);
      if (cancelled) return;
      if (teamsResult.error || assignmentsResult.error) {
        setError(teamsResult.error?.message || assignmentsResult.error?.message || "Unable to load this week's chores.");
      } else {
        setTeams(teamsResult.data as Team[]);
        setAssignments(assignmentsResult.data as Assignment[]);
      }
      setLoading(false);
    }

    loadWeek();
    const channel = supabase
      .channel(`weekly-assignments-${weekStart}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "weekly_assignments", filter: `week_start=eq.${weekStart}` }, loadWeek)
      .subscribe();
    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [session, weekStart]);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");
    const result = authMode === "sign-in"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (result.error) setAuthError(result.error.message);
    else if (authMode === "sign-up" && !result.data.session) {
      setAuthNotice("Account created. Check your inbox and spam folder for the confirmation email.");
    }
  }

  async function resendConfirmation() {
    setAuthError("");
    setAuthNotice("");
    const { error: resendError } = await supabase.auth.resend({ type: "signup", email });
    if (resendError) setAuthError(resendError.message);
    else setAuthNotice("Confirmation email sent again. Check your inbox and spam folder.");
  }

  async function toggleCompleted(assignment: Assignment) {
    const completed = Boolean(assignment.completed_at);
    const nextCompletedAt = completed ? null : new Date().toISOString();
    const previousAssignments = assignments;
    setAssignments((current) =>
      current.map((item) =>
        item.chore_id === assignment.chore_id
          ? { ...item, completed_at: nextCompletedAt }
          : item,
      ),
    );
    const { error: updateError } = await supabase
      .from("weekly_assignments")
      .update({ completed_at: nextCompletedAt, completed_by: completed ? null : session?.user.id })
      .eq("week_start", weekStart)
      .eq("chore_id", assignment.chore_id);
    if (updateError) {
      setAssignments(previousAssignments);
      setError(updateError.message);
    }
  }

  async function assignChore(choreId: ChoreId, teamId: string) {
    const { error: updateError } = await supabase.from("weekly_assignments").update({ team_id: teamId }).eq("week_start", weekStart).eq("chore_id", choreId);
    if (updateError) setError(updateError.message);
  }

  if (authLoading || !today) return <div className="auth-page"><div className="auth-card"><p>Getting things ready...</p></div></div>;
  if (!session) return <AuthScreen email={email} password={password} mode={authMode} error={authError} notice={authNotice} setEmail={setEmail} setPassword={setPassword} setMode={setAuthMode} onSubmit={authenticate} onResend={resendConfirmation} />;

  const assignmentFor = (id: ChoreId) => assignments.find((assignment) => assignment.chore_id === id);
  const completedCount = assignments.filter((assignment) => assignment.completed_at).length;
  const progress = Math.round((completedCount / chores.length) * 100);
  const bins = assignmentFor("bins");
  const binName = bins?.bin_type === "general_waste" ? "General waste" : bins?.bin_type === "recycling" ? "Recycling" : "Bin";
  const binDay = bins?.bin_type === "general_waste" ? "Monday" : "Tuesday";
  const binDate = bins ? addDays(weekStart, bins.bin_type === "general_waste" ? 0 : 1) : "";
  const userName = session.user.email?.split("@")[0] || "there";

  return (
    <main className="app-shell">
      <section className="content" id="dashboard">
        <div className="page-wrap">
          <div className="intro"><div><h1>Alright, {userName}</h1><p className="subheading">Here&apos;s what needs doing this week.</p></div><button className="logout-button" onClick={() => supabase.auth.signOut()} aria-label="Sign out" title="Sign out">Sign out</button></div>
          {error && <p className="data-error" role="alert">{error}</p>}
          <div className="stats-grid"><article className="stat-card progress-card"><div className="stat-copy"><span>This week</span><strong>{progress}% <em>complete</em></strong></div><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><b>{completedCount}<small>/{chores.length}</small></b></div></article><article className="stat-card bin-summary"><div className="stat-copy"><span>Put out this week</span><strong>{binName}</strong><small>{bins ? `${binDay} · ${displayDate(binDate)}` : "Awaiting schedule"}</small></div></article></div>
          <div className="section-heading"><div><p className="eyebrow">The jobs</p><h2>This week</h2></div><span className="week-pill">{displayDate(weekStart)} — {displayDate(new Date(new Date(`${weekStart}T12:00:00`).getTime() + 6 * 86400000).toISOString())}</span></div>
          {loading ? <div className="loading-card">Loading this week&apos;s chores...</div> : <div className="chore-list">{chores.map((chore) => {
            const assignment = assignmentFor(chore.id);
            const isDone = Boolean(assignment?.completed_at);
            return <article className={`chore-row ${isDone ? "is-done" : ""}`} key={chore.id}><button className={`check-box ${isDone ? "checked" : ""}`} disabled={!assignment} onClick={() => assignment && toggleCompleted(assignment)} aria-label={`${isDone ? "Mark" : "Complete"} ${chore.name}`}>{isDone ? "✓" : ""}</button><div className="chore-info"><h3>{chore.name}</h3><p>{chore.id === "bins" && bins ? `Put out ${binName.toLowerCase()} on ${binDay} ${displayDate(binDate)}` : chore.detail}</p></div><div className="cadence"><span>{chore.id === "bins" && bins ? `${binDay} · ${displayDate(binDate)}` : chore.day}</span><small>{chore.cadence}</small></div><div className="assignee"><label><span>Assigned to</span><span className="select-wrap"><select value={assignment ? teams.find((team) => team.id === assignment.team_id)?.name || "" : ""} disabled={!assignment} onChange={(event) => { const team = teams.find((item) => item.name === event.target.value); if (team) void assignChore(chore.id, team.id); }} aria-label={`Assign ${chore.name}`}>{teams.map((team) => <option key={team.id}>{team.name}</option>)}</select><span className="select-arrow" aria-hidden="true">⌄</span></span></label></div><span className={`status ${isDone ? "done" : "open"}`}>{isDone ? "Done" : "To do"}</span></article>;
          })}</div>}
        </div>
      </section>
    </main>
  );
}

function AuthScreen({ email, password, mode, error, notice, setEmail, setPassword, setMode, onSubmit, onResend }: { email: string; password: string; mode: "sign-in" | "sign-up"; error: string; notice: string; setEmail: (value: string) => void; setPassword: (value: string) => void; setMode: (value: "sign-in" | "sign-up") => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onResend: () => void }) {
  return <main className="auth-page"><div className="auth-card"><h1>{mode === "sign-in" ? "Alright, you lot" : "Join the house"}</h1><p className="auth-copy">{mode === "sign-in" ? "Sign in to see what needs doing this week." : "Make an account and jump into the chore rota."}</p><form onSubmit={onSubmit} className="auth-form"><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="auth-notice" role="status">{notice}</p>}<button className="primary-button" type="submit">{mode === "sign-in" ? "Let me in" : "Create account"}</button></form>{notice && mode === "sign-up" && <button className="auth-resend" onClick={onResend}>Resend confirmation email</button>}<button className="auth-toggle" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>{mode === "sign-in" ? "New here? Create an account" : "Already signed up? Sign in"}</button></div></main>;
}
