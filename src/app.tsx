/* Lovetta chores — one-file React/TypeScript app.
 *
 * The app is static (GitHub Pages). All shared state lives as JSON files in a
 * private data repo and is read/written with the GitHub contents API using
 * each person's own fine-grained token. See README.md / CLAUDE.md.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import seedHouse from "../seed/house.json";
import seedSettings from "../seed/settings.json";
import seedLog from "../seed/log.json";
import seedProjects from "../seed/projects.json";
import seedLists from "../seed/lists.json";

/* ================================================================== types */

type Person = "grant" | "cass";
type Owner = Person | "both";
type Freq = "weekly" | "monthly" | "seasonal";
type Zone = "A" | "B" | "shared";

interface Room {
  id: string;
  name: string;
  area: string;
  zone: Zone;
  fixedOwner: Owner;
  pinned?: boolean;
}
interface Chore {
  id: string;
  title: string;
  room: string;
  freq: Freq;
  prn?: boolean;
  months?: number[];
  owner?: Owner;
  note?: string;
}
interface House { version: number; rooms: Room[]; chores: Chore[] }
interface Settings {
  version: number;
  mode: "rotate" | "fixed";
  rotation: { anchorWeek: string; anchorMonth: string; zoneAStarts: Person };
}
interface DoneMark { by: Person; at: string }
interface Log { version: number; done: Record<string, DoneMark> }
type Status = "todo" | "doing" | "done";
interface Project {
  id: string;
  task: string;
  category: string;
  priority: number;
  effort: number;
  lead: Owner;
  status: Status;
  start?: string;
  cost?: string;
  notes?: string;
  links?: string;
  doneAt?: string;
}
interface Projects { version: number; projects: Project[] }
interface ListItem { id: string; text: string; done: boolean; by?: Person; at?: string }
interface List { id: string; name: string; items: ListItem[] }
interface Lists { version: number; lists: List[] }

interface Data {
  house: House;
  settings: Settings;
  log: Log;
  projects: Projects;
  lists: Lists;
}
type FileName = keyof Data;
const FILES: FileName[] = ["house", "settings", "log", "projects", "lists"];
const SEED: Data = {
  house: seedHouse as House,
  settings: seedSettings as Settings,
  log: seedLog as Log,
  projects: seedProjects as Projects,
  lists: seedLists as Lists,
};

interface Config {
  me?: Person;
  mode?: "github" | "local";
  repo: string;
  branch: string;
  token: string;
}

/* ================================================================ people */

const NAME: Record<Owner, string> = { grant: "Grant", cass: "Cass", both: "Together" };
const other = (p: Person): Person => (p === "grant" ? "cass" : "grant");
const inkVar = (o: Owner) => `var(--${o})`;

/* =============================================================== storage */

const lsGet = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const lsSet = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* private mode etc. */ }
};
const lsDel = (k: string) => {
  try { localStorage.removeItem(k); } catch { /* ignore */ }
};

const CONFIG_KEY = "lc:config";
const DEFAULT_CONFIG: Config = { repo: "gphill1396/lovetta-chores-data", branch: "main", token: "" };
function loadConfig(): Config {
  try {
    const raw = lsGet(CONFIG_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
const saveConfig = (c: Config) => lsSet(CONFIG_KEY, JSON.stringify(c));

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

interface Store {
  kind: "github" | "local";
  load<K extends FileName>(name: K, fresh?: boolean): Promise<Data[K]>;
  save<K extends FileName>(name: K, mutate: (d: Data[K]) => Data[K], message: string): Promise<Data[K]>;
}

class LocalStore implements Store {
  kind = "local" as const;
  async load<K extends FileName>(name: K): Promise<Data[K]> {
    const raw = lsGet("lc:data:" + name);
    return raw ? JSON.parse(raw) : clone(SEED[name]);
  }
  async save<K extends FileName>(name: K, mutate: (d: Data[K]) => Data[K]): Promise<Data[K]> {
    const next = mutate(await this.load(name));
    lsSet("lc:data:" + name, JSON.stringify(next));
    return next;
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64decode(b: string): string {
  const bin = atob(b.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Reads/writes data/<name>.json in the data repo. Writes are optimistic-
 *  concurrency safe: on a sha conflict the latest file is re-read and the
 *  same mutation is re-applied. */
class GitHubStore implements Store {
  kind = "github" as const;
  private sha: Partial<Record<FileName, string>> = {};
  private etag: Partial<Record<FileName, string>> = {};
  private cache: Partial<Data> = {};
  constructor(private cfg: Config) {}

  private url(name: FileName) {
    const ref = this.cfg.branch ? `?ref=${encodeURIComponent(this.cfg.branch)}` : "";
    return `https://api.github.com/repos/${this.cfg.repo}/contents/data/${name}.json${ref}`;
  }
  private headers(extra: Record<string, string> = {}) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.cfg.token.trim()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  async load<K extends FileName>(name: K, fresh = false): Promise<Data[K]> {
    const h: Record<string, string> = {};
    if (!fresh && this.etag[name] && this.cache[name]) h["If-None-Match"] = this.etag[name]!;
    const res = await fetch(this.url(name), { headers: this.headers(h), cache: "no-store" });
    if (res.status === 304) return this.cache[name] as Data[K];
    if (res.status === 404) {
      // First run against an empty data repo: create the file from the seed.
      const seeded = clone(SEED[name]);
      await this.put(name, seeded, `Set up ${name}.json`);
      return seeded;
    }
    if (!res.ok) throw await httpError(res);
    const body = await res.json();
    const data = JSON.parse(b64decode(body.content)) as Data[K];
    this.sha[name] = body.sha;
    const et = res.headers.get("ETag");
    if (et) this.etag[name] = et;
    (this.cache as any)[name] = data;
    return data;
  }

  private async put<K extends FileName>(name: K, data: Data[K], message: string) {
    const body: Record<string, unknown> = {
      message,
      content: b64encode(JSON.stringify(data, null, 1) + "\n"),
    };
    if (this.sha[name]) body.sha = this.sha[name];
    if (this.cfg.branch) body.branch = this.cfg.branch;
    const res = await fetch(this.url(name).split("?")[0], {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res);
    const out = await res.json();
    this.sha[name] = out.content.sha;
    delete this.etag[name];
    (this.cache as any)[name] = data;
  }

  async save<K extends FileName>(name: K, mutate: (d: Data[K]) => Data[K], message: string): Promise<Data[K]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = attempt === 0 && this.cache[name] ? (this.cache[name] as Data[K]) : await this.load(name, true);
      const next = mutate(clone(current));
      try {
        await this.put(name, next, message);
        return next;
      } catch (e) {
        lastErr = e;
        // 409 = sha out of date, 422 = sha missing; someone else saved first.
        if (e instanceof HttpError && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
    }
    throw lastErr;
  }
}

async function httpError(res: Response): Promise<HttpError> {
  let detail = "";
  try { detail = (await res.json()).message || ""; } catch { /* ignore */ }
  const hint =
    res.status === 401 ? "GitHub didn't accept the token. Paste a new one in Settings." :
    res.status === 403 ? "The token can't write to this repo. It needs Contents: read and write." :
    res.status === 404 ? "Couldn't find the data repo. Check the repo name and that the token includes it." :
    `GitHub returned ${res.status}${detail ? `: ${detail}` : ""}.`;
  return new HttpError(res.status, hint);
}

/* ================================================================ dates */

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const weekIndex = (d: Date) => {
  const m = mondayOf(d);
  return Math.round(Date.UTC(m.getFullYear(), m.getMonth(), m.getDate()) / (7 * 864e5));
};
const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const weekKey = (d: Date) => "W" + dayKey(mondayOf(d));
const monthKey = (d: Date) => `M${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const periodKey = (freq: Freq, d: Date) => (freq === "weekly" ? weekKey(d) : monthKey(d));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const fmtShort = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const weekday = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short" });

function periodStart(key: string): Date | null {
  if (key.startsWith("W")) return parseDay(key.slice(1));
  if (key.startsWith("M")) {
    const [y, m] = key.slice(1).split("-").map(Number);
    return new Date(y, m - 1, 1);
  }
  return null;
}

/* ============================================================ ownership */

function rotationSide(settings: Settings, freq: Freq, now: Date): Person {
  const r = settings.rotation;
  const diff = freq === "weekly"
    ? weekIndex(now) - weekIndex(parseDay(r.anchorWeek))
    : monthIndex(now) - monthIndex(parseDay(r.anchorMonth + "-01"));
  return ((diff % 2) + 2) % 2 === 0 ? r.zoneAStarts : other(r.zoneAStarts);
}

function roomOwner(room: Room | undefined, settings: Settings, freq: Freq, now: Date): Owner {
  if (!room) return "both";
  if (room.pinned || settings.mode === "fixed") return room.fixedOwner;
  if (room.zone === "shared") return "both";
  const a = rotationSide(settings, freq, now);
  return room.zone === "A" ? a : other(a);
}

function choreOwner(c: Chore, rooms: Map<string, Room>, settings: Settings, now: Date): Owner {
  return c.owner ?? roomOwner(rooms.get(c.room), settings, c.freq, now);
}

const isFor = (owner: Owner, p: Person) => owner === p || owner === "both";

/* ================================================================ hooks */

type SyncState = "idle" | "saving" | "error" | "offline";

function useData(store: Store | null) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>("idle");
  const pending = useRef(0);

  const reload = useCallback(async () => {
    if (!store) return;
    try {
      const parts = await Promise.all(FILES.map((f) => store.load(f)));
      if (pending.current > 0) return; // don't clobber optimistic edits mid-save
      setData(Object.fromEntries(FILES.map((f, i) => [f, parts[i]])) as unknown as Data);
      setError(null);
      setSync((s) => (s === "offline" ? "idle" : s));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(e instanceof TypeError ? "Can't reach GitHub. Check your connection." : msg);
      setSync("offline");
    }
  }, [store]);

  useEffect(() => {
    setData(null);
    reload();
    if (!store || store.kind !== "github") return;
    const tick = () => { if (document.visibilityState === "visible") reload(); };
    const id = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [store, reload]);

  const mutate = useCallback(
    async <K extends FileName>(name: K, fn: (d: Data[K]) => Data[K], message: string) => {
      if (!store) return;
      setData((d) => (d ? { ...d, [name]: fn(clone(d[name])) } : d));
      pending.current++;
      setSync("saving");
      try {
        const saved = await store.save(name, fn, message);
        setData((d) => (d ? { ...d, [name]: saved } : d));
        pending.current--;
        if (pending.current === 0) setSync("idle");
      } catch (e) {
        pending.current--;
        setSync("error");
        setError(e instanceof Error ? e.message : String(e));
        try {
          const fresh = await store.load(name, true);
          setData((d) => (d ? { ...d, [name]: fresh } : d));
        } catch { /* keep error */ }
      }
    },
    [store],
  );

  return { data, error, sync, reload, mutate, clearError: () => setError(null) };
}

const uid = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/* ============================================================ components */

function Check({ on, ink }: { on: boolean; ink: string }) {
  return (
    <svg className="check" viewBox="0 0 28 28" aria-hidden="true">
      <rect className="check-box" x="3" y="3" width="22" height="22" rx="4" />
      {on && (
        <path
          className="check-mark"
          style={{ stroke: ink }}
          d="M6.5 14.6c2 1.3 3.7 3.4 5.3 5.9 2.9-5.6 7.1-10.7 12.6-14.3"
        />
      )}
    </svg>
  );
}

function OwnerMark({ owner, size = "md" }: { owner: Owner; size?: "sm" | "md" }) {
  const label = owner === "both" ? "G+C" : NAME[owner][0];
  return (
    <span className={`owner owner-${size}`} style={{ color: inkVar(owner) }} title={NAME[owner]}>
      {label}
    </span>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value}
          className={value === o.value ? "seg-on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn-quiet" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Progress({ people, done, total }: { people: Person[]; done: Record<Person, number>; total: Record<Person, number> }) {
  return (
    <div className="progress">
      {people.map((p) => (
        <div key={p} className="progress-row">
          <span className="progress-name">{NAME[p]}</span>
          <span className="progress-track">
            <span className="progress-fill" style={{
              width: total[p] ? `${(done[p] / total[p]) * 100}%` : "0%",
              background: inkVar(p),
            }} />
          </span>
          <span className="progress-num">{done[p]} of {total[p]}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------- chore checklist */

interface ChoreCtx {
  data: Data;
  me: Person;
  now: Date;
  rooms: Map<string, Room>;
  toggle: (c: Chore, period: string, on: boolean) => void;
}

function ChoreRow({ c, period, ctx, showRoom, trailing }: {
  c: Chore; period: string; ctx: ChoreCtx; showRoom?: boolean; trailing?: React.ReactNode;
}) {
  const mark = ctx.data.log.done[`${period}|${c.id}`];
  const on = !!mark;
  return (
    <li className={trailing ? "row-owner" : undefined}>
      <button type="button" className={`task${c.prn ? " task-prn" : ""}${on ? " task-done" : ""}`}
        aria-pressed={on} onClick={() => ctx.toggle(c, period, !on)}>
        <Check on={on} ink={mark ? inkVar(mark.by) : "currentColor"} />
        <span className="task-text">
          <span className="task-title">{c.title}</span>
          <span className="task-meta">
            {showRoom && <span>{ctx.rooms.get(c.room)?.name}</span>}
            {c.prn && <span>as needed</span>}
            {c.owner && <span>{NAME[c.owner]}</span>}
            {mark && <span className="task-by" style={{ color: inkVar(mark.by) }}>{NAME[mark.by]}, {weekday(mark.at)}</span>}
            {c.note && <span>{c.note}</span>}
          </span>
        </span>
      </button>
      {trailing}
    </li>
  );
}

type Filter = "me" | "them" | "all";

function ChoreBoard({ freq, ctx }: { freq: "weekly" | "monthly"; ctx: ChoreCtx }) {
  const { data, me, now, rooms } = ctx;
  const [filter, setFilter] = useState<Filter>(() => (lsGet("lc:filter") as Filter) || "me");
  useEffect(() => lsSet("lc:filter", filter), [filter]);
  const period = periodKey(freq, now);
  const chores = data.house.chores.filter((c) => c.freq === freq);

  const stats = useMemo(() => {
    const done = { grant: 0, cass: 0 }, total = { grant: 0, cass: 0 };
    for (const c of chores) {
      if (c.prn) continue;
      const o = choreOwner(c, rooms, data.settings, now);
      const isDone = !!data.log.done[`${period}|${c.id}`];
      for (const p of ["grant", "cass"] as Person[]) {
        if (isFor(o, p)) { total[p]++; if (isDone) done[p]++; }
      }
    }
    return { done, total };
  }, [chores, rooms, data, now, period]);

  const who: Person | null = filter === "me" ? me : filter === "them" ? other(me) : null;
  const groups = data.house.rooms
    .map((r) => ({
      room: r,
      owner: roomOwner(r, data.settings, freq, now),
      items: chores.filter((c) => c.room === r.id && (!who || isFor(choreOwner(c, rooms, data.settings, now), who))),
    }))
    .filter((g) => g.items.length);

  const heading = freq === "weekly" ? `Week of ${fmtShort(mondayOf(now))}` : MONTHS_LONG[now.getMonth()];
  const sub = data.settings.mode === "rotate"
    ? freq === "weekly" ? "Rooms trade sides every Monday." : "Rooms trade sides on the 1st."
    : "Everyone keeps their rooms.";

  return (
    <section>
      <header className="board-head">
        <h1 className="marker">{heading}</h1>
        <p className="soft">{sub}</p>
        <Progress people={[me, other(me)]} done={stats.done} total={stats.total} />
        <Segmented label="Show chores for" value={filter} onChange={setFilter} options={[
          { value: "me", label: "Mine" },
          { value: "them", label: NAME[other(me)] },
          { value: "all", label: "Everyone" },
        ]} />
      </header>
      {groups.length === 0 && <p className="empty">Nothing on this list right now. Add chores in Settings.</p>}
      {groups.map((g) => (
        <div key={g.room.id} className="room">
          <div className="room-head">
            <h3>{g.room.name}</h3>
            <OwnerMark owner={g.owner} />
          </div>
          <ul className="tasks">
            {g.items.map((c) => <ChoreRow key={c.id} c={c} period={period} ctx={ctx} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

function SeasonalBoard({ ctx }: { ctx: ChoreCtx }) {
  const { data, me, now, rooms } = ctx;
  const month = now.getMonth() + 1;
  const period = monthKey(now);
  const seasonal = data.house.chores.filter((c) => c.freq === "seasonal");
  const due = seasonal.filter((c) => c.months?.includes(month));
  const upcoming = [1, 2, 3].map((k) => {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    // Chores already on this month's list (e.g. mowing, Apr–Oct) aren't repeated.
    return { d, items: seasonal.filter((c) => c.months?.includes(d.getMonth() + 1) && !due.includes(c)) };
  });
  const mine = due.filter((c) => !c.prn && isFor(choreOwner(c, rooms, data.settings, now), me));
  const mineDone = mine.filter((c) => data.log.done[`${period}|${c.id}`]).length;

  return (
    <section>
      <header className="board-head">
        <h1 className="marker">{MONTHS_LONG[now.getMonth()]} around the house</h1>
        <p className="soft">Seasonal upkeep. You've done {mineDone} of {mine.length} of yours.</p>
      </header>
      <div className="room">
        <div className="room-head"><h3>Due this month</h3></div>
        {due.length === 0 && <p className="empty">Nothing seasonal this month.</p>}
        <ul className="tasks">
          {due.map((c) => (
            <ChoreRowWithOwner key={c.id} c={c} period={period} ctx={ctx} />
          ))}
        </ul>
      </div>
      {upcoming.map(({ d, items }) => items.length > 0 && (
        <div key={d.getMonth()} className="room room-ahead">
          <div className="room-head"><h3>{MONTHS_LONG[d.getMonth()]}</h3></div>
          <ul className="ahead">
            {items.map((c) => (
              <li key={c.id}>
                <span>{c.title}</span>
                <span className="soft">{rooms.get(c.room)?.name}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function ChoreRowWithOwner({ c, period, ctx }: { c: Chore; period: string; ctx: ChoreCtx }) {
  const owner = choreOwner(c, ctx.rooms, ctx.data.settings, ctx.now);
  return <ChoreRow c={c} period={period} ctx={ctx} showRoom trailing={<OwnerMark owner={owner} size="sm" />} />;
}

/* ------------------------------------------------------------- projects */

const PRIORITY = ["", "Highest", "High", "Medium", "Low", "Lowest"];
const EFFORT = ["", "Hardest", "Hard", "Middle", "Easy", "Easiest"];
const STATUS: Record<Status, string> = { todo: "To do", doing: "In progress", done: "Done" };

function ProjectsBoard({ data, me, mutate }: {
  data: Data; me: Person;
  mutate: ReturnType<typeof useData>["mutate"];
}) {
  const [lead, setLead] = useState<"all" | Owner>("all");
  const [view, setView] = useState<"open" | "done">("open");
  const [sort, setSort] = useState<"priority" | "easy" | "category">("priority");
  const [editing, setEditing] = useState<Project | null>(null);
  const [q, setQ] = useState("");

  const list = data.projects.projects
    .filter((p) => (view === "done" ? p.status === "done" : p.status !== "done"))
    .filter((p) => lead === "all" || p.lead === lead)
    .filter((p) => !q || `${p.task} ${p.category} ${p.notes ?? ""}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      if (view === "open" && a.status !== b.status) return a.status === "doing" ? -1 : 1;
      if (sort === "easy") return b.effort - a.effort || a.priority - b.priority;
      if (sort === "category") return a.category.localeCompare(b.category) || a.priority - b.priority;
      return a.priority - b.priority || b.effort - a.effort;
    });

  const openCount = data.projects.projects.filter((p) => p.status !== "done" && isFor(p.lead, me)).length;

  const save = (p: Project) => {
    const isNew = !data.projects.projects.some((x) => x.id === p.id);
    mutate("projects", (d) => {
      const i = d.projects.findIndex((x) => x.id === p.id);
      if (i >= 0) d.projects[i] = p; else d.projects.unshift(p);
      return d;
    }, `${NAME[me]} ${isNew ? "added" : "updated"} project "${p.task}"`);
    setEditing(null);
  };
  const remove = (p: Project) => {
    mutate("projects", (d) => ({ ...d, projects: d.projects.filter((x) => x.id !== p.id) }),
      `${NAME[me]} deleted project "${p.task}"`);
    setEditing(null);
  };
  const setStatus = (p: Project, status: Status) =>
    mutate("projects", (d) => {
      const x = d.projects.find((y) => y.id === p.id);
      if (x) { x.status = status; x.doneAt = status === "done" ? new Date().toISOString() : undefined; }
      return d;
    }, `${NAME[me]} marked "${p.task}" ${STATUS[status].toLowerCase()}`);

  return (
    <section>
      <header className="board-head">
        <h1 className="marker">House projects</h1>
        <p className="soft">{openCount} open with your name on them.</p>
        <Segmented label="Lead" value={lead} onChange={setLead} options={[
          { value: "all", label: "All" },
          { value: "grant", label: "Grant" },
          { value: "cass", label: "Cass" },
          { value: "both", label: "Together" },
        ]} />
        <div className="toolbar">
          <Segmented label="Status" value={view} onChange={setView} options={[
            { value: "open", label: "Open" },
            { value: "done", label: "Done" },
          ]} />
          <label className="select">
            <span className="sr">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="priority">Priority first</option>
              <option value="easy">Easiest first</option>
              <option value="category">By room</option>
            </select>
          </label>
        </div>
        <input className="search" type="search" placeholder="Search projects" value={q}
          onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
      </header>

      <button type="button" className="btn-add" onClick={() => setEditing({
        id: uid("p"), task: "", category: "General", priority: 3, effort: 3, lead: me, status: "todo",
      })}>Add a project</button>

      {list.length === 0 && <p className="empty">{view === "done" ? "Nothing finished yet." : "No open projects match."}</p>}
      <ul className="projects">
        {list.map((p) => (
          <li key={p.id} className={`project prio-${p.priority}`}>
            <button type="button" className="project-main" onClick={() => setEditing(p)}>
              <span className="project-title">{p.task}</span>
              <span className="project-meta">
                <span>{p.category}</span>
                <span>{PRIORITY[p.priority]} priority</span>
                <span>{EFFORT[p.effort]}</span>
                {p.status === "doing" && <span className="tag-doing">In progress</span>}
              </span>
              {p.notes && <span className="project-notes">{p.notes}</span>}
            </button>
            <div className="project-side">
              <OwnerMark owner={p.lead} size="sm" />
              {p.status !== "done"
                ? <button type="button" className="btn-small" onClick={() => setStatus(p, "done")}>Done</button>
                : <button type="button" className="btn-small" onClick={() => setStatus(p, "todo")}>Reopen</button>}
            </div>
          </li>
        ))}
      </ul>
      {editing && <ProjectEditor p={editing} isNew={!data.projects.projects.some((x) => x.id === editing.id)}
        categories={[...new Set(data.projects.projects.map((p) => p.category))].sort()}
        onSave={save} onDelete={remove} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ProjectEditor({ p, isNew, categories, onSave, onDelete, onClose }: {
  p: Project; isNew: boolean; categories: string[];
  onSave: (p: Project) => void; onDelete: (p: Project) => void; onClose: () => void;
}) {
  const [f, setF] = useState<Project>(p);
  const set = <K extends keyof Project>(k: K, v: Project[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Sheet title={isNew ? "New project" : "Edit project"} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (f.task.trim()) onSave({ ...f, task: f.task.trim() }); }}>
        <label>What needs doing<input required value={f.task} onChange={(e) => set("task", e.target.value)} /></label>
        <label>Room or area
          <input list="cats" value={f.category} onChange={(e) => set("category", e.target.value)} />
          <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <div className="form-row">
          <label>Priority
            <select value={f.priority} onChange={(e) => set("priority", Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{PRIORITY[n]}</option>)}
            </select>
          </label>
          <label>Effort
            <select value={f.effort} onChange={(e) => set("effort", Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{EFFORT[n]}</option>)}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>Lead
            <select value={f.lead} onChange={(e) => set("lead", e.target.value as Owner)}>
              <option value="grant">Grant</option><option value="cass">Cass</option><option value="both">Together</option>
            </select>
          </label>
          <label>Status
            <select value={f.status} onChange={(e) => set("status", e.target.value as Status)}>
              {(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}
            </select>
          </label>
        </div>
        <label>Estimated cost<input value={f.cost ?? ""} placeholder="$40–80" onChange={(e) => set("cost", e.target.value || undefined)} /></label>
        <label>Notes<textarea rows={3} value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value || undefined)} /></label>
        <label>Links<input value={f.links ?? ""} placeholder="Product page, quote, how-to" onChange={(e) => set("links", e.target.value || undefined)} /></label>
        <div className="form-actions">
          {!isNew && <button type="button" className="btn-danger" onClick={() => { if (confirm(`Delete "${p.task}"?`)) onDelete(p); }}>Delete</button>}
          <button type="submit" className="btn-primary">{isNew ? "Add project" : "Save project"}</button>
        </div>
      </form>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- lists */

function ListsBoard({ data, me, mutate }: { data: Data; me: Person; mutate: ReturnType<typeof useData>["mutate"] }) {
  const [active, setActive] = useState(() => lsGet("lc:list") || data.lists.lists[0]?.id || "");
  const [text, setText] = useState("");
  const list = data.lists.lists.find((l) => l.id === active) ?? data.lists.lists[0];
  useEffect(() => { if (list) lsSet("lc:list", list.id); }, [list]);

  const editList = (fn: (l: List) => void, msg: string) =>
    mutate("lists", (d) => { const l = d.lists.find((x) => x.id === list!.id); if (l) fn(l); return d; }, msg);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !list) return;
    const item: ListItem = { id: uid("i"), text: t, done: false, by: me, at: new Date().toISOString() };
    editList((l) => { l.items.push(item); }, `${NAME[me]} added "${t}" to ${list.name}`);
    setText("");
  };
  const newList = () => {
    const name = prompt("Name the new list");
    if (!name?.trim()) return;
    const id = uid("l");
    mutate("lists", (d) => { d.lists.push({ id, name: name.trim(), items: [] }); return d; }, `${NAME[me]} made a list: ${name.trim()}`);
    setActive(id);
  };

  return (
    <section>
      <header className="board-head">
        <h1 className="marker">Lists</h1>
        <p className="soft">Restock, Lowe's runs, anything else you want to share.</p>
        <div className="chips">
          {data.lists.lists.map((l) => (
            <button key={l.id} type="button" aria-pressed={l.id === list?.id}
              className={l.id === list?.id ? "chip chip-on" : "chip"} onClick={() => setActive(l.id)}>
              {l.name}<span className="chip-n">{l.items.filter((i) => !i.done).length}</span>
            </button>
          ))}
          <button type="button" className="chip chip-new" onClick={newList}>New list</button>
        </div>
      </header>
      {list && (
        <>
          <form className="add-row" onSubmit={add}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add to ${list.name}`} aria-label={`Add to ${list.name}`} />
            <button type="submit" className="btn-primary">Add</button>
          </form>
          {list.items.length === 0 && <p className="empty">This list is empty. Add the first thing above.</p>}
          <ul className="tasks">
            {[...list.items].sort((a, b) => Number(a.done) - Number(b.done)).map((i) => (
              <li key={i.id}>
                <button type="button" className={`task${i.done ? " task-done" : ""}`} aria-pressed={i.done}
                  onClick={() => editList((l) => {
                    const x = l.items.find((y) => y.id === i.id);
                    if (x) { x.done = !i.done; x.by = me; x.at = new Date().toISOString(); }
                  }, `${NAME[me]} ${i.done ? "unchecked" : "checked"} "${i.text}"`)}>
                  <Check on={i.done} ink={i.done && i.by ? inkVar(i.by) : "currentColor"} />
                  <span className="task-text">
                    <span className="task-title">{i.text}</span>
                    {i.by && <span className="task-meta"><span style={{ color: inkVar(i.by) }}>{NAME[i.by]}, {weekday(i.at!)}</span></span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="list-actions">
            {list.items.some((i) => i.done) && (
              <button type="button" className="btn-quiet" onClick={() =>
                editList((l) => { l.items = l.items.filter((i) => !i.done); }, `${NAME[me]} cleared checked items from ${list.name}`)}>
                Clear checked items
              </button>
            )}
            <button type="button" className="btn-quiet" onClick={() => {
              const name = prompt("Rename list", list.name);
              if (name?.trim()) editList((l) => { l.name = name.trim(); }, `${NAME[me]} renamed ${list.name} to ${name.trim()}`);
            }}>Rename list</button>
            <button type="button" className="btn-quiet btn-quiet-danger" onClick={() => {
              if (!confirm(`Delete the ${list.name} list and everything on it?`)) return;
              mutate("lists", (d) => ({ ...d, lists: d.lists.filter((l) => l.id !== list.id) }), `${NAME[me]} deleted list ${list.name}`);
              setActive(data.lists.lists.find((l) => l.id !== list.id)?.id ?? "");
            }}>Delete list</button>
          </div>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- settings */

function SettingsSheet({ data, me, config, now, mutate, onConfig, onEdit, onClose }: {
  data: Data; me: Person; config: Config; now: Date;
  mutate: ReturnType<typeof useData>["mutate"];
  onConfig: (c: Config | null) => void; onEdit: () => void; onClose: () => void;
}) {
  const s = data.settings;
  const rotating = data.house.rooms.filter((r) => !r.pinned && r.zone !== "shared");
  const sides = (["grant", "cass"] as Person[]).map((p) => ({
    p, rooms: rotating.filter((r) => roomOwner(r, s, "weekly", now) === p).map((r) => r.name),
  }));

  const lockIn = () => {
    const owners = new Map(data.house.rooms.map((r) => [r.id, roomOwner(r, s, "weekly", now)]));
    mutate("house", (d) => {
      d.rooms.forEach((r) => { const o = owners.get(r.id); if (o) r.fixedOwner = o; });
      return d;
    }, `${NAME[me]} kept this week's room split`);
    mutate("settings", (d) => ({ ...d, mode: "fixed" }), `${NAME[me]} switched to keeping rooms`);
  };
  const setFixed = (room: Room, o: Owner) =>
    mutate("house", (d) => { const r = d.rooms.find((x) => x.id === room.id); if (r) r.fixedOwner = o; return d; },
      `${NAME[me]} gave ${room.name} to ${NAME[o]}`);

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="settings">
        <section>
          <h3>Who's using this phone</h3>
          <Segmented label="You are" value={me} onChange={(p) => onConfig({ ...config, me: p })}
            options={[{ value: "grant", label: "Grant" }, { value: "cass", label: "Cass" }]} />
        </section>

        <section>
          <h3>Who does which rooms</h3>
          <Segmented label="Room ownership" value={s.mode}
            onChange={(m) => mutate("settings", (d) => ({ ...d, mode: m }),
              `${NAME[me]} switched to ${m === "rotate" ? "taking turns" : "keeping rooms"}`)}
            options={[{ value: "rotate", label: "Take turns" }, { value: "fixed", label: "Keep rooms" }]} />
          {s.mode === "rotate" ? (
            <>
              <p className="soft">Two sides of the house swap every Monday (monthly and seasonal chores swap on the 1st). Offices stay with their owner; the bedroom is shared.</p>
              {sides.map(({ p, rooms }) => (
                <p key={p} className="side"><OwnerMark owner={p} size="sm" /> <span>This week: {rooms.join(", ") || "nothing"}</span></p>
              ))}
              <div className="form-actions">
                <button type="button" className="btn-quiet" onClick={() =>
                  mutate("settings", (d) => ({ ...d, rotation: { ...d.rotation, zoneAStarts: other(d.rotation.zoneAStarts) } }),
                    `${NAME[me]} swapped sides`)}>Swap sides</button>
                <button type="button" className="btn-primary" onClick={lockIn}>Keep this split</button>
              </div>
            </>
          ) : (
            <>
              <p className="soft">Everyone keeps the rooms below until you switch back to taking turns.</p>
              <ul className="owners">
                {data.house.rooms.map((r) => (
                  <li key={r.id}>
                    <span>{r.name}</span>
                    <select aria-label={`Owner of ${r.name}`} value={r.fixedOwner}
                      onChange={(e) => setFixed(r, e.target.value as Owner)}>
                      <option value="grant">Grant</option><option value="cass">Cass</option><option value="both">Together</option>
                    </select>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section>
          <h3>Rooms and chores</h3>
          <p className="soft">{data.house.rooms.length} rooms, {data.house.chores.length} chores.</p>
          <button type="button" className="btn-primary" onClick={onEdit}>Edit rooms and chores</button>
        </section>

        <section>
          <h3>Sync</h3>
          {config.mode === "local" ? (
            <p className="soft">Not syncing. Changes stay on this device until you connect GitHub.</p>
          ) : (
            <p className="soft">Saving to <b>{config.repo}</b>. Every check-off is a commit, so the history is there if you ever need it.</p>
          )}
          <div className="form-actions">
            <button type="button" className="btn-quiet" onClick={() => onConfig(null)}>
              {config.mode === "local" ? "Connect GitHub" : "Change token or repo"}
            </button>
          </div>
        </section>
      </div>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- editor */

function Editor({ data, me, mutate, onClose }: { data: Data; me: Person; mutate: ReturnType<typeof useData>["mutate"]; onClose: () => void }) {
  const [roomId, setRoomId] = useState(data.house.rooms[0]?.id ?? "");
  const [editing, setEditing] = useState<Chore | null>(null);
  const [roomEdit, setRoomEdit] = useState<Room | null>(null);
  const room = data.house.rooms.find((r) => r.id === roomId);
  const chores = data.house.chores.filter((c) => c.room === roomId);

  const saveChore = (c: Chore) => {
    const isNew = !data.house.chores.some((x) => x.id === c.id);
    mutate("house", (d) => {
      const i = d.chores.findIndex((x) => x.id === c.id);
      if (i >= 0) d.chores[i] = c; else d.chores.push(c);
      return d;
    }, `${NAME[me]} ${isNew ? "added" : "edited"} chore "${c.title}"`);
    setEditing(null);
  };
  const saveRoom = (r: Room) => {
    const isNew = !data.house.rooms.some((x) => x.id === r.id);
    mutate("house", (d) => {
      const i = d.rooms.findIndex((x) => x.id === r.id);
      if (i >= 0) d.rooms[i] = r; else d.rooms.push(r);
      return d;
    }, `${NAME[me]} ${isNew ? "added" : "edited"} room ${r.name}`);
    setRoomId(r.id);
    setRoomEdit(null);
  };

  if (editing) return <ChoreForm c={editing} rooms={data.house.rooms} isNew={!data.house.chores.some((x) => x.id === editing.id)}
    onSave={saveChore} onClose={() => setEditing(null)}
    onDelete={(c) => { mutate("house", (d) => ({ ...d, chores: d.chores.filter((x) => x.id !== c.id) }), `${NAME[me]} removed chore "${c.title}"`); setEditing(null); }} />;
  if (roomEdit) return <RoomForm r={roomEdit} isNew={!data.house.rooms.some((x) => x.id === roomEdit.id)}
    areas={[...new Set(data.house.rooms.map((r) => r.area))]} hasChores={data.house.chores.some((c) => c.room === roomEdit.id)}
    onSave={saveRoom} onClose={() => setRoomEdit(null)}
    onDelete={(r) => { mutate("house", (d) => ({ ...d, rooms: d.rooms.filter((x) => x.id !== r.id) }), `${NAME[me]} removed room ${r.name}`); setRoomId(data.house.rooms[0]?.id ?? ""); setRoomEdit(null); }} />;

  return (
    <Sheet title="Rooms and chores" onClose={onClose}>
      <div className="form">
        <label>Room
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {data.house.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <div className="form-actions">
          {room && <button type="button" className="btn-quiet" onClick={() => setRoomEdit(room)}>Edit this room</button>}
          <button type="button" className="btn-quiet" onClick={() => setRoomEdit({ id: uid("r"), name: "", area: "Main floor", zone: "A", fixedOwner: me })}>Add a room</button>
        </div>
        {(["weekly", "monthly", "seasonal"] as Freq[]).map((f) => {
          const items = chores.filter((c) => c.freq === f);
          return (
            <div key={f} className="edit-group">
              <h4>{f === "weekly" ? "Weekly" : f === "monthly" ? "Monthly" : "Seasonal"}</h4>
              {items.length === 0 && <p className="soft">None yet.</p>}
              <ul className="edit-list">
                {items.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setEditing(c)}>
                      <span>{c.title}</span>
                      <span className="soft">
                        {[c.prn && "as needed", c.months && c.months.map((m) => MONTHS[m - 1]).join(", "), c.owner && NAME[c.owner]].filter(Boolean).join("; ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <button type="button" className="btn-add" onClick={() => setEditing({ id: uid("c"), title: "", room: roomId, freq: "weekly" })}>
          Add a chore to {room?.name ?? "this room"}
        </button>
      </div>
    </Sheet>
  );
}

function ChoreForm({ c, rooms, isNew, onSave, onDelete, onClose }: {
  c: Chore; rooms: Room[]; isNew: boolean;
  onSave: (c: Chore) => void; onDelete: (c: Chore) => void; onClose: () => void;
}) {
  const [f, setF] = useState<Chore>(c);
  const set = <K extends keyof Chore>(k: K, v: Chore[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleMonth = (m: number) => {
    const ms = new Set(f.months ?? []);
    ms.has(m) ? ms.delete(m) : ms.add(m);
    set("months", [...ms].sort((a, b) => a - b));
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    const out: Chore = { ...f, title: f.title.trim() };
    if (out.freq !== "seasonal") delete out.months;
    else if (!out.months?.length) { alert("Pick at least one month for a seasonal chore."); return; }
    if (!out.prn) delete out.prn;
    if (!out.owner) delete out.owner;
    if (!out.note) delete out.note;
    onSave(out);
  };
  return (
    <Sheet title={isNew ? "New chore" : "Edit chore"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Chore<input required value={f.title} onChange={(e) => set("title", e.target.value)} /></label>
        <label>Room
          <select value={f.room} onChange={(e) => set("room", e.target.value)}>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label>How often
          <select value={f.freq} onChange={(e) => set("freq", e.target.value as Freq)}>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="seasonal">Certain months</option>
          </select>
        </label>
        {f.freq === "seasonal" && (
          <fieldset className="months">
            <legend>Months</legend>
            {MONTHS.map((m, i) => (
              <button key={m} type="button" aria-pressed={!!f.months?.includes(i + 1)}
                className={f.months?.includes(i + 1) ? "chip chip-on" : "chip"} onClick={() => toggleMonth(i + 1)}>{m}</button>
            ))}
          </fieldset>
        )}
        <label className="inline">
          <input type="checkbox" checked={!!f.prn} onChange={(e) => set("prn", e.target.checked)} />
          Only as needed (doesn't count toward progress)
        </label>
        <label>Who does it
          <select value={f.owner ?? ""} onChange={(e) => set("owner", (e.target.value || undefined) as Owner | undefined)}>
            <option value="">Whoever has the room</option>
            <option value="grant">Always Grant</option>
            <option value="cass">Always Cass</option>
            <option value="both">Together</option>
          </select>
        </label>
        <label>Note<input value={f.note ?? ""} placeholder="Products, tips, where the supplies are" onChange={(e) => set("note", e.target.value)} /></label>
        <div className="form-actions">
          {!isNew && <button type="button" className="btn-danger" onClick={() => { if (confirm(`Remove "${c.title}"?`)) onDelete(c); }}>Remove</button>}
          <button type="submit" className="btn-primary">{isNew ? "Add chore" : "Save chore"}</button>
        </div>
      </form>
    </Sheet>
  );
}

function RoomForm({ r, isNew, areas, hasChores, onSave, onDelete, onClose }: {
  r: Room; isNew: boolean; areas: string[]; hasChores: boolean;
  onSave: (r: Room) => void; onDelete: (r: Room) => void; onClose: () => void;
}) {
  const [f, setF] = useState<Room>(r);
  const set = <K extends keyof Room>(k: K, v: Room[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Sheet title={isNew ? "New room" : "Edit room"} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) onSave({ ...f, name: f.name.trim(), pinned: f.pinned || undefined }); }}>
        <label>Name<input required value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label>Part of the house
          <input list="areas" value={f.area} onChange={(e) => set("area", e.target.value)} />
          <datalist id="areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
        </label>
        <label>When taking turns
          <select value={f.zone} onChange={(e) => set("zone", e.target.value as Zone)}>
            <option value="A">Side A</option>
            <option value="B">Side B</option>
            <option value="shared">Shared, always both of you</option>
          </select>
        </label>
        <label>When keeping rooms, it belongs to
          <select value={f.fixedOwner} onChange={(e) => set("fixedOwner", e.target.value as Owner)}>
            <option value="grant">Grant</option><option value="cass">Cass</option><option value="both">Together</option>
          </select>
        </label>
        <label className="inline">
          <input type="checkbox" checked={!!f.pinned} onChange={(e) => set("pinned", e.target.checked)} />
          Never rotate this room (like an office)
        </label>
        <div className="form-actions">
          {!isNew && <button type="button" className="btn-danger" disabled={hasChores}
            title={hasChores ? "Move or remove its chores first" : undefined}
            onClick={() => { if (confirm(`Remove ${r.name}?`)) onDelete(r); }}>Remove room</button>}
          <button type="submit" className="btn-primary">{isNew ? "Add room" : "Save room"}</button>
        </div>
        {!isNew && hasChores && <p className="soft">To remove this room, move or remove its chores first.</p>}
      </form>
    </Sheet>
  );
}

/* ---------------------------------------------------------------- setup */

function Setup({ initial, onDone }: { initial: Config; onDone: (c: Config) => void }) {
  const [f, setF] = useState<Config>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.me) { setErr("Pick who you are first."); return; }
    setBusy(true); setErr(null);
    try {
      const cfg: Config = { ...f, mode: "github", repo: f.repo.trim(), token: f.token.trim() };
      await new GitHubStore(cfg).load("settings", true);
      onDone(cfg);
    } catch (e) {
      setErr(e instanceof TypeError ? "Can't reach GitHub. Check your connection." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="setup">
      <h1 className="marker">Lovetta chores</h1>
      <p>Chores, house projects and shared lists for Grant and Cass.</p>
      <form className="form" onSubmit={connect}>
        <fieldset className="who">
          <legend>Who are you?</legend>
          <Segmented label="You are" value={f.me ?? ("" as Person)} onChange={(p) => setF({ ...f, me: p })}
            options={[{ value: "grant", label: "Grant" }, { value: "cass", label: "Cass" }]} />
        </fieldset>
        <label>GitHub token
          <input type="password" autoComplete="off" value={f.token} placeholder="github_pat_…"
            onChange={(e) => setF({ ...f, token: e.target.value })} required />
        </label>
        <details className="help">
          <summary>How to make a token</summary>
          <p><b>Grant:</b> open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub's new token page</a>, choose only the <b>lovetta-chores-data</b> repo, and give it <b>Contents: read and write</b>.</p>
          <p><b>Cass:</b> accept the repo invite first, then make a <a href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer">classic token</a> with the <b>repo</b> box checked.</p>
          <p>Set the expiration as far out as GitHub allows.</p>
          <p>The token stays on this phone only.</p>
        </details>
        <label>Data repo<input value={f.repo} onChange={(e) => setF({ ...f, repo: e.target.value })} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
        <button type="button" className="btn-quiet" onClick={() => {
          if (!f.me) { setErr("Pick who you are first."); return; }
          onDone({ ...f, mode: "local" });
        }}>Try it without syncing</button>
      </form>
    </main>
  );
}

/* ------------------------------------------------------------------ app */

type Tab = "week" | "month" | "seasons" | "projects" | "lists";
const TABS: { id: Tab; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "seasons", label: "Seasons" },
  { id: "projects", label: "Projects" },
  { id: "lists", label: "Lists" },
];

function App() {
  const [config, setConfig] = useState<Config>(loadConfig);
  const [setup, setSetup] = useState(() => !config.me || !config.mode);
  const store = useMemo<Store | null>(() => {
    if (setup || !config.mode) return null;
    return config.mode === "local" ? new LocalStore() : new GitHubStore(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, config.mode, config.repo, config.branch, config.token]);
  const { data, error, sync, reload, mutate, clearError } = useData(store);
  const [tab, setTab] = useState<Tab>(() => (lsGet("lc:tab") as Tab) || "week");
  const [panel, setPanel] = useState<"settings" | "editor" | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => lsSet("lc:tab", tab), [tab]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const updateConfig = (c: Config | null) => {
    if (!c) { setPanel(null); setSetup(true); return; }
    saveConfig(c); setConfig(c);
  };

  const rooms = useMemo(() => new Map((data?.house.rooms ?? []).map((r) => [r.id, r])), [data?.house.rooms]);
  const me = config.me!;

  const toggle = useCallback((c: Chore, period: string, on: boolean) => {
    const key = `${period}|${c.id}`;
    const cutoff = Date.now() - 400 * 864e5;
    mutate("log", (d) => {
      if (on) d.done[key] = { by: me, at: new Date().toISOString() };
      else delete d.done[key];
      for (const k of Object.keys(d.done)) {
        const start = periodStart(k.split("|")[0]);
        if (start && start.getTime() < cutoff) delete d.done[k];
      }
      return d;
    }, `${NAME[me]} ${on ? "checked off" : "unchecked"} "${c.title}"`);
  }, [mutate, me]);

  if (setup) {
    return <Setup initial={config} onDone={(c) => { saveConfig(c); setConfig(c); setSetup(false); }} />;
  }

  const ctx: ChoreCtx | null = data ? { data, me, now, rooms, toggle } : null;

  return (
    <div className="app" style={{ ["--me" as any]: inkVar(me) }}>
      <header className="top">
        <span className="brand">Lovetta chores</span>
        <span className={`sync sync-${sync}`} role="status">
          {config.mode === "local" ? "Not syncing" : sync === "saving" ? "Saving…" : sync === "error" ? "Not saved" : sync === "offline" ? "Offline" : "Synced"}
        </span>
        <button type="button" className="btn-quiet" onClick={() => setPanel("settings")} disabled={!data}>Settings</button>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <span>
            <button type="button" className="btn-quiet" onClick={() => { clearError(); reload(); }}>Try again</button>
            <button type="button" className="btn-quiet" onClick={clearError}>Dismiss</button>
          </span>
        </div>
      )}

      <main className="main">
        {!data || !ctx ? (
          <p className="empty">{error ? "Couldn't load the chore data." : "Loading the house…"}</p>
        ) : tab === "week" ? <ChoreBoard key="w" freq="weekly" ctx={ctx} />
          : tab === "month" ? <ChoreBoard key="m" freq="monthly" ctx={ctx} />
          : tab === "seasons" ? <SeasonalBoard ctx={ctx} />
          : tab === "projects" ? <ProjectsBoard data={data} me={me} mutate={mutate} />
          : <ListsBoard data={data} me={me} mutate={mutate} />}
      </main>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined}
            className={tab === t.id ? "tab tab-on" : "tab"} onClick={() => { setTab(t.id); window.scrollTo(0, 0); }}>
            {t.label}
          </button>
        ))}
      </nav>

      {panel === "settings" && data && (
        <SettingsSheet data={data} me={me} config={config} now={now} mutate={mutate}
          onConfig={updateConfig} onEdit={() => setPanel("editor")} onClose={() => setPanel(null)} />
      )}
      {panel === "editor" && data && <Editor data={data} me={me} mutate={mutate} onClose={() => setPanel("settings")} />}
    </div>
  );
}

/* ================================================================ styles */

const CSS = `
:root {
  --board: #F3F6F5; --sheet: #FFFFFF; --ink: #1E2B30; --ink-soft: #5A6A6F; --rule: #D3DCDA;
  --grant: #2457A6; --cass: #8A2433; --both: #3F6B4F;
  --tile: #E9BFC3; --tile-soft: #F7E6E8; --danger: #A12A1C;
  --radius: 10px; --tabs-h: 64px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --board: #172125; --sheet: #1F2B30; --ink: #E3EBE9; --ink-soft: #9DADB1; --rule: #34454B;
    --grant: #8FB3EE; --cass: #E8949F; --both: #9CC6A8;
    --tile: #6C3C43; --tile-soft: #33272A; --danger: #F08A7C;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--board); color: var(--ink);
  font: 16px/1.45 "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--grant); }
:focus-visible { outline: 3px solid var(--me, var(--grant)); outline-offset: 2px; border-radius: 6px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.soft { color: var(--ink-soft); }
.marker { font-family: "Kalam", "Marker Felt", cursive; font-weight: 700; letter-spacing: -0.01em; }

.app { max-width: 680px; margin: 0 auto; min-height: 100dvh; padding-bottom: calc(var(--tabs-h) + env(safe-area-inset-bottom) + 24px); }
.top {
  position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px;
  padding: calc(10px + env(safe-area-inset-top)) 16px 10px; background: var(--board);
  border-bottom: 1px solid var(--rule);
}
.brand { font-weight: 700; flex: 1; }
.sync { font-size: 13px; color: var(--ink-soft); }
.sync-saving { color: var(--ink); }
.sync-error, .sync-offline { color: var(--danger); }
.main { padding: 0 16px; }

.banner {
  margin: 12px 16px 0; padding: 10px 12px; border-radius: var(--radius);
  background: var(--tile-soft); border: 1px solid var(--tile); display: grid; gap: 6px;
}

.board-head { padding: 22px 0 10px; display: grid; gap: 12px; }
.board-head h1 { margin: 0; font-size: clamp(30px, 8vw, 40px); line-height: 1.05; }
.board-head p { margin: 0; }

.progress { display: grid; gap: 6px; }
.progress-row { display: grid; grid-template-columns: 52px 1fr auto; gap: 10px; align-items: center; font-size: 14px; }
.progress-name { font-weight: 700; }
.progress-track { height: 8px; border-radius: 99px; background: var(--rule); overflow: hidden; }
.progress-fill { display: block; height: 100%; border-radius: 99px; transition: width .35s ease; }
.progress-num { color: var(--ink-soft); font-variant-numeric: tabular-nums; }

.seg { display: flex; background: var(--sheet); border: 1px solid var(--rule); border-radius: 99px; padding: 3px; gap: 2px; }
.seg button {
  flex: 1; border: 0; background: none; padding: 8px 10px; border-radius: 99px; cursor: pointer;
  font-size: 15px; min-height: 40px; color: var(--ink-soft);
}
.seg .seg-on { background: var(--ink); color: var(--board); font-weight: 700; }

.toolbar { display: flex; gap: 10px; align-items: center; }
.toolbar .seg { flex: 1; }
.select select, .search, .form input, .form select, .form textarea, .add-row input, .owners select {
  width: 100%; border: 1px solid var(--rule); background: var(--sheet); border-radius: 8px;
  padding: 9px 10px; min-height: 42px;
}
.select select { width: auto; }

.room { background: var(--sheet); border: 1px solid var(--rule); border-radius: var(--radius); margin: 14px 0; overflow: hidden; }
.room-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 4px; }
.room-head h3 { margin: 0; font-size: 18px; }
.tasks { list-style: none; margin: 0; padding: 0 0 6px; }
.tasks li + li { border-top: 1px solid var(--rule); }
.task {
  display: flex; width: 100%; align-items: flex-start; gap: 12px; text-align: left;
  background: none; border: 0; padding: 11px 14px; cursor: pointer; min-height: 52px;
}
.task:active { background: var(--tile-soft); }
.check { width: 28px; height: 28px; flex: none; }
.check-box { fill: none; stroke: var(--ink-soft); stroke-width: 1.6; }
.task-prn .check-box { stroke-dasharray: 3 3; }
.check-mark {
  fill: none; stroke-width: 3.4; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 30; stroke-dashoffset: 30; animation: draw .32s cubic-bezier(.3,.7,.4,1) forwards;
}
@keyframes draw { to { stroke-dashoffset: 0; } }
.task-text { display: grid; gap: 2px; padding-top: 3px; }
.task-title { font-size: 16px; }
.task-done .task-title { color: var(--ink-soft); text-decoration: line-through; text-decoration-color: var(--ink-soft); }
.task-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 13px; color: var(--ink-soft); }
.task-by { font-family: "Kalam", cursive; font-size: 15px; line-height: 1.1; }

.owner {
  font-family: "Kalam", cursive; font-weight: 700; line-height: 1;
  border: 2px solid currentColor; border-radius: 999px; display: inline-grid; place-items: center;
}
.owner-md { min-width: 34px; height: 34px; padding: 0 6px; font-size: 17px; }
.owner-sm { min-width: 28px; height: 28px; padding: 0 5px; font-size: 14px; }
.row-owner { display: flex; align-items: center; padding-right: 14px; }
.row-owner .task { flex: 1; }

.ahead { list-style: none; margin: 0; padding: 4px 14px 12px; display: grid; gap: 8px; }
.ahead li { display: flex; justify-content: space-between; gap: 12px; }
.room-ahead { background: transparent; border-style: dashed; }

.empty { color: var(--ink-soft); padding: 18px 2px; margin: 0; }
.error { color: var(--danger); margin: 0; }

.projects { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 10px; }
.project {
  display: flex; background: var(--sheet); border: 1px solid var(--rule); border-radius: var(--radius);
  border-left: 5px solid var(--rule); overflow: hidden;
}
.prio-1 { border-left-color: var(--cass); }
.prio-2 { border-left-color: var(--tile); }
.project-main { flex: 1; text-align: left; background: none; border: 0; padding: 12px 14px; cursor: pointer; display: grid; gap: 4px; }
.project-title { font-weight: 700; }
.project-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 13px; color: var(--ink-soft); }
.project-notes { font-size: 14px; color: var(--ink-soft); }
.tag-doing { color: var(--ink); font-weight: 700; }
.project-side { display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 12px 0; }

.btn-primary, .btn-quiet, .btn-danger, .btn-small, .btn-add {
  border-radius: 999px; cursor: pointer; min-height: 42px; padding: 8px 16px;
}
.btn-primary { background: var(--ink); color: var(--board); border: 1px solid var(--ink); font-weight: 700; }
.btn-primary:disabled { opacity: .6; }
.btn-quiet { background: none; border: 1px solid var(--rule); }
.btn-quiet-danger, .btn-danger { color: var(--danger); }
.btn-danger { background: none; border: 1px solid currentColor; }
.btn-danger:disabled { opacity: .4; }
.btn-small { min-height: 34px; padding: 4px 12px; font-size: 14px; background: none; border: 1px solid var(--rule); }
.btn-add {
  width: 100%; margin: 6px 0 14px; background: none; border: 2px dashed var(--rule); color: var(--ink);
  font-weight: 700; min-height: 48px;
}

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  border: 1px solid var(--rule); background: var(--sheet); border-radius: 999px; padding: 6px 12px;
  cursor: pointer; min-height: 38px; display: inline-flex; align-items: center; gap: 8px;
}
.chip-on { background: var(--ink); color: var(--board); border-color: var(--ink); }
.chip-n { font-size: 13px; opacity: .75; font-variant-numeric: tabular-nums; }
.chip-new { border-style: dashed; }
.add-row { display: flex; gap: 8px; margin: 4px 0 8px; }
.add-row input { flex: 1; }
.list-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }

.tabs {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 6; display: flex; justify-content: center;
  background: var(--sheet); border-top: 1px solid var(--rule); padding-bottom: env(safe-area-inset-bottom);
}
.tab {
  flex: 1; max-width: 136px; height: var(--tabs-h); background: none; border: 0; cursor: pointer;
  font-size: 15px; color: var(--ink-soft); position: relative;
}
.tab-on { color: var(--ink); font-weight: 700; }
.tab-on::after {
  content: ""; position: absolute; left: 22%; right: 22%; bottom: 14px; height: 4px; border-radius: 99px;
  background: var(--me); transform: rotate(-1.5deg);
}

.sheet-wrap {
  position: fixed; inset: 0; z-index: 20; background: rgba(15, 22, 25, .45);
  display: flex; align-items: flex-end; justify-content: center;
}
.sheet {
  width: 100%; max-width: 680px; max-height: 92dvh; overflow: auto; background: var(--board);
  border-radius: 16px 16px 0 0; padding-bottom: calc(20px + env(safe-area-inset-bottom));
  animation: rise .22s ease-out;
}
@keyframes rise { from { transform: translateY(100%); } }
.sheet-head {
  position: sticky; top: 0; background: var(--board); display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--rule);
}
.sheet-head h2 { margin: 0; font-size: 20px; }
.sheet-body { padding: 4px 16px; }

.form { display: grid; gap: 14px; padding: 12px 0; }
.form label { display: grid; gap: 6px; font-weight: 700; font-size: 15px; }
.form label.inline { display: flex; align-items: center; gap: 10px; font-weight: 400; }
.form label.inline input { width: 22px; height: 22px; min-height: 0; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
.months { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.months legend { font-weight: 700; margin-bottom: 6px; font-size: 15px; }
.who { border: 0; padding: 0; margin: 0; display: grid; gap: 8px; }
.who legend { font-weight: 700; margin-bottom: 8px; }

.settings section { padding: 14px 0; border-bottom: 1px solid var(--rule); display: grid; gap: 10px; }
.settings section:last-child { border-bottom: 0; }
.settings h3 { margin: 0; font-size: 17px; }
.settings p { margin: 0; }
.side { display: flex; align-items: flex-start; gap: 10px; }
.owners { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.owners li { display: grid; grid-template-columns: 1fr 140px; gap: 10px; align-items: center; }

.edit-group h4 { margin: 8px 0 4px; font-size: 15px; }
.edit-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--rule); border-radius: var(--radius); background: var(--sheet); }
.edit-list li + li { border-top: 1px solid var(--rule); }
.edit-list button { width: 100%; text-align: left; background: none; border: 0; padding: 10px 12px; display: grid; gap: 2px; cursor: pointer; }
.edit-list .soft { font-size: 13px; }

.setup { max-width: 460px; margin: 0 auto; padding: calc(40px + env(safe-area-inset-top)) 20px 40px; }
.setup h1 { font-size: 44px; margin: 0 0 6px; }
.setup > p { margin: 0 0 18px; color: var(--ink-soft); }
.help { background: var(--sheet); border: 1px solid var(--rule); border-radius: var(--radius); padding: 10px 14px; font-size: 15px; }
.help summary { cursor: pointer; font-weight: 700; }
.help ol { padding-left: 20px; }

@media (prefers-reduced-motion: reduce) {
  .check-mark { animation: none; stroke-dashoffset: 0; }
  .sheet, .progress-fill { animation: none; transition: none; }
}
`;

/* ================================================================= boot */

const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<App />);

// Exported for tests (tests/logic.test.mjs runs against the built bundle).
(window as any).__lovetta = { roomOwner, choreOwner, weekKey, monthKey, rotationSide, lsDel };
