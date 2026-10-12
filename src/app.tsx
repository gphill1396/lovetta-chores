/* Lovetta chores — one-file React/TypeScript app for Grant and Cass.
 *
 * Static site on GitHub Pages. Shared state lives as JSON in the private
 * lovetta-chores-data repo, read and written with the GitHub contents API.
 * See CLAUDE.md for the data model and conventions.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import seedHouse from "../seed/house.json";
import seedSettings from "../seed/settings.json";
import seedLog from "../seed/log.json";
import seedProjects from "../seed/projects.json";
import seedLists from "../seed/lists.json";
import seedPlans from "../seed/plans.json";
import seedActivity from "../seed/activity.json";

/* ================================================================== types */

type Person = "grant" | "cass";
type Owner = Person | "both";
type Freq = "weekly" | "monthly" | "seasonal";
type Zone = "A" | "B" | "shared";
type Size = "S" | "M" | "L" | "XL";

interface Room { id: string; name: string; area: string; zone: Zone; fixedOwner: Owner; pinned?: boolean }
interface Chore {
  id: string;
  title: string;
  room: string;
  freq: Freq;
  prn?: boolean;
  months?: number[];
  owner?: Owner;
  note?: string;
  /** Agreed "done means…" standard (Fair Play's minimum standard of care). */
  standard?: string;
  standardBy?: Person;
  standardAt?: string;
  /** Legacy 1 quick / 2 medium / 3 big. Superseded by `size`; read via choreSize(). */
  effort?: 1 | 2 | 3;
  size?: Size;
  /** Split a room's chores between you: overrides the room's side / keep-rooms owner. */
  zone?: Zone;
  fixedOwner?: Owner;
}
interface House { version: number; rooms: Room[]; chores: Chore[] }
interface Settings {
  version: number;
  mode: "rotate" | "fixed";
  rotation: { anchorWeek: string; anchorMonth: string; zoneAStarts: Person };
  colors?: Partial<Record<Person, string>>;
  lastCheckin?: { at: string; by: Person; week: string };
}
interface DoneMark { by: Person; at: string }
interface Log { version: number; done: Record<string, DoneMark> }
type Status = "todo" | "doing" | "done";
interface Project {
  id: string; task: string; category: string; priority: number; effort: number; lead: Owner; status: Status;
  start?: string; cost?: string; notes?: string; links?: string; doneAt?: string; doneBy?: Person;
  /** weekKey of the week it was picked for in a check-in. */
  focus?: string;
  /** S/M/L/XL. Falls back to the sheet's 1–5 effort (1 = hardest); read via projectSize(). */
  size?: Size;
}
interface Projects { version: number; projects: Project[] }
interface ListItem { id: string; text: string; done: boolean; by?: Person; at?: string }
interface List { id: string; name: string; items: ListItem[] }
interface Lists { version: number; lists: List[] }
/** Per chore-instance plan, keyed "<period>|<choreId>" like the log. */
interface Plan {
  day?: string;                 // yyyy-mm-dd it's planned for
  dayBy?: Person;
  owner?: Person;               // covering for this period only (a trade)
  skip?: { by: Person; reason: string; at: string };
}
interface Plans { version: number; items: Record<string, Plan> }
type RefType = "chore" | "project" | "item";
interface Ref { type: RefType; id: string; title: string; period?: string; list?: string }
type Kind = "note" | "request" | "kudos" | "nudge" | "skip" | "standard" | "took" | "checkin";
interface Activity {
  id: string; at: string; by: Person; kind: Kind;
  ref?: Ref; text?: string; to?: Person;
  status?: "open" | "accepted" | "declined"; permanent?: boolean; answeredAt?: string; editedAt?: string;
}
interface ActivityFile { version: number; items: Activity[] }

interface Data {
  house: House; settings: Settings; log: Log; projects: Projects; lists: Lists; plans: Plans; activity: ActivityFile;
}
type FileName = keyof Data;
const FILES: FileName[] = ["house", "settings", "log", "projects", "lists", "plans", "activity"];
const SEED: Data = {
  house: seedHouse as House, settings: seedSettings as Settings, log: seedLog as Log,
  projects: seedProjects as Projects, lists: seedLists as Lists, plans: seedPlans as Plans,
  activity: seedActivity as ActivityFile,
};

interface Config { me?: Person; mode?: "github" | "local"; repo: string; branch: string; token: string }

/* ================================================================ people */

const NAME: Record<Owner, string> = { grant: "Grant", cass: "Cass", both: "Together" };
const other = (p: Person): Person => (p === "grant" ? "cass" : "grant");
const ink = (o: Owner) => `var(--${o})`;
const isFor = (owner: Owner, p: Person) => owner === p || owner === "both";

const INKS = [
  { id: "blue", name: "Blue", light: "#2457A6", dark: "#8FB3EE" },
  { id: "oxblood", name: "Oxblood", light: "#8A2433", dark: "#E8949F" },
  { id: "forest", name: "Forest", light: "#2E6B45", dark: "#8FCBA2" },
  { id: "plum", name: "Plum", light: "#6B3A8E", dark: "#C8A3E6" },
  { id: "teal", name: "Teal", light: "#17707A", dark: "#7FCFD6" },
  { id: "rust", name: "Rust", light: "#A04A12", dark: "#F0A36B" },
  { id: "rose", name: "Rose", light: "#B0466C", dark: "#F2A0BC" },
];
const DEFAULT_INK: Record<Person, string> = { grant: "blue", cass: "oxblood" };

/* =============================================================== storage */

const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

const CONFIG_KEY = "lc:config";
const DEFAULT_CONFIG: Config = { repo: "gphill1396/lovetta-chores-data", branch: "main", token: "" };
function loadConfig(): Config {
  try { const raw = lsGet(CONFIG_KEY); return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG }; }
  catch { return { ...DEFAULT_CONFIG }; }
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

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b: string): string {
  const bin = atob(b.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** data/<name>.json in the data repo. Writes re-read and re-apply the
 *  mutation on a sha conflict, so every mutation must be an idempotent set. */
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
      const seeded = clone(SEED[name]);
      try { await this.put(name, seeded, `Set up ${name}.json`); }
      catch (e) {
        // The other phone created it a moment ago; read theirs instead.
        if (e instanceof HttpError && e.status === 422) return this.load(name, true);
        throw e;
      }
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
    const body: Record<string, unknown> = { message, content: b64encode(JSON.stringify(data, null, 1) + "\n") };
    if (this.sha[name]) body.sha = this.sha[name];
    if (this.cfg.branch) body.branch = this.cfg.branch;
    const res = await fetch(this.url(name).split("?")[0], {
      method: "PUT", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res);
    const out = await res.json();
    this.sha[name] = out.content.sha;
    delete this.etag[name];
    (this.cache as any)[name] = data;
  }
  async save<K extends FileName>(name: K, mutate: (d: Data[K]) => Data[K], message: string): Promise<Data[K]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = attempt === 0 && this.cache[name] ? (this.cache[name] as Data[K]) : await this.load(name, true);
      const next = mutate(clone(current));
      try { await this.put(name, next, message); return next; }
      catch (e) {
        lastErr = e;
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
    res.status === 401 ? "GitHub didn't accept the token. Paste a new one in Settings → Sync." :
    res.status === 403 ? "The token can't write to the data repo. It needs Contents: read and write." :
    res.status === 404 ? "Couldn't find the data repo. Check the repo name and that the token includes it." :
    `GitHub returned ${res.status}${detail ? `: ${detail}` : ""}. Try again in a minute.`;
  return new HttpError(res.status, hint);
}

/* ================================================================ dates */

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
function mondayOf(d: Date): Date { return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7)); }
const weekDays = (d: Date) => Array.from({ length: 7 }, (_, i) => addDays(mondayOf(d), i));
const weekIndex = (d: Date) => { const m = mondayOf(d); return Math.round(Date.UTC(m.getFullYear(), m.getMonth(), m.getDate()) / (7 * 864e5)); };
const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();
const weekKey = (d: Date) => "W" + dayKey(mondayOf(d));
const monthKey = (d: Date) => `M${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const periodKey = (freq: Freq, d: Date) => (freq === "weekly" ? weekKey(d) : monthKey(d));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmtShort = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const diff = Math.round((parseDay(dayKey(now)).getTime() - parseDay(dayKey(d)).getTime()) / 864e5);
  const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return `today ${t}`;
  if (diff === 1) return `yesterday ${t}`;
  if (diff < 7) return DAYS[d.getDay()];
  return fmtShort(d);
}
function periodStart(key: string): Date | null {
  if (key.startsWith("W")) return parseDay(key.slice(1));
  if (key.startsWith("M")) { const [y, m] = key.slice(1).split("-").map(Number); return new Date(y, m - 1, 1); }
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
function baseOwner(c: Chore, rooms: Map<string, Room>, settings: Settings, now: Date): Owner {
  if (c.owner) return c.owner;
  const room = rooms.get(c.room);
  if (!room || (!c.zone && !c.fixedOwner)) return roomOwner(room, settings, c.freq, now);
  return roomOwner({ ...room, zone: c.zone ?? room.zone, fixedOwner: c.fixedOwner ?? room.fixedOwner }, settings, c.freq, now);
}
/** Seasonal chores need months; weekly/monthly chores can optionally be limited to some months (mowing). */
const isDue = (c: Chore, now: Date) => c.months?.length ? c.months.includes(now.getMonth() + 1) : c.freq !== "seasonal";
function monthRange(ms: number[]): string {
  const sorted = [...ms].sort((a, b) => a - b);
  const contiguous = sorted.every((m, i) => i === 0 || m === sorted[i - 1] + 1);
  return contiguous && sorted.length > 2 ? `${MONTHS[sorted[0] - 1]}–${MONTHS[sorted[sorted.length - 1] - 1]}` : sorted.map((m) => MONTHS[m - 1]).join(", ");
}
const SIZES: Size[] = ["S", "M", "L", "XL"];
const SIZE_WEIGHT: Record<Size, number> = { S: 1, M: 2, L: 4, XL: 8 };
const SIZE_HINT: Record<Size, string> = { S: "15 min or less", M: "15 to 60 min", L: "1 to 4 hours", XL: "A day or a weekend" };
const choreSize = (c: Chore): Size => c.size ?? (c.effort === 1 ? "S" : c.effort === 3 ? "L" : "M");
const projectSize = (p: Project): Size => p.size ?? (p.effort >= 5 ? "S" : p.effort === 4 ? "M" : p.effort === 3 ? "L" : "XL");
const effortFromSize: Record<Size, number> = { S: 5, M: 4, L: 3, XL: 2 };
type Fit = "any" | Size;
const FITS: { value: Fit; label: string }[] = [
  { value: "any", label: "Any" }, { value: "S", label: "15 min" }, { value: "M", label: "1 hr" },
  { value: "L", label: "Afternoon" }, { value: "XL", label: "Weekend" },
];
const fits = (size: Size, fit: Fit) => fit === "any" || SIZE_WEIGHT[size] <= SIZE_WEIGHT[fit];
function sizeTally(sizes: Size[]): string {
  return SIZES.filter((z) => sizes.includes(z)).map((z) => `${sizes.filter((x) => x === z).length} ${z}`).join(", ");
}

/** Everything about one chore for one period (this week / this month). */
interface Inst {
  c: Chore; key: string; period: string; owner: Owner; covering: boolean;
  mark?: DoneMark; plan?: Plan; skipped: boolean;
}

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
      if (pending.current > 0) return;
      setData(Object.fromEntries(FILES.map((f, i) => [f, parts[i]])) as unknown as Data);
      setError(null);
      setSync((s) => (s === "offline" ? "idle" : s));
    } catch (e) {
      setError(e instanceof TypeError ? "Can't reach GitHub. Check your connection, then tap Try again." : (e as Error).message);
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

  const mutate = useCallback(async <K extends FileName>(name: K, fn: (d: Data[K]) => Data[K], message: string) => {
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
      setError(e instanceof TypeError ? "That change didn't save because GitHub couldn't be reached. Tap Try again." : (e as Error).message);
      try { const fresh = await store.load(name, true); setData((d) => (d ? { ...d, [name]: fresh } : d)); } catch { /* keep error */ }
    }
  }, [store]);

  return { data, error, sync, reload, mutate, clearError: () => setError(null) };
}
type Mutate = ReturnType<typeof useData>["mutate"];

function useDark() {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [dark, setDark] = useState(!!q?.matches);
  useEffect(() => {
    if (!q) return;
    const f = () => setDark(q.matches);
    q.addEventListener?.("change", f);
    return () => q.removeEventListener?.("change", f);
  }, [q]);
  return dark;
}

const uid = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const nowIso = () => new Date().toISOString();

/* ============================================================== context */

interface Toast { id: number; text: string; undo?: () => void }

interface Ctx {
  data: Data; me: Person; now: Date; rooms: Map<string, Room>; mutate: Mutate;
  inst: (c: Chore, at?: Date) => Inst;
  act: ReturnType<typeof makeActions>;
  toast: (text: string, undo?: () => void) => void;
  openChore: (c: Chore) => void;
  openInbox: () => void;
  openCheckin: () => void;
  goTab: (t: Tab) => void;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
const useApp = () => useContext(AppCtx);

/* ============================================================== actions */

function addActivity(item: Activity) {
  return (d: ActivityFile): ActivityFile => {
    if (d.items.some((x) => x.id === item.id)) return d;
    const cutoff = Date.now() - 180 * 864e5;
    d.items = [...d.items, item]
      .filter((x) => new Date(x.at).getTime() > cutoff || x.status === "open")
      .slice(-600);
    return d;
  };
}
function prunePlans(d: Plans) {
  const cutoff = Date.now() - 120 * 864e5;
  for (const k of Object.keys(d.items)) {
    const s = periodStart(k.split("|")[0]);
    if (s && s.getTime() < cutoff) delete d.items[k];
  }
  return d;
}

function makeActions(data: Data, me: Person, mutate: Mutate, toast: Ctx["toast"]) {
  const N = NAME[me];
  const setPlan = (key: string, patch: (p: Plan) => void, msg: string) =>
    mutate("plans", (d) => {
      const p = d.items[key] ?? {};
      patch(p);
      if (!p.day && !p.owner && !p.skip) delete d.items[key]; else d.items[key] = p;
      return prunePlans(d);
    }, msg);
  const act = {
    setDone(i: Inst, on: boolean, silent = false) {
      const prev = data.log.done[i.key];
      const cutoff = Date.now() - 400 * 864e5;
      mutate("log", (d) => {
        if (on) d.done[i.key] = { by: me, at: nowIso() }; else delete d.done[i.key];
        for (const k of Object.keys(d.done)) {
          const s = periodStart(k.split("|")[0]);
          if (s && s.getTime() < cutoff) delete d.done[k];
        }
        return d;
      }, `${N} ${on ? "checked off" : "unchecked"} "${i.c.title}"`);
      if (!silent) toast(on ? `Checked off ${i.c.title}` : `Unchecked ${i.c.title}`, () =>
        mutate("log", (d) => { if (prev) d.done[i.key] = prev; else delete d.done[i.key]; return d; }, `${N} undid a change to "${i.c.title}"`));
    },
    planDay(i: Inst, day: string | null) {
      const prev = i.plan?.day;
      setPlan(i.key, (p) => { if (day) { p.day = day; p.dayBy = me; } else { delete p.day; delete p.dayBy; } },
        day ? `${N} planned "${i.c.title}" for ${DAYS_LONG[parseDay(day).getDay()]}` : `${N} unplanned "${i.c.title}"`);
      toast(day ? `${i.c.title} is on ${DAYS_LONG[parseDay(day).getDay()]}` : `${i.c.title} has no day now`, () =>
        setPlan(i.key, (p) => { if (prev) p.day = prev; else delete p.day; }, `${N} undid planning "${i.c.title}"`));
    },
    skip(i: Inst, reason: string | null) {
      const prev = i.plan?.skip;
      setPlan(i.key, (p) => { if (reason) p.skip = { by: me, reason, at: nowIso() }; else delete p.skip; },
        reason ? `${N} skipped "${i.c.title}": ${reason}` : `${N} un-skipped "${i.c.title}"`);
      if (reason && i.owner !== me) {
        mutate("activity", addActivity({ id: uid("a"), at: nowIso(), by: me, kind: "skip", ref: { type: "chore", id: i.c.id, title: i.c.title, period: i.period }, text: reason, to: other(me) }), `${N} skipped "${i.c.title}"`);
      }
      toast(reason ? `Skipped ${i.c.title} for now` : `${i.c.title} is back on the list`, () =>
        setPlan(i.key, (p) => { if (prev) p.skip = prev; else delete p.skip; }, `${N} undid skipping "${i.c.title}"`));
    },
    take(i: Inst) {
      const prev = i.plan?.owner;
      setPlan(i.key, (p) => { p.owner = me; }, `${N} took "${i.c.title}"`);
      mutate("activity", addActivity({ id: uid("a"), at: nowIso(), by: me, kind: "took", ref: { type: "chore", id: i.c.id, title: i.c.title, period: i.period }, to: other(me) }), `${N} took "${i.c.title}"`);
      toast(`${i.c.title} is yours this time`, () =>
        setPlan(i.key, (p) => { if (prev) p.owner = prev; else delete p.owner; }, `${N} gave back "${i.c.title}"`));
    },
    request(i: Inst, note: string, permanent: boolean) {
      mutate("activity", addActivity({
        id: uid("a"), at: nowIso(), by: me, kind: "request", to: other(me), status: "open", permanent,
        ref: { type: "chore", id: i.c.id, title: i.c.title, period: i.period }, text: note.trim() || undefined,
      }), `${N} asked ${NAME[other(me)]} to take "${i.c.title}"`);
      toast(`Asked ${NAME[other(me)]} to take ${i.c.title}`);
    },
    answer(a: Activity, accept: boolean) {
      mutate("activity", (d) => {
        const x = d.items.find((y) => y.id === a.id);
        if (x && x.status === "open") { x.status = accept ? "accepted" : "declined"; x.answeredAt = nowIso(); }
        return d;
      }, `${N} ${accept ? "took" : "passed on"} "${a.ref?.title}"`);
      if (accept && a.ref?.type === "chore") {
        if (a.permanent) {
          mutate("house", (d) => { const c = d.chores.find((y) => y.id === a.ref!.id); if (c) c.owner = me; return d; },
            `"${a.ref.title}" is ${N}'s from now on`);
        } else if (a.ref.period) {
          setPlan(`${a.ref.period}|${a.ref.id}`, (p) => { p.owner = me; }, `${N} is covering "${a.ref.title}"`);
        }
      }
      toast(accept ? `${a.ref?.title} is yours ${a.permanent ? "from now on" : "this time"}` : `Let ${NAME[a.by]} know you can't`);
    },
    cancelRequest(a: Activity) {
      mutate("activity", (d) => ({ ...d, items: d.items.filter((x) => x.id !== a.id) }), `${N} withdrew a request`);
      toast("Request withdrawn");
    },
    nudge(i: Inst) {
      const id = uid("a");
      mutate("activity", addActivity({ id, at: nowIso(), by: me, kind: "nudge", to: other(me), ref: { type: "chore", id: i.c.id, title: i.c.title, period: i.period } }),
        `${N} sent a reminder about "${i.c.title}"`);
      toast(`Reminded ${NAME[other(me)]} about ${i.c.title}`, () =>
        mutate("activity", (d) => ({ ...d, items: d.items.filter((x) => x.id !== id) }), `${N} took back a reminder`));
    },
    kudos(ref: Ref, to: Person, text?: string) {
      mutate("activity", addActivity({ id: uid("a"), at: nowIso(), by: me, kind: "kudos", to, ref, text }),
        `${N} thanked ${NAME[to]} for "${ref.title}"`);
      toast(`Thanks sent to ${NAME[to]}`);
    },
    note(ref: Ref, text: string) {
      const t = text.trim();
      if (!t) return;
      mutate("activity", addActivity({ id: uid("a"), at: nowIso(), by: me, kind: "note", to: other(me), ref, text: t }),
        `${N} left a note on "${ref.title}"`);
    },
    deleteNote(a: Activity) {
      mutate("activity", (d) => ({ ...d, items: d.items.filter((x) => x.id !== a.id) }), `${N} deleted a note`);
    },
    setStandard(c: Chore, text: string) {
      const t = text.trim();
      mutate("house", (d) => {
        const x = d.chores.find((y) => y.id === c.id);
        if (x) { if (t) { x.standard = t; x.standardBy = me; x.standardAt = nowIso(); } else { delete x.standard; delete x.standardBy; delete x.standardAt; } }
        return d;
      }, `${N} updated what done means for "${c.title}"`);
      if (t) mutate("activity", addActivity({ id: uid("a"), at: nowIso(), by: me, kind: "standard", to: other(me), ref: { type: "chore", id: c.id, title: c.title }, text: t }),
        `${N} updated what done means for "${c.title}"`);
      toast("Saved what done means");
    },
    setSize(c: Chore, z: Size) {
      mutate("house", (d) => { const x = d.chores.find((y) => y.id === c.id); if (x) { x.size = z; delete x.effort; } return d; },
        `${N} sized "${c.title}" ${z}`);
    },
    editNote(a: Activity, text: string) {
      const t = text.trim();
      if (!t) return;
      mutate("activity", (d) => { const x = d.items.find((y) => y.id === a.id); if (x) { x.text = t; x.editedAt = nowIso(); } return d; },
        `${N} edited a note on "${a.ref?.title}"`);
      toast("Note updated");
    },
    saveChore(c: Chore) {
      const isNew = !data.house.chores.some((x) => x.id === c.id);
      mutate("house", (d) => { const i = d.chores.findIndex((x) => x.id === c.id); if (i >= 0) d.chores[i] = c; else d.chores.push(c); return d; },
        `${N} ${isNew ? "added" : "edited"} chore "${c.title}"`);
      toast(isNew ? `Added ${c.title}` : `Saved ${c.title}`);
    },
    removeChore(c: Chore) {
      const snapshot = clone(c);
      const idx = data.house.chores.findIndex((x) => x.id === c.id);
      mutate("house", (d) => ({ ...d, chores: d.chores.filter((x) => x.id !== c.id) }), `${N} removed chore "${c.title}"`);
      toast(`Removed ${c.title}`, () => mutate("house", (d) => {
        if (!d.chores.some((x) => x.id === snapshot.id)) d.chores.splice(Math.max(0, idx), 0, snapshot);
        return d;
      }, `${N} restored chore "${c.title}"`));
    },
    saveRoom(r: Room) {
      const isNew = !data.house.rooms.some((x) => x.id === r.id);
      mutate("house", (d) => { const i = d.rooms.findIndex((x) => x.id === r.id); if (i >= 0) d.rooms[i] = r; else d.rooms.push(r); return d; },
        `${N} ${isNew ? "added" : "edited"} room ${r.name}`);
    },
    removeRoom(r: Room) {
      mutate("house", (d) => ({ ...d, rooms: d.rooms.filter((x) => x.id !== r.id) }), `${N} removed room ${r.name}`);
    },
    saveProject(p: Project) {
      const isNew = !data.projects.projects.some((x) => x.id === p.id);
      mutate("projects", (d) => { const i = d.projects.findIndex((x) => x.id === p.id); if (i >= 0) d.projects[i] = p; else d.projects.unshift(p); return d; },
        `${N} ${isNew ? "added" : "updated"} project "${p.task}"`);
      toast(isNew ? `Added ${p.task}` : `Saved ${p.task}`);
    },
    removeProject(p: Project) {
      const snapshot = clone(p);
      mutate("projects", (d) => ({ ...d, projects: d.projects.filter((x) => x.id !== p.id) }), `${N} deleted project "${p.task}"`);
      toast(`Deleted ${p.task}`, () => mutate("projects", (d) => {
        if (!d.projects.some((x) => x.id === snapshot.id)) d.projects.unshift(snapshot);
        return d;
      }, `${N} restored project "${p.task}"`));
    },
    projectStatus(p: Project, status: Status) {
      const prev = { status: p.status, doneAt: p.doneAt, doneBy: p.doneBy };
      mutate("projects", (d) => {
        const x = d.projects.find((y) => y.id === p.id);
        if (x) { x.status = status; if (status === "done") { x.doneAt = nowIso(); x.doneBy = me; } else { delete x.doneAt; delete x.doneBy; } }
        return d;
      }, `${N} marked "${p.task}" ${STATUS[status].toLowerCase()}`);
      toast(status === "done" ? `Finished ${p.task}` : `${p.task} is ${STATUS[status].toLowerCase()}`, () =>
        mutate("projects", (d) => { const x = d.projects.find((y) => y.id === p.id); if (x) Object.assign(x, prev); return d; }, `${N} undid a change to "${p.task}"`));
    },
    setFocus(p: Project, week: string | null) {
      mutate("projects", (d) => { const x = d.projects.find((y) => y.id === p.id); if (x) { if (week) x.focus = week; else delete x.focus; } return d; },
        week ? `${N} picked "${p.task}" for this week` : `${N} dropped "${p.task}" from this week`);
    },
    settings(fn: (s: Settings) => Settings, msg: string) { mutate("settings", fn, `${N} ${msg}`); },
    lockSplit(now: Date) {
      const owners = new Map(data.house.rooms.map((r) => [r.id, roomOwner(r, data.settings, "weekly", now)]));
      const rooms = new Map(data.house.rooms.map((r) => [r.id, r]));
      const split = new Map(data.house.chores.filter((c) => c.zone && !c.owner).map((c) => [c.id, baseOwner(c, rooms, data.settings, now)]));
      mutate("house", (d) => {
        d.rooms.forEach((r) => { const o = owners.get(r.id); if (o) r.fixedOwner = o; });
        d.chores.forEach((c) => { const o = split.get(c.id); if (o) c.fixedOwner = o; });
        return d;
      }, `${N} kept this week's room split`);
      mutate("settings", (d) => ({ ...d, mode: "fixed" }), `${N} switched to keeping rooms`);
      toast("Rooms will stay put until you switch back");
    },
    setFixed(room: Room, o: Owner) {
      mutate("house", (d) => { const r = d.rooms.find((x) => x.id === room.id); if (r) r.fixedOwner = o; return d; }, `${N} gave ${room.name} to ${NAME[o]}`);
    },
    checkin(week: string, summary: string) {
      mutate("settings", (d) => ({ ...d, lastCheckin: { at: nowIso(), by: me, week } }), `${N} finished the weekly check-in`);
      mutate("activity", addActivity({ id: "checkin-" + week, at: nowIso(), by: me, kind: "checkin", to: other(me), text: summary }), `${N} finished the weekly check-in`);
      toast("Check-in done. Have a good week!");
    },
  };
  return act;
}

/* ========================================================== small parts */

function Check({ on, color, dashed }: { on: boolean; color: string; dashed?: boolean }) {
  return (
    <svg className="check" viewBox="0 0 28 28" aria-hidden="true">
      <rect className={dashed ? "check-box check-box-dashed" : "check-box"} x="3" y="3" width="22" height="22" rx="4" />
      {on && <path className="check-mark" style={{ stroke: color }} d="M6.5 14.6c2 1.3 3.7 3.4 5.3 5.9 2.9-5.6 7.1-10.7 12.6-14.3" />}
    </svg>
  );
}

function OwnerMark({ owner, size = "md" }: { owner: Owner; size?: "sm" | "md" }) {
  return (
    <span className={`owner owner-${size}`} style={{ color: ink(owner) }} title={NAME[owner]} aria-label={NAME[owner]}>
      {owner === "both" ? "G+C" : NAME[owner][0]}
    </span>
  );
}

function Segmented<T extends string | number>({ value, options, onChange, label, small }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; small?: boolean;
}) {
  return (
    <div className={small ? "seg seg-small" : "seg"} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={value === o.value}
          className={value === o.value ? "seg-on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function Sheet({ title, onClose, children, wide, action }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; action?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={wide ? "sheet sheet-tall" : "sheet"} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <span className="sheet-actions">
            {action}
            <button type="button" className="btn-quiet" onClick={onClose}>Close</button>
          </span>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Bars({ rows }: { rows: { p: Person; done: number; total: number }[] }) {
  return (
    <div className="progress">
      {rows.map(({ p, done, total }) => (
        <div key={p} className="progress-row">
          <span className="progress-name">{NAME[p]}</span>
          <span className="progress-track"><span className="progress-fill" style={{ width: total ? `${(done / total) * 100}%` : "0%", background: ink(p) }} /></span>
          <span className="progress-num">{done} of {total}</span>
        </div>
      ))}
    </div>
  );
}

/** Effort balance this month: everything weighted by size (S1 M2 L4 XL8). */
function useBalance(at: Date) {
  const { data, rooms } = useApp();
  return useMemo(() => {
    const pts = { grant: 0, cass: 0 };
    const byId = new Map(data.house.chores.map((c) => [c.id, c]));
    const m = at.getMonth(), y = at.getFullYear();
    for (const [k, mark] of Object.entries(data.log.done)) {
      const d = new Date(mark.at);
      if (d.getMonth() !== m || d.getFullYear() !== y) continue;
      const c = byId.get(k.split("|")[1]);
      pts[mark.by] += c ? SIZE_WEIGHT[choreSize(c)] : 2;
    }
    for (const p of data.projects.projects) {
      if (p.status !== "done" || !p.doneAt || !p.doneBy) continue;
      const d = new Date(p.doneAt);
      if (d.getMonth() === m && d.getFullYear() === y) pts[p.doneBy] += SIZE_WEIGHT[projectSize(p)];
    }
    return pts;
  }, [data, rooms, at]);
}

function Balance({ at, label }: { at: Date; label?: string }) {
  const pts = useBalance(at);
  const total = pts.grant + pts.cass;
  return (
    <div className="balance">
      <div className="balance-label">
        <span>{label ?? `Effort in ${MONTHS_LONG[at.getMonth()]}`}</span>
        <span className="soft">{total ? `Grant ${pts.grant}, Cass ${pts.cass}` : "Nothing yet"}</span>
      </div>
      <div className="balance-bar" aria-hidden="true">
        {total > 0 ? (
          <>
            <span style={{ flex: pts.grant, background: ink("grant") }} />
            <span style={{ flex: pts.cass, background: ink("cass") }} />
          </>
        ) : <span style={{ flex: 1, background: "var(--rule)" }} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ task row */

function notesFor(data: Data, type: RefType, id: string) {
  return data.activity.items.filter((a) => a.kind === "note" && a.ref?.type === type && a.ref.id === id);
}

function SizeTag({ size }: { size: Size }) {
  return <span className={`size size-${size}`} title={SIZE_HINT[size]}>{size}</span>;
}

function TaskRow({ i, showRoom, showOwner, showDay }: { i: Inst; showRoom?: boolean; showOwner?: boolean; showDay?: boolean }) {
  const { act, openChore, rooms, now, data, me } = useApp();
  const on = !!i.mark;
  const notes = notesFor(data, "chore", i.c.id).length;
  const meta: React.ReactNode[] = [<SizeTag key="z" size={choreSize(i.c)} />];
  if (showRoom) meta.push(<span key="r">{rooms.get(i.c.room)?.name}</span>);
  if (showDay && i.plan?.day && !on) {
    const d = parseDay(i.plan.day);
    const late = i.plan.day < dayKey(now);
    meta.push(<span key="d" className={late ? "late" : undefined}>{late ? `Planned ${DAYS[d.getDay()]}` : DAYS_LONG[d.getDay()]}</span>);
  }
  if (i.c.prn) meta.push(<span key="p">as needed</span>);
  if (i.covering) meta.push(<span key="cv" style={{ color: ink(i.owner) }}>{i.owner === me ? "You're covering" : `${NAME[i.owner]} is covering`}</span>);
  if (i.skipped) meta.push(<span key="s">Skipped: {i.plan!.skip!.reason}</span>);
  if (on) meta.push(<span key="b" className="task-by" style={{ color: ink(i.mark!.by) }}>{NAME[i.mark!.by]}, {when(i.mark!.at, now)}</span>);
  if (notes) meta.push(<span key="n">{notes} {notes === 1 ? "note" : "notes"}</span>);
  return (
    <li className={`task${on ? " task-done" : ""}${i.skipped ? " task-skipped" : ""}`}>
      <button type="button" className="task-check" aria-pressed={on}
        aria-label={on ? `Uncheck ${i.c.title}` : `Check off ${i.c.title}`} onClick={() => act.setDone(i, !on)}>
        <Check on={on} color={i.mark ? ink(i.mark.by) : "currentColor"} dashed={i.c.prn} />
      </button>
      <button type="button" className="task-open" onClick={() => openChore(i.c)}>
        <span className="task-title">{i.c.title}</span>
        {meta.length > 0 && <span className="task-meta">{meta}</span>}
      </button>
      {showOwner && <span className="task-owner"><OwnerMark owner={i.owner} size="sm" /></span>}
    </li>
  );
}

function FitPicker({ value, onChange }: { value: Fit; onChange: (f: Fit) => void }) {
  return (
    <div className="fit">
      <span className="fit-label">I have</span>
      <Segmented small label="I have" value={value} onChange={onChange} options={FITS} />
    </div>
  );
}
function useFit(key: string): [Fit, (f: Fit) => void] {
  const [fit, setFit] = useState<Fit>(() => { const v = lsGet(key) as Fit; return FITS.some((f) => f.value === v) ? v : "any"; });
  return [fit, (f) => { setFit(f); lsSet(key, f); }];
}

/* ================================================================ Today */

function RequestCard({ a }: { a: Activity }) {
  const { act, me, now } = useApp();
  const mine = a.by === me;
  return (
    <div className="request" style={{ borderColor: ink(a.by) }}>
      <p className="request-text">
        {mine
          ? <>You asked {NAME[a.to!]} to take <b>{a.ref?.title}</b> {a.permanent ? "from now on" : "this time"}.</>
          : <><b style={{ color: ink(a.by) }}>{NAME[a.by]}</b> asked you to take <b>{a.ref?.title}</b> {a.permanent ? "from now on" : "this time"}.</>}
      </p>
      {a.text && <p className="quote">“{a.text}”</p>}
      <p className="soft small">{when(a.at, now)}</p>
      {a.status === "open" ? (
        mine ? (
          <div className="form-actions"><button type="button" className="btn-quiet" onClick={() => act.cancelRequest(a)}>Withdraw</button></div>
        ) : (
          <div className="form-actions">
            <button type="button" className="btn-quiet" onClick={() => act.answer(a, false)}>Can't this time</button>
            <button type="button" className="btn-primary" onClick={() => act.answer(a, true)}>I'll take it</button>
          </div>
        )
      ) : (
        <p className="small"><b>{a.status === "accepted" ? `${NAME[a.to!]} took it` : `${NAME[a.to!]} can't this time`}</b></p>
      )}
    </div>
  );
}

function TodayView() {
  const { data, me, now, inst, openInbox, openCheckin, goTab } = useApp();
  const today = dayKey(now);
  const all = data.house.chores.filter((c) => isDue(c, now)).map((c) => inst(c));
  const mine = all.filter((i) => isFor(i.owner, me));
  const [fit, setFit] = useFit("lc:fit");
  const [openProject, setOpenProject] = useState<Project | null>(null);
  const pending = mine.filter((i) => !i.mark && !i.skipped && fits(choreSize(i.c), fit));
  const open = pending.filter((i) => !i.c.prn);
  const todays = pending.filter((i) => i.plan?.day === today);
  const overdue = pending.filter((i) => i.plan?.day && i.plan.day < today);
  const unplannedWeek = open.filter((i) => !i.plan?.day && i.c.freq === "weekly");
  const unplannedMonth = open.filter((i) => !i.plan?.day && i.c.freq !== "weekly");
  const doneToday = all.filter((i) => i.mark && dayKey(new Date(i.mark.at)) === today && isFor(i.owner, me));
  const requests = data.activity.items.filter((a) => a.kind === "request" && a.status === "open" && a.to === me);
  const focus = data.projects.projects.filter((p) => p.focus === weekKey(now) && p.status !== "done" && isFor(p.lead, me));
  const unread = useUnread();
  const showCheckin = checkinDue(data, now);
  const [showWeekState, setShowWeek] = useState(false);
  const [showMonthState, setShowMonth] = useState(false);
  const showWeek = showWeekState || fit !== "any";
  const showMonth = showMonthState || fit !== "any";
  const fitProjects = fit === "any" ? [] : data.projects.projects
    .filter((p) => p.status !== "done" && isFor(p.lead, me) && fits(projectSize(p), fit))
    .sort((a, b) => a.priority - b.priority || SIZE_WEIGHT[projectSize(a)] - SIZE_WEIGHT[projectSize(b)]).slice(0, 8);

  const nothing = todays.length + overdue.length === 0;
  return (
    <section>
      <header className="board-head">
        <h1 className="marker">{DAYS_LONG[now.getDay()]}, {fmtShort(now)}</h1>
        <p className="soft">
          {nothing
            ? doneToday.length ? `You've done ${doneToday.length} today. Nothing else is planned.` : "Nothing planned for today."
            : `${todays.length + overdue.length} planned for today${doneToday.length ? `, ${doneToday.length} done` : ""}.`}
        </p>
        <FitPicker value={fit} onChange={setFit} />
        {fit !== "any" && <p className="soft small">Showing only what fits in {SIZE_HINT[fit].toLowerCase()}.</p>}
      </header>

      {unread.length > 0 && (
        <button type="button" className="since" onClick={openInbox}>
          <b>Since you last looked</b>
          <span>{summarizeUnread(unread)}</span>
          <span className="since-go">Open inbox</span>
        </button>
      )}

      {requests.map((a) => <RequestCard key={a.id} a={a} />)}

      {showCheckin && (
        <button type="button" className="since since-checkin" onClick={openCheckin}>
          <b>Weekly check-in</b>
          <span>Five minutes together: how last week went, what's next, and which projects to take on.</span>
          <span className="since-go">Start check-in</span>
        </button>
      )}

      {overdue.length > 0 && (
        <div className="room">
          <div className="room-head"><h3>Still to do from earlier</h3></div>
          <ul className="tasks">{overdue.map((i) => <TaskRow key={i.key} i={i} showRoom showDay />)}</ul>
        </div>
      )}
      <div className="room">
        <div className="room-head"><h3>Today</h3></div>
        {todays.length === 0 ? (
          <div className="empty-box">
            <p>{doneToday.length ? "All done for today 🎉" : "Nothing on today's list."}</p>
            {open.length > 0 && <button type="button" className="btn-quiet" onClick={() => goTab("week")}>Plan your week</button>}
          </div>
        ) : <ul className="tasks">{todays.map((i) => <TaskRow key={i.key} i={i} showRoom />)}</ul>}
      </div>

      {focus.length > 0 && (
        <div className="room">
          <div className="room-head"><h3>Projects this week</h3></div>
          <ul className="ahead">{focus.map((p) => (
            <li key={p.id}><button type="button" className="link-row" onClick={() => setOpenProject(p)}>
              <span>{p.task}</span><span className="soft"><SizeTag size={projectSize(p)} /> {p.category}</span>
            </button></li>
          ))}</ul>
        </div>
      )}
      {fitProjects.length > 0 && (
        <div className="room">
          <div className="room-head"><h3>Projects that fit</h3></div>
          <ul className="ahead">{fitProjects.map((p) => (
            <li key={p.id}><button type="button" className="link-row" onClick={() => setOpenProject(p)}>
              <span>{p.task}</span><span className="soft"><SizeTag size={projectSize(p)} /> {p.category}</span>
            </button></li>
          ))}</ul>
        </div>
      )}
      {openProject && <ProjectSheet p={openProject} onClose={() => setOpenProject(null)} />}

      {unplannedWeek.length > 0 && (
        <div className="room room-quiet">
          <button type="button" className="room-toggle" aria-expanded={showWeek} onClick={() => setShowWeek(!showWeek)}>
            <span>Also yours this week, no day yet</span><span className="count">{unplannedWeek.length}</span>
          </button>
          {showWeek && <ul className="tasks">{unplannedWeek.map((i) => <TaskRow key={i.key} i={i} showRoom />)}</ul>}
        </div>
      )}
      {unplannedMonth.length > 0 && (
        <div className="room room-quiet">
          <button type="button" className="room-toggle" aria-expanded={showMonth} onClick={() => setShowMonth(!showMonth)}>
            <span>Sometime in {MONTHS_LONG[now.getMonth()]}</span><span className="count">{unplannedMonth.length}</span>
          </button>
          {showMonth && <ul className="tasks">{unplannedMonth.map((i) => <TaskRow key={i.key} i={i} showRoom />)}</ul>}
        </div>
      )}
      {doneToday.length > 0 && (
        <div className="room room-quiet">
          <div className="room-head"><h3>Done today</h3></div>
          <ul className="tasks">{doneToday.map((i) => <TaskRow key={i.key} i={i} showRoom />)}</ul>
        </div>
      )}
    </section>
  );
}

/* ============================================================ Week plan */

type Filter = "me" | "them" | "all";

function WeekView() {
  const { data, me, now, inst, openCheckin } = useApp();
  const [filter, setFilter] = useState<Filter>(() => (lsGet("lc:weekfilter") as Filter) || "me");
  const [showTray, setShowTray] = useState(false);
  useEffect(() => lsSet("lc:weekfilter", filter), [filter]);
  const days = weekDays(now);
  const today = dayKey(now);
  const all = data.house.chores.filter((c) => isDue(c, now)).map((c) => inst(c));
  const who = filter === "me" ? me : filter === "them" ? other(me) : null;
  const shown = all.filter((i) => !who || isFor(i.owner, who));
  const weekly = all.filter((i) => i.c.freq === "weekly" && !i.c.prn && !i.skipped);
  const rows = ([me, other(me)] as Person[]).map((p) => {
    const mine = weekly.filter((i) => isFor(i.owner, p));
    return { p, done: mine.filter((i) => i.mark).length, total: mine.length };
  });
  const tray = shown.filter((i) => i.c.freq === "weekly" && !i.c.prn && !i.plan?.day && !i.mark && !i.skipped);

  return (
    <section>
      <header className="board-head">
        <h1 className="marker">Week of {fmtShort(days[0])}</h1>
        <p className="soft">Tap a chore to put it on a day. You both see the same plan.</p>
        <Bars rows={rows} />
        <Balance at={now} />
        <Segmented label="Show" value={filter} onChange={setFilter} options={[
          { value: "me", label: "Mine" }, { value: "them", label: NAME[other(me)] }, { value: "all", label: "Both of us" },
        ]} />
        {tray.length > 0 && (
          <button type="button" className="link-btn tray-jump" onClick={() => { setShowTray(true); setTimeout(() => document.querySelector(".room-tray")?.scrollIntoView({ behavior: "smooth", block: "start" }), 30); }}>
            {tray.length} {tray.length === 1 ? "chore needs" : "chores need"} a day
          </button>
        )}
      </header>

      {days.map((d) => {
        const k = dayKey(d);
        const items = shown.filter((i) => i.plan?.day === k);
        return (
          <div key={k} className={`room lane${k === today ? " lane-today" : ""}${k < today ? " lane-past" : ""}`}>
            <div className="room-head">
              <h3>{DAYS_LONG[d.getDay()]} <span className="soft lane-date">{fmtShort(d)}</span></h3>
              {k === today && <span className="lane-badge">Today</span>}
            </div>
            {items.length === 0
              ? <p className="lane-empty">{k < today ? "Nothing was planned." : "Open"}</p>
              : <ul className="tasks">{items.map((i) => <TaskRow key={i.key} i={i} showRoom showOwner />)}</ul>}
          </div>
        );
      })}
      <div className="room room-tray">
        <button type="button" className="room-toggle" aria-expanded={showTray} onClick={() => setShowTray(!showTray)}>
          <span>No day yet</span><span className="count">{tray.length}</span>
        </button>
        {showTray && (tray.length === 0
          ? <p className="empty-box">Every weekly chore has a day. Nice planning.</p>
          : <ul className="tasks">{tray.map((i) => <TaskRow key={i.key} i={i} showRoom showOwner />)}</ul>)}
      </div>
      <button type="button" className="btn-add" onClick={openCheckin}>Weekly check-in</button>
    </section>
  );
}

/* ============================================================ Chores tab */

function ChoresView() {
  const { data, me, now, inst, rooms } = useApp();
  const [freq, setFreq] = useState<Freq>(() => (lsGet("lc:freq") as Freq) || "weekly");
  const [filter, setFilter] = useState<Filter>(() => (lsGet("lc:filter") as Filter) || "me");
  useEffect(() => { lsSet("lc:freq", freq); lsSet("lc:filter", filter); }, [freq, filter]);
  const who = filter === "me" ? me : filter === "them" ? other(me) : null;
  const month = now.getMonth() + 1;

  const list = data.house.chores.filter((c) => c.freq === freq && isDue(c, now)).map((c) => inst(c));
  const rowsP = ([me, other(me)] as Person[]).map((p) => {
    const mine = list.filter((i) => !i.c.prn && !i.skipped && isFor(i.owner, p));
    return { p, done: mine.filter((i) => i.mark).length, total: mine.length };
  });
  const groups = data.house.rooms.map((r) => ({
    room: r,
    owner: roomOwner(r, data.settings, freq, now),
    items: list.filter((i) => i.c.room === r.id && (!who || isFor(i.owner, who))),
  })).filter((g) => g.items.length);

  const upcoming = freq === "seasonal" ? [1, 2, 3].map((k) => {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    return { d, items: data.house.chores.filter((c) => c.freq === "seasonal" && c.months?.includes(d.getMonth() + 1) && !c.months?.includes(month)) };
  }) : [];

  const heading = freq === "weekly" ? `Week of ${fmtShort(mondayOf(now))}` : freq === "monthly" ? MONTHS_LONG[now.getMonth()] : `${MONTHS_LONG[now.getMonth()]} upkeep`;
  return (
    <section>
      <header className="board-head">
        <Segmented label="How often" value={freq} onChange={setFreq} options={[
          { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "seasonal", label: "Seasonal" },
        ]} />
        <h1 className="marker">{heading}</h1>
        <p className="soft">{data.settings.mode === "rotate"
          ? freq === "weekly" ? "Rooms trade sides every Monday." : "Rooms trade sides on the 1st."
          : "Everyone keeps their rooms."}</p>
        <Bars rows={rowsP} />
        <Segmented label="Show chores for" value={filter} onChange={setFilter} options={[
          { value: "me", label: "Mine" }, { value: "them", label: NAME[other(me)] }, { value: "all", label: "Everyone" },
        ]} />
      </header>
      {groups.length === 0 && <p className="empty">Nothing here right now. Add chores in Settings → Rooms and chores.</p>}
      {groups.map((g) => (
        <div key={g.room.id} className="room">
          <div className="room-head"><h3>{g.room.name}</h3><OwnerMark owner={g.owner} /></div>
          <ul className="tasks">{g.items.map((i) => <TaskRow key={i.key} i={i} showDay showOwner={i.owner !== g.owner} />)}</ul>
        </div>
      ))}
      {upcoming.map(({ d, items }) => items.length > 0 && (
        <div key={d.getMonth()} className="room room-ahead">
          <div className="room-head"><h3>Coming in {MONTHS_LONG[d.getMonth()]}</h3></div>
          <ul className="ahead">{items.map((c) => <li key={c.id}><span>{c.title}</span><span className="soft">{rooms.get(c.room)?.name}</span></li>)}</ul>
        </div>
      ))}
    </section>
  );
}

/* ========================================================= Chore sheet */

const SKIP_REASONS = ["Not needed this time", "We're away", "Doing it next week", "Done another way"];

function Notes({ refObj }: { refObj: Ref }) {
  const { data, act, me, now } = useApp();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const notes = notesFor(data, refObj.type, refObj.id);
  return (
    <div className="notes">
      <h4>Notes</h4>
      {notes.length === 0 && <p className="soft small">No notes yet. Leave one for {NAME[other(me)]}.</p>}
      <ul className="note-list">
        {notes.map((n) => (
          <li key={n.id} className="note" style={{ borderColor: ink(n.by) }}>
            <span className="note-by" style={{ color: ink(n.by) }}>{NAME[n.by]}, {when(n.at, now)}{n.editedAt ? " (edited)" : ""}</span>
            {editing === n.id ? (
              <form className="add-row" onSubmit={(e) => { e.preventDefault(); act.editNote(n, draft); setEditing(null); }}>
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit note" />
                <button type="button" className="btn-quiet" onClick={() => setEditing(null)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={!draft.trim()}>Save</button>
              </form>
            ) : <span className="note-text">{n.text}</span>}
            {n.by === me && editing !== n.id && (
              <span className="note-actions">
                <button type="button" className="link-btn" onClick={() => { setDraft(n.text ?? ""); setEditing(n.id); }}>Edit</button>
                <button type="button" className="link-btn" onClick={() => act.deleteNote(n)}>Delete</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); act.note(refObj, text); setText(""); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note" aria-label="Add a note" />
        <button type="submit" className="btn-primary" disabled={!text.trim()}>Post</button>
      </form>
    </div>
  );
}

function ChoreSheet({ choreId, onClose, onEdit }: { choreId: string; onClose: () => void; onEdit: (c: Chore) => void }) {
  const { data, me, now, act, inst, rooms } = useApp();
  const c = data.house.chores.find((x) => x.id === choreId);
  useEffect(() => { if (!c) onClose(); }, [c, onClose]);
  const [mode, setMode] = useState<"none" | "ask" | "skip" | "standard">("none");
  const [askNote, setAskNote] = useState("");
  const [askPerm, setAskPerm] = useState(false);
  const [skipText, setSkipText] = useState("");
  const [std, setStd] = useState(c?.standard ?? "");
  if (!c) return null;
  const i = inst(c);
  const them = other(me);
  const theirs = i.owner === them;
  const today = dayKey(now);
  const pending = data.activity.items.find((a) => a.kind === "request" && a.status === "open" && a.ref?.id === c.id && a.ref.period === i.period);
  const thanked = i.mark && data.activity.items.some((a) => a.kind === "kudos" && a.by === me && a.ref?.id === c.id && a.ref.period === i.period);
  const days = c.freq === "weekly" ? weekDays(now) : weekDays(now).filter((d) => d.getMonth() === now.getMonth());
  const span = c.months?.length ? monthRange(c.months) : "";
  const freqLabel = c.freq === "weekly" ? `Every week${span ? `, ${span}` : ""}` : c.freq === "monthly" ? `Every month${span ? `, ${span}` : ""}` : `In ${span}`;

  return (
    <Sheet title={c.title} onClose={onClose} action={<button type="button" className="btn-quiet" onClick={() => onEdit(c)}>Edit</button>}>
      <div className="chore-sheet">
        <p className="soft">{rooms.get(c.room)?.name}. {freqLabel}{c.prn ? ", as needed" : ""}.</p>
        <p className="who-line">
          <OwnerMark owner={i.owner} size="sm" />
          <span>{i.owner === "both" ? "Both of you" : i.owner === me ? "Yours" : `${NAME[i.owner]}'s`} {c.freq === "weekly" ? "this week" : "this month"}{i.covering ? " (covering)" : ""}.</span>
        </p>

        {i.mark ? (
          <div className="done-line" style={{ borderColor: ink(i.mark.by) }}>
            <span><b style={{ color: ink(i.mark.by) }}>{i.mark.by === me ? "You" : NAME[i.mark.by]}</b> finished it {when(i.mark.at, now)}.</span>
            <div className="form-actions">
              {i.mark.by !== me && (thanked
                ? <span className="soft">You said thanks</span>
                : <button type="button" className="btn-quiet" onClick={() => act.kudos({ type: "chore", id: c.id, title: c.title, period: i.period }, i.mark!.by)}>Say thanks</button>)}
              <button type="button" className="btn-quiet" onClick={() => act.setDone(i, false)}>Not done after all</button>
            </div>
          </div>
        ) : i.skipped ? (
          <div className="done-line">
            <span>{i.plan!.skip!.by === me ? "You" : NAME[i.plan!.skip!.by]} skipped it: {i.plan!.skip!.reason}.</span>
            <div className="form-actions"><button type="button" className="btn-quiet" onClick={() => act.skip(i, null)}>Put it back on the list</button></div>
          </div>
        ) : (
          <button type="button" className="btn-primary btn-big" onClick={() => { act.setDone(i, true); onClose(); }}>Mark done</button>
        )}

        {!i.mark && !i.skipped && (
          <div className="block">
            <h4>When</h4>
            <div className="chips">
              {days.map((d) => {
                const k = dayKey(d);
                const on = i.plan?.day === k;
                return (
                  <button key={k} type="button" aria-pressed={on} className={on ? "chip chip-on" : "chip"}
                    onClick={() => act.planDay(i, on ? null : k)}>
                    {k === today ? "Today" : DAYS[d.getDay()]}
                  </button>
                );
              })}
              {i.plan?.day && <button type="button" className="chip chip-new" onClick={() => act.planDay(i, null)}>No day</button>}
            </div>
            {i.plan?.day && i.plan.dayBy && i.plan.dayBy !== me && <p className="soft small">{NAME[i.plan.dayBy]} picked the day.</p>}
          </div>
        )}

        <div className="block">
          <h4>Done means…</h4>
          {mode === "standard" ? (
            <form className="form" onSubmit={(e) => { e.preventDefault(); act.setStandard(c, std); setMode("none"); }}>
              <textarea rows={3} value={std} onChange={(e) => setStd(e.target.value)} aria-label="Done means"
                placeholder="e.g. Counters cleared and wiped, stove top degreased, sink empty." autoFocus />
              <div className="form-actions">
                <button type="button" className="btn-quiet" onClick={() => { setStd(c.standard ?? ""); setMode("none"); }}>Cancel</button>
                <button type="submit" className="btn-primary">Save</button>
              </div>
            </form>
          ) : c.standard ? (
            <>
              <p className="standard">{c.standard}</p>
              <p className="soft small">
                {c.standardBy ? `Last changed by ${NAME[c.standardBy]}${c.standardAt ? `, ${when(c.standardAt, now)}` : ""}. ` : ""}
                <button type="button" className="link-btn" onClick={() => setMode("standard")}>Edit</button>
              </p>
            </>
          ) : (
            <button type="button" className="btn-quiet" onClick={() => setMode("standard")}>Agree on what done looks like</button>
          )}
        </div>

        <div className="block">
          <h4>Size</h4>
          <Segmented small label="Size" value={choreSize(c)} onChange={(z) => act.setSize(c, z)}
            options={SIZES.map((z) => ({ value: z, label: z }))} />
          <p className="soft small">{SIZE_HINT[choreSize(c)]}</p>
        </div>

        {!i.mark && (
          <div className="block">
            <h4>Share the load</h4>
            {pending ? <RequestCard a={pending} /> : mode === "ask" ? (
              <form className="form" onSubmit={(e) => { e.preventDefault(); act.request(i, askNote, askPerm); setMode("none"); setAskNote(""); }}>
                <label>Note for {NAME[them]} (optional)
                  <input value={askNote} onChange={(e) => setAskNote(e.target.value)} placeholder="Swamped Thursday, can you grab this?" />
                </label>
                <Segmented small label="For how long" value={askPerm ? "perm" : "once"} onChange={(v) => setAskPerm(v === "perm")}
                  options={[{ value: "once", label: c.freq === "weekly" ? "Just this week" : "Just this month" }, { value: "perm", label: "From now on" }]} />
                <div className="form-actions">
                  <button type="button" className="btn-quiet" onClick={() => setMode("none")}>Cancel</button>
                  <button type="submit" className="btn-primary">Send to {NAME[them]}</button>
                </div>
              </form>
            ) : mode === "skip" ? (
              <div className="form">
                <div className="chips">
                  {SKIP_REASONS.map((r) => <button key={r} type="button" className="chip" onClick={() => { act.skip(i, r); setMode("none"); }}>{r}</button>)}
                </div>
                <form className="add-row" onSubmit={(e) => { e.preventDefault(); if (skipText.trim()) { act.skip(i, skipText.trim()); setMode("none"); } }}>
                  <input value={skipText} onChange={(e) => setSkipText(e.target.value)} placeholder="Or type a reason" aria-label="Skip reason" />
                  <button type="submit" className="btn-primary" disabled={!skipText.trim()}>Skip</button>
                </form>
                <button type="button" className="btn-quiet" onClick={() => setMode("none")}>Cancel</button>
              </div>
            ) : (
              <div className="action-list">
                {theirs ? (
                  <>
                    <button type="button" className="btn-quiet" onClick={() => act.take(i)}>I'll do it this time</button>
                    <button type="button" className="btn-quiet" onClick={() => act.nudge(i)}>Send {NAME[them]} a reminder</button>
                  </>
                ) : (
                  <button type="button" className="btn-quiet" onClick={() => setMode("ask")}>Ask {NAME[them]} to take it</button>
                )}
                {!i.skipped && <button type="button" className="btn-quiet" onClick={() => setMode("skip")}>Skip {c.freq === "weekly" ? "this week" : "this month"}</button>}
              </div>
            )}
          </div>
        )}

        <Notes refObj={{ type: "chore", id: c.id, title: c.title }} />

      </div>
    </Sheet>
  );
}

/* ================================================================ Inbox */

const SEEN_KEY = (p: Person) => `lc:seen:${p}`;

interface FeedItem { id: string; at: string; by: Person; node: React.ReactNode; a?: Activity; isRequest?: boolean }

function useFeed(): FeedItem[] {
  const { data, me, now } = useApp();
  return useMemo(() => {
    const byId = new Map(data.house.chores.map((c) => [c.id, c]));
    const items: FeedItem[] = [];
    const cutoff = now.getTime() - 21 * 864e5;
    for (const a of data.activity.items) {
      if (new Date(a.at).getTime() < cutoff && a.status !== "open") continue;
      const who = <b style={{ color: ink(a.by) }}>{a.by === me ? "You" : NAME[a.by]}</b>;
      const t = <b>{a.ref?.title}</b>;
      let node: React.ReactNode = null;
      switch (a.kind) {
        case "note": node = <>{who} left a note on {t}: <span className="quote">“{a.text}”</span></>; break;
        case "kudos": node = <>{who} said thanks for {t} 💛</>; break;
        case "nudge": node = <>{who} sent a reminder about {t}.</>; break;
        case "skip": node = <>{who} skipped {t}: {a.text}.</>; break;
        case "standard": node = <>{who} changed what done means for {t}: <span className="quote">“{a.text}”</span></>; break;
        case "took": node = <>{who} took {t} this time.</>; break;
        case "checkin": node = <>{who} finished the weekly check-in. <span className="soft">{a.text}</span></>; break;
        case "request": node = null; break;
      }
      items.push({ id: a.id, at: a.answeredAt && a.kind === "request" ? a.answeredAt : a.at, by: a.kind === "request" && a.answeredAt ? a.to! : a.by, node, a, isRequest: a.kind === "request" });
    }
    for (const [k, mark] of Object.entries(data.log.done)) {
      if (new Date(mark.at).getTime() < cutoff) continue;
      const c = byId.get(k.split("|")[1]);
      if (!c) continue;
      items.push({
        id: "done:" + k, at: mark.at, by: mark.by,
        node: <>{<b style={{ color: ink(mark.by) }}>{mark.by === me ? "You" : NAME[mark.by]}</b>} finished <b>{c.title}</b>.</>,
        a: { id: "done:" + k, at: mark.at, by: mark.by, kind: "kudos", ref: { type: "chore", id: c.id, title: c.title, period: k.split("|")[0] } },
      });
    }
    for (const p of data.projects.projects) {
      if (p.status === "done" && p.doneAt && p.doneBy && new Date(p.doneAt).getTime() >= cutoff) {
        items.push({ id: "proj:" + p.id, at: p.doneAt, by: p.doneBy, node: <>{<b style={{ color: ink(p.doneBy) }}>{p.doneBy === me ? "You" : NAME[p.doneBy]}</b>} finished the project <b>{p.task}</b>.</>,
          a: { id: "proj:" + p.id, at: p.doneAt, by: p.doneBy, kind: "kudos", ref: { type: "project", id: p.id, title: p.task } } });
      }
    }
    return items.sort((x, y) => y.at.localeCompare(x.at));
  }, [data, me, now]);
}

function useUnread() {
  const feed = useFeed();
  const { me } = useApp();
  const [seen, setSeenState] = useState(() => lsGet(SEEN_KEY(me)) ?? "");
  useEffect(() => {
    const f = () => setSeenState(lsGet(SEEN_KEY(me)) ?? "");
    window.addEventListener("lc:seen", f);
    return () => window.removeEventListener("lc:seen", f);
  }, [me]);
  return feed.filter((f) => f.by !== me && f.at > seen && !(f.isRequest && f.a?.status === "open" && f.a.to !== me));
}
function markSeen(me: Person) {
  lsSet(SEEN_KEY(me), new Date().toISOString());
  window.dispatchEvent(new Event("lc:seen"));
}
function summarizeUnread(items: FeedItem[]): string {
  const req = items.filter((i) => i.isRequest && i.a?.status === "open").length;
  const notes = items.filter((i) => i.a?.kind === "note").length;
  const done = items.filter((i) => i.id.startsWith("done:") || i.id.startsWith("proj:")).length;
  const thanks = items.filter((i) => i.a?.kind === "kudos" && !i.id.includes(":")).length;
  const parts = [
    req && `${req} ${req === 1 ? "request" : "requests"}`,
    notes && `${notes} ${notes === 1 ? "note" : "notes"}`,
    thanks && `${thanks} thank-you${thanks === 1 ? "" : "s"}`,
    done && `${done} finished`,
  ].filter(Boolean) as string[];
  const rest = items.length - req - notes - done - thanks;
  if (rest > 0) parts.push(`${rest} other ${rest === 1 ? "update" : "updates"}`);
  return parts.join(", ") + ".";
}

function InboxSheet({ onClose }: { onClose: () => void }) {
  const { me, now, act, data, openChore } = useApp();
  const feed = useFeed();
  const [seen] = useState(() => lsGet(SEEN_KEY(me)) ?? "");
  useEffect(() => () => markSeen(me), [me]);
  const openRequests = feed.filter((f) => f.isRequest && f.a?.status === "open");
  const rest = feed.filter((f) => !(f.isRequest && f.a?.status === "open"));
  const thankedKeys = new Set(data.activity.items.filter((a) => a.kind === "kudos" && a.by === me).map((a) => `${a.ref?.type}:${a.ref?.id}:${a.ref?.period ?? ""}`));

  return (
    <Sheet title="Inbox" onClose={onClose}>
      {openRequests.length > 0 && (
        <div className="block">
          <h4>Waiting on an answer</h4>
          {openRequests.map((f) => <RequestCard key={f.id} a={f.a!} />)}
        </div>
      )}
      {rest.length === 0 && openRequests.length === 0 && <p className="empty">Nothing here yet. Notes, requests and thank-yous will show up here.</p>}
      <ul className="feed">
        {rest.slice(0, 120).map((f) => {
          const unread = f.by !== me && f.at > seen;
          const a = f.a;
          const canThank = a && f.by !== me && (f.id.startsWith("done:") || f.id.startsWith("proj:"));
          const thanked = canThank && thankedKeys.has(`${a!.ref?.type}:${a!.ref?.id}:${a!.ref?.period ?? ""}`);
          return (
            <li key={f.id} className={unread ? "feed-item feed-unread" : "feed-item"} style={{ borderColor: ink(f.by) }}>
              <div className="feed-text">
                {f.isRequest ? (
                  <>{<b style={{ color: ink(f.by) }}>{f.by === me ? "You" : NAME[f.by]}</b>} {a!.status === "accepted" ? "took" : "couldn't take"} <b>{a!.ref?.title}</b>{a!.status === "accepted" && a!.permanent ? " from now on" : ""}.</>
                ) : f.node}
              </div>
              <div className="feed-foot">
                <span className="soft small">{when(f.at, now)}</span>
                {a?.ref?.type === "chore" && data.house.chores.some((c) => c.id === a.ref!.id) && (
                  <button type="button" className="link-btn" onClick={() => { const c = data.house.chores.find((x) => x.id === a.ref!.id)!; onClose(); openChore(c); }}>Open</button>
                )}
                {canThank && (thanked ? <span className="soft small">Thanked</span>
                  : <button type="button" className="link-btn" onClick={() => act.kudos(a!.ref!, f.by)}>Say thanks</button>)}
              </div>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/* ============================================================= Check-in */

function checkinDue(data: Data, now: Date) {
  const dow = now.getDay();
  if (![0, 1, 2].includes(dow)) return false;
  const planWeek = weekKey(dow === 0 ? addDays(now, 1) : now);
  if (data.settings.lastCheckin?.week === planWeek) return false;
  // Don't ask on day one: only once there's a week of history to review.
  const reviewWeek = weekKey(dow === 0 ? now : addDays(now, -7));
  return !!data.settings.lastCheckin || Object.keys(data.log.done).some((k) => k.startsWith(reviewWeek + "|"));
}

function CheckinSheet({ onClose }: { onClose: () => void }) {
  const { data, me, now, inst, act } = useApp();
  const [step, setStep] = useState(0);
  const [pq, setPq] = useState("");
  const [pfit, setPfit] = useState<Fit>("any");
  const [showAll, setShowAll] = useState(false);
  const sunday = now.getDay() === 0;
  const reviewDate = sunday ? now : addDays(now, -7);
  const planDate = sunday ? addDays(now, 1) : now;
  const planWeek = weekKey(planDate);
  const review = data.house.chores.filter((c) => c.freq === "weekly" && !c.prn).map((c) => inst(c, reviewDate));
  const per = (["grant", "cass"] as Person[]).map((p) => {
    const mine = review.filter((i) => isFor(i.owner, p) && !i.skipped);
    const slipped = mine.filter((i) => !i.mark);
    return { p, done: mine.length - slipped.length, total: mine.length, slipped };
  });
  const doneByThem = review.filter((i) => i.mark?.by === other(me)).length;
  const openReqs = data.activity.items.filter((a) => a.kind === "request" && a.status === "open");
  const openProjects = data.projects.projects.filter((p) => p.status !== "done")
    .sort((a, b) => a.priority - b.priority || SIZE_WEIGHT[projectSize(a)] - SIZE_WEIGHT[projectSize(b)]);
  const load = (["grant", "cass"] as Person[]).map((p) => {
    const chores = data.house.chores.filter((c) => c.freq === "weekly" && !c.prn && isDue(c, planDate))
      .map((c) => inst(c, planDate)).filter((i) => isFor(i.owner, p));
    const chorePts = chores.reduce((n, i) => n + SIZE_WEIGHT[choreSize(i.c)], 0);
    const proj = openProjects.filter((x) => x.focus === planWeek && isFor(x.lead, p));
    const projPts = proj.reduce((n, x) => n + SIZE_WEIGHT[projectSize(x)], 0);
    return { p, chorePts, proj, projPts, total: chorePts + projPts };
  });
  const [lo, hi] = [...load].sort((a, b) => a.total - b.total);
  const lopsided = lo.total > 0 && hi.total >= lo.total * 1.5;
  const picked = openProjects.filter((p) => p.focus === planWeek);
  const steps = ["How last week went", "Open requests", "Who does what", "Projects for this week"];
  const rotating = data.house.rooms.filter((r) => !r.pinned && r.zone !== "shared");

  const finish = () => {
    const s = per.map((x) => `${NAME[x.p]} ${x.done} of ${x.total}`).join(", ");
    act.checkin(planWeek, `Last week: ${s}.${picked.length ? ` Projects: ${picked.map((p) => p.task).join("; ")}.` : ""}`);
    onClose();
  };

  return (
    <Sheet title="Weekly check-in" onClose={onClose} wide>
      <ol className="stepper" aria-label="Steps">
        {steps.map((s, k) => <li key={s} className={k === step ? "step-on" : k < step ? "step-done" : ""}>{s}</li>)}
      </ol>
      <div className="checkin">
        {step === 0 && (
          <>
            <h3>Week of {fmtShort(mondayOf(reviewDate))}</h3>
            <Bars rows={per} />
            <Balance at={reviewDate} label={`Effort so far in ${MONTHS_LONG[reviewDate.getMonth()]}`} />
            {per.map(({ p, slipped }) => slipped.length > 0 && (
              <div key={p} className="block">
                <h4>{p === me ? "You" : NAME[p]} didn't get to</h4>
                <p className="soft">{slipped.map((i) => i.c.title).join(", ")}.</p>
              </div>
            ))}
            {per.every((x) => x.slipped.length === 0) && <p>Everything got done. 🎉</p>}
            {doneByThem > 0 && (
              <button type="button" className="btn-quiet" onClick={() => act.kudos({ type: "chore", id: "week", title: `${doneByThem} chores last week`, period: weekKey(reviewDate) }, other(me))}>
                Thank {NAME[other(me)]} for {doneByThem} chores
              </button>
            )}
          </>
        )}
        {step === 1 && (
          <>
            {openReqs.length === 0 ? <p>No open requests. All square.</p> : openReqs.map((a) => <RequestCard key={a.id} a={a} />)}
          </>
        )}
        {step === 2 && (
          <>
            <p>{data.settings.mode === "rotate" ? "You're taking turns. This week:" : "You're keeping rooms:"}</p>
            {(["grant", "cass"] as Person[]).map((p) => (
              <p key={p} className="side"><OwnerMark owner={p} size="sm" />
                <span>{rotating.filter((r) => roomOwner(r, data.settings, "weekly", planDate) === p).map((r) => r.name).join(", ") || "Nothing"}</span></p>
            ))}
            <div className="form-actions">
              {data.settings.mode === "rotate" ? (
                <>
                  <button type="button" className="btn-quiet" onClick={() => act.settings((d) => ({ ...d, rotation: { ...d.rotation, zoneAStarts: other(d.rotation.zoneAStarts) } }), "swapped sides")}>Swap sides</button>
                  <button type="button" className="btn-quiet" onClick={() => act.lockSplit(planDate)}>Keep this split</button>
                </>
              ) : (
                <button type="button" className="btn-quiet" onClick={() => act.settings((d) => ({ ...d, mode: "rotate" }), "switched to taking turns")}>Go back to taking turns</button>
              )}
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <p className="soft">Pick a few. They'll show on both Today screens this week.</p>
            <div className="load">
              {load.map((x) => (
                <div key={x.p} className="load-row">
                  <span className="progress-name" style={{ color: ink(x.p) }}>{NAME[x.p]}</span>
                  <span className="load-bar"><span style={{ width: `${Math.min(100, (x.total / Math.max(hi.total, 1)) * 100)}%`, background: ink(x.p) }} /></span>
                  <span className="small soft">Chores {x.chorePts}{x.proj.length ? `, projects ${sizeTally(x.proj.map(projectSize))}` : ""}. Total {x.total}</span>
                </div>
              ))}
              {lopsided && <p className="small late">{NAME[hi.p]}'s week is a lot heavier. Swap a project, or hand off a chore.</p>}
              <p className="soft small">Points: S 1, M 2, L 4, XL 8. Projects led together count for both of you.</p>
            </div>
            <input className="search" type="search" placeholder="Search projects" value={pq} onChange={(e) => setPq(e.target.value)} aria-label="Search projects to pick" />
            <FitPicker value={pfit} onChange={setPfit} />
            {(() => {
              const matches = openProjects.filter((p) => p.focus === planWeek || ((!pq || `${p.task} ${p.category}`.toLowerCase().includes(pq.toLowerCase())) && fits(projectSize(p), pfit)));
              const shown = showAll || pq ? matches : matches.slice(0, 25);
              return (<>
            <ul className="pick-list">
              {shown.map((p) => {
                const on = p.focus === planWeek;
                return (
                  <li key={p.id}>
                    <button type="button" aria-pressed={on} className={on ? "pick pick-on" : "pick"} onClick={() => act.setFocus(p, on ? null : planWeek)}>
                      <Check on={on} color={ink(p.lead === "both" ? me : p.lead)} />
                      <span className="pick-text"><span>{p.task}</span><span className="soft small"><SizeTag size={projectSize(p)} /> {p.category}, {PRIORITY[p.priority].toLowerCase()} priority</span></span>
                      <OwnerMark owner={p.lead} size="sm" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {shown.length < matches.length && (
              <button type="button" className="btn-quiet" onClick={() => setShowAll(true)}>Show all {matches.length} open projects</button>
            )}
              </>);
            })()}
          </>
        )}
      </div>
      <div className="form-actions sheet-foot">
        {step > 0 && <button type="button" className="btn-quiet" onClick={() => setStep(step - 1)}>Back</button>}
        {step < steps.length - 1
          ? <button type="button" className="btn-primary" onClick={() => setStep(step + 1)}>Next</button>
          : <button type="button" className="btn-primary" onClick={finish}>Finish check-in</button>}
      </div>
    </Sheet>
  );
}

/* ============================================================= Projects */

const PRIORITY = ["", "Highest", "High", "Medium", "Low", "Lowest"];
const STATUS: Record<Status, string> = { todo: "To do", doing: "In progress", done: "Done" };

function ProjectsView() {
  const { data, me, now, act } = useApp();
  const [lead, setLead] = useState<"all" | Owner>("all");
  const [view, setView] = useState<"week" | "open" | "done">("open");
  const [sort, setSort] = useState<"priority" | "easy" | "category">("priority");
  const [editing, setEditing] = useState<Project | null>(null);
  const [q, setQ] = useState("");
  const [fit, setFit] = useFit("lc:pfit");
  const wk = weekKey(now);
  const list = data.projects.projects
    .filter((p) => fits(projectSize(p), fit))
    .filter((p) => view === "done" ? p.status === "done" : view === "week" ? p.focus === wk && p.status !== "done" : p.status !== "done")
    .filter((p) => lead === "all" || p.lead === lead)
    .filter((p) => !q || `${p.task} ${p.category} ${p.notes ?? ""}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      if (view !== "done" && a.status !== b.status) return a.status === "doing" ? -1 : 1;
      const sz = SIZE_WEIGHT[projectSize(a)] - SIZE_WEIGHT[projectSize(b)];
      if (sort === "easy") return sz || a.priority - b.priority;
      if (sort === "category") return a.category.localeCompare(b.category) || a.priority - b.priority;
      return a.priority - b.priority || sz;
    });
  const openCount = data.projects.projects.filter((p) => p.status !== "done" && isFor(p.lead, me)).length;
  const focusCount = data.projects.projects.filter((p) => p.focus === wk && p.status !== "done").length;
  return (
    <section>
      <header className="board-head">
        <h1 className="marker">House projects</h1>
        <p className="soft">{openCount} open with your name on them.</p>
        <Segmented label="Show" value={view} onChange={setView} options={[
          { value: "week", label: `This week${focusCount ? ` (${focusCount})` : ""}` }, { value: "open", label: "Open" }, { value: "done", label: "Done" },
        ]} />
        <Segmented label="Lead" value={lead} onChange={setLead} options={[
          { value: "all", label: "All" }, { value: "grant", label: "Grant" }, { value: "cass", label: "Cass" }, { value: "both", label: "Together" },
        ]} />
        <FitPicker value={fit} onChange={setFit} />
        <div className="toolbar">
          <input className="search" type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
          <label className="select"><span className="sr">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="priority">Priority first</option><option value="easy">Smallest first</option><option value="category">By room</option>
            </select>
          </label>
        </div>
      </header>
      <button type="button" className="btn-add" onClick={() => setEditing({ id: uid("p"), task: "", category: "General", priority: 3, effort: 4, size: "M", lead: me, status: "todo" })}>Add a project</button>
      {list.length === 0 && <p className="empty">{view === "done" ? "Nothing finished yet." : view === "week" ? "No projects picked for this week. Pick some in the weekly check-in, or open a project and tap Pick for this week." : "No open projects match."}</p>}
      <ul className="projects">
        {list.map((p) => {
          const notes = notesFor(data, "project", p.id).length;
          return (
            <li key={p.id} className={`project prio-${p.priority}`}>
              <button type="button" className="project-main" onClick={() => setEditing(p)}>
                <span className="project-title">{p.task}</span>
                <span className="project-meta">
                  <SizeTag size={projectSize(p)} /><span>{p.category}</span><span>{PRIORITY[p.priority]} priority</span>
                  {p.cost && <span>{p.cost}</span>}
                  {p.status === "doing" && <span className="tag-doing">In progress</span>}
                  {p.focus === wk && p.status !== "done" && <span className="tag-doing">This week</span>}
                  {notes > 0 && <span>{notes} {notes === 1 ? "note" : "notes"}</span>}
                  {p.status === "done" && p.doneBy && <span style={{ color: ink(p.doneBy) }}>{NAME[p.doneBy]}, {when(p.doneAt!, now)}</span>}
                </span>
              </button>
              <div className="project-side">
                <OwnerMark owner={p.lead} size="sm" />
                {p.status !== "done"
                  ? <button type="button" className="btn-small" onClick={() => act.projectStatus(p, "done")}>Done</button>
                  : <button type="button" className="btn-small" onClick={() => act.projectStatus(p, "todo")}>Reopen</button>}
              </div>
            </li>
          );
        })}
      </ul>
      {editing && <ProjectSheet p={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ProjectSheet({ p, onClose }: { p: Project; onClose: () => void }) {
  const { data, act, now } = useApp();
  const isNew = !data.projects.projects.some((x) => x.id === p.id);
  const [f, setF] = useState<Project>(p);
  const set = <K extends keyof Project>(k: K, v: Project[K]) => setF((x) => ({ ...x, [k]: v }));
  const categories = [...new Set(data.projects.projects.map((x) => x.category))].sort();
  const wk = weekKey(now);
  const live = data.projects.projects.find((x) => x.id === p.id);
  return (
    <Sheet title={isNew ? "New project" : "Edit project"} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (f.task.trim()) { act.saveProject({ ...f, task: f.task.trim(), focus: live?.focus ?? f.focus }); onClose(); } }}>
        <label>What needs doing<input required value={f.task} onChange={(e) => set("task", e.target.value)} /></label>
        <label>Room or area<input list="cats" value={f.category} onChange={(e) => set("category", e.target.value)} />
          <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></label>
        <div className="form-row">
          <label>Priority<select value={f.priority} onChange={(e) => set("priority", Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{PRIORITY[n]}</option>)}</select></label>
          <label>Size<select value={projectSize(f)} onChange={(e) => { const z = e.target.value as Size; setF((x) => ({ ...x, size: z, effort: effortFromSize[z] })); }}>
            {SIZES.map((z) => <option key={z} value={z}>{z}: {SIZE_HINT[z]}</option>)}</select></label>
        </div>
        <div className="form-row">
          <label>Lead<select value={f.lead} onChange={(e) => set("lead", e.target.value as Owner)}><option value="grant">Grant</option><option value="cass">Cass</option><option value="both">Together</option></select></label>
          <label>Status<select value={f.status} onChange={(e) => set("status", e.target.value as Status)}>{(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}</select></label>
        </div>
        <label>Estimated cost<input value={f.cost ?? ""} placeholder="$40–80" onChange={(e) => set("cost", e.target.value || undefined)} /></label>
        <label>Details<textarea rows={3} value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value || undefined)} /></label>
        <label>Links<input value={f.links ?? ""} placeholder="Product page, quote, how-to" onChange={(e) => set("links", e.target.value || undefined)} /></label>
        {f.links && /^https?:\/\//.test(f.links) && <a href={f.links} target="_blank" rel="noreferrer" className="small">Open link</a>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn-danger" onClick={() => { act.removeProject(p); onClose(); }}>Delete</button>}
          {!isNew && live && live.status !== "done" && (
            <button type="button" className="btn-quiet" onClick={() => act.setFocus(live, live.focus === wk ? null : wk)}>
              {live.focus === wk ? "Drop from this week" : "Pick for this week"}
            </button>
          )}
          <button type="submit" className="btn-primary">{isNew ? "Add project" : "Save"}</button>
        </div>
      </form>
      {!isNew && <Notes refObj={{ type: "project", id: p.id, title: p.task }} />}
    </Sheet>
  );
}

/* ================================================================ Lists */

function ListsView() {
  const { data, me, now, mutate, toast } = useApp();
  const [active, setActive] = useState(() => lsGet("lc:list") || data.lists.lists[0]?.id || "");
  const [text, setText] = useState("");
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const list = data.lists.lists.find((l) => l.id === active) ?? data.lists.lists[0];
  useEffect(() => { if (list) lsSet("lc:list", list.id); }, [list]);
  const N = NAME[me];
  const editList = (id: string, fn: (l: List) => void, msg: string) =>
    mutate("lists", (d) => { const l = d.lists.find((x) => x.id === id); if (l) fn(l); return d; }, msg);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !list) return;
    const item: ListItem = { id: uid("i"), text: t, done: false, by: me, at: nowIso() };
    editList(list.id, (l) => { if (!l.items.some((x) => x.id === item.id)) l.items.push(item); }, `${N} added "${t}" to ${list.name}`);
    setText("");
  };
  const toggle = (i: ListItem) => {
    const prev = { done: i.done, by: i.by, at: i.at };
    editList(list!.id, (l) => { const x = l.items.find((y) => y.id === i.id); if (x) { x.done = !prev.done; x.by = me; x.at = nowIso(); } }, `${N} ${i.done ? "unchecked" : "checked"} "${i.text}"`);
    toast(i.done ? `Unchecked ${i.text}` : `Checked ${i.text}`, () =>
      editList(list!.id, (l) => { const x = l.items.find((y) => y.id === i.id); if (x) Object.assign(x, prev); }, `${N} undid "${i.text}"`));
  };
  const saveName = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (naming === "new") {
      const id = uid("l");
      mutate("lists", (d) => { if (!d.lists.some((x) => x.id === id)) d.lists.push({ id, name: n, items: [] }); return d; }, `${N} made a list: ${n}`);
      setActive(id);
    } else if (list) editList(list.id, (l) => { l.name = n; }, `${N} renamed ${list.name} to ${n}`);
    setNaming(null);
  };
  const item = list?.items.find((x) => x.id === openItem);

  return (
    <section>
      <header className="board-head">
        <h1 className="marker">Lists</h1>
        <p className="soft">Restock, Lowe's runs, anything you want to share.</p>
        <div className="chips">
          {data.lists.lists.map((l) => (
            <button key={l.id} type="button" aria-pressed={l.id === list?.id} className={l.id === list?.id ? "chip chip-on" : "chip"} onClick={() => setActive(l.id)}>
              {l.name}<span className="chip-n">{l.items.filter((i) => !i.done).length}</span>
            </button>
          ))}
          <button type="button" className="chip chip-new" onClick={() => { setName(""); setNaming("new"); }}>New list</button>
        </div>
      </header>
      {naming && (
        <form className="add-row" onSubmit={saveName}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={naming === "new" ? "Name the new list" : "New name"} aria-label="List name" />
          <button type="button" className="btn-quiet" onClick={() => setNaming(null)}>Cancel</button>
          <button type="submit" className="btn-primary">Save</button>
        </form>
      )}
      {list && (
        <>
          <form className="add-row" onSubmit={add}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add to ${list.name}`} aria-label={`Add to ${list.name}`} />
            <button type="submit" className="btn-primary" disabled={!text.trim()}>Add</button>
          </form>
          {list.items.length === 0 && <p className="empty">This list is empty. Add the first thing above.</p>}
          <ul className="tasks tasks-card">
            {[...list.items].sort((a, b) => Number(a.done) - Number(b.done)).map((i) => {
              const notes = notesFor(data, "item", i.id).length;
              return (
                <li key={i.id} className={`task${i.done ? " task-done" : ""}`}>
                  <button type="button" className="task-check" aria-pressed={i.done} aria-label={i.done ? `Uncheck ${i.text}` : `Check ${i.text}`} onClick={() => toggle(i)}>
                    <Check on={i.done} color={i.done && i.by ? ink(i.by) : "currentColor"} />
                  </button>
                  <button type="button" className="task-open" onClick={() => setOpenItem(i.id)}>
                    <span className="task-title">{i.text}</span>
                    <span className="task-meta">
                      {i.by && i.at && <span style={{ color: ink(i.by) }}>{i.done ? "Got it: " : "Added by "}{NAME[i.by]}, {when(i.at, now)}</span>}
                      {notes > 0 && <span>{notes} {notes === 1 ? "note" : "notes"}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="list-actions">
            {list.items.some((i) => i.done) && (
              <button type="button" className="btn-quiet" onClick={() => {
                const removed = list.items.filter((i) => i.done);
                editList(list.id, (l) => { l.items = l.items.filter((i) => !i.done); }, `${N} cleared checked items from ${list.name}`);
                toast(`Cleared ${removed.length} checked`, () => editList(list.id, (l) => { for (const r of removed) if (!l.items.some((x) => x.id === r.id)) l.items.push(r); }, `${N} restored checked items`));
              }}>Clear checked items</button>
            )}
            <button type="button" className="btn-quiet" onClick={() => { setName(list.name); setNaming("rename"); }}>Rename list</button>
            <button type="button" className="btn-quiet btn-quiet-danger" onClick={() => {
              const snapshot = clone(list);
              mutate("lists", (d) => ({ ...d, lists: d.lists.filter((l) => l.id !== list.id) }), `${N} deleted list ${list.name}`);
              setActive(data.lists.lists.find((l) => l.id !== list.id)?.id ?? "");
              toast(`Deleted ${list.name}`, () => mutate("lists", (d) => { if (!d.lists.some((l) => l.id === snapshot.id)) d.lists.push(snapshot); return d; }, `${N} restored list ${snapshot.name}`));
            }}>Delete list</button>
          </div>
        </>
      )}
      {item && list && (
        <ItemSheet item={item} list={list} onClose={() => setOpenItem(null)}
          onSave={(t) => editList(list.id, (l) => { const x = l.items.find((y) => y.id === item.id); if (x) x.text = t; }, `${N} renamed "${item.text}" to "${t}"`)}
          onDelete={() => {
            const snapshot = clone(item);
            editList(list.id, (l) => { l.items = l.items.filter((x) => x.id !== item.id); }, `${N} removed "${item.text}"`);
            setOpenItem(null);
            toast(`Removed ${item.text}`, () => editList(list.id, (l) => { if (!l.items.some((x) => x.id === snapshot.id)) l.items.push(snapshot); }, `${N} restored "${snapshot.text}"`));
          }} />
      )}
    </section>
  );
}

function ItemSheet({ item, list, onClose, onSave, onDelete }: { item: ListItem; list: List; onClose: () => void; onSave: (t: string) => void; onDelete: () => void }) {
  const [t, setT] = useState(item.text);
  return (
    <Sheet title={item.text} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (t.trim()) { onSave(t.trim()); onClose(); } }}>
        <label>Item<input value={t} onChange={(e) => setT(e.target.value)} /></label>
        <div className="form-actions">
          <button type="button" className="btn-danger" onClick={onDelete}>Remove</button>
          <button type="submit" className="btn-primary">Save</button>
        </div>
      </form>
      <Notes refObj={{ type: "item", id: item.id, title: item.text, list: list.id }} />
    </Sheet>
  );
}

/* ============================================================== Settings */

function SettingsSheet({ config, onConfig, onEdit, onClose, zoom, setZoom }: {
  config: Config; onConfig: (c: Config | null) => void; onEdit: () => void; onClose: () => void;
  zoom: string; setZoom: (z: string) => void;
}) {
  const { data, me, now, act } = useApp();
  const s = data.settings;
  const rotating = data.house.rooms.filter((r) => !r.pinned && r.zone !== "shared");
  const myInk = s.colors?.[me] ?? DEFAULT_INK[me];
  const theirInk = s.colors?.[other(me)] ?? DEFAULT_INK[other(me)];
  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="settings">
        <section>
          <h3>Who's using this phone</h3>
          <Segmented label="You are" value={me} onChange={(p) => onConfig({ ...config, me: p })}
            options={[{ value: "grant", label: "Grant" }, { value: "cass", label: "Cass" }]} />
        </section>
        <section>
          <h3>Your ink color</h3>
          <p className="soft">Your check marks, notes and initials use this color on both phones.</p>
          <div className="swatches" role="group" aria-label="Ink color">
            {INKS.map((c) => (
              <button key={c.id} type="button" aria-pressed={myInk === c.id} aria-label={c.name} title={c.id === theirInk ? `${c.name} (${NAME[other(me)]}'s)` : c.name}
                disabled={c.id === theirInk} className={myInk === c.id ? "swatch swatch-on" : "swatch"}
                style={{ background: c.light }} onClick={() => act.settings((d) => ({ ...d, colors: { ...d.colors, [me]: c.id } }), `picked ${c.name.toLowerCase()} ink`)} />
            ))}
          </div>
        </section>
        <section>
          <h3>Text size</h3>
          <Segmented label="Text size" value={zoom} onChange={setZoom}
            options={[{ value: "0.92", label: "Smaller" }, { value: "1", label: "Standard" }, { value: "1.12", label: "Larger" }]} />
        </section>
        <section>
          <h3>Who does which rooms</h3>
          <Segmented label="Room ownership" value={s.mode}
            onChange={(m) => act.settings((d) => ({ ...d, mode: m }), `switched to ${m === "rotate" ? "taking turns" : "keeping rooms"}`)}
            options={[{ value: "rotate", label: "Take turns" }, { value: "fixed", label: "Keep rooms" }]} />
          {s.mode === "rotate" ? (
            <>
              <p className="soft">Two sides of the house swap every Monday. Monthly and seasonal chores swap on the 1st. Offices stay put; the bedroom is shared.</p>
              {(["grant", "cass"] as Person[]).map((p) => (
                <p key={p} className="side"><OwnerMark owner={p} size="sm" /><span>This week: {rotating.filter((r) => roomOwner(r, s, "weekly", now) === p).map((r) => r.name).join(", ") || "nothing"}</span></p>
              ))}
              <div className="form-actions">
                <button type="button" className="btn-quiet" onClick={() => act.settings((d) => ({ ...d, rotation: { ...d.rotation, zoneAStarts: other(d.rotation.zoneAStarts) } }), "swapped sides")}>Swap sides</button>
                <button type="button" className="btn-primary" onClick={() => act.lockSplit(now)}>Keep this split</button>
              </div>
            </>
          ) : (
            <>
              <p className="soft">Everyone keeps the rooms below until you switch back to taking turns.</p>
              <ul className="owners">
                {data.house.rooms.map((r) => (
                  <li key={r.id}><span>{r.name}</span>
                    <select aria-label={`Owner of ${r.name}`} value={r.fixedOwner} onChange={(e) => act.setFixed(r, e.target.value as Owner)}>
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
          <p className="soft">{config.mode === "local" ? "Not syncing. Changes stay on this phone until you connect GitHub." : <>Saving to <b>{config.repo}</b>. Updates from the other phone show up within 30 seconds, or right away when you reopen the app.</>}</p>
          <div className="form-actions">
            <button type="button" className="btn-quiet" onClick={() => onConfig(null)}>{config.mode === "local" ? "Connect GitHub" : "Change token or repo"}</button>
          </div>
        </section>
      </div>
    </Sheet>
  );
}

/* ================================================================ Editor */

function Editor({ onClose, startChore }: { onClose: () => void; startChore?: Chore }) {
  const { data, me, act } = useApp();
  const [roomId, setRoomId] = useState(startChore?.room ?? data.house.rooms[0]?.id ?? "");
  const [editing, setEditing] = useState<Chore | null>(startChore ?? null);
  const [roomEdit, setRoomEdit] = useState<Room | null>(null);
  const room = data.house.rooms.find((r) => r.id === roomId);
  const chores = data.house.chores.filter((c) => c.room === roomId);

  if (editing) return <ChoreForm c={editing} rooms={data.house.rooms} isNew={!data.house.chores.some((x) => x.id === editing.id)}
    onSave={(c) => { act.saveChore(c); setEditing(null); if (startChore) onClose(); }}
    onClose={() => { setEditing(null); if (startChore) onClose(); }}
    onDelete={(c) => { act.removeChore(c); setEditing(null); if (startChore) onClose(); }} />;
  if (roomEdit) return <RoomForm r={roomEdit} isNew={!data.house.rooms.some((x) => x.id === roomEdit.id)}
    areas={[...new Set(data.house.rooms.map((r) => r.area))]} hasChores={data.house.chores.some((c) => c.room === roomEdit.id)}
    onSave={(r) => { act.saveRoom(r); setRoomId(r.id); setRoomEdit(null); }} onClose={() => setRoomEdit(null)}
    onDelete={(r) => { act.removeRoom(r); setRoomId(data.house.rooms.find((x) => x.id !== r.id)?.id ?? ""); setRoomEdit(null); }} />;

  return (
    <Sheet title="Rooms and chores" onClose={onClose}>
      <div className="form">
        <label>Room
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>{data.house.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
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
                  <li key={c.id}><button type="button" onClick={() => setEditing(c)}>
                    <span>{c.title}</span>
                    <span className="soft">{[c.prn && "as needed", c.months?.length && monthRange(c.months), c.owner && `always ${NAME[c.owner]}`, `size ${choreSize(c)}`].filter(Boolean).join("; ")}</span>
                  </button></li>
                ))}
              </ul>
            </div>
          );
        })}
        <button type="button" className="btn-add" onClick={() => setEditing({ id: uid("c"), title: "", room: roomId, freq: "weekly" })}>Add a chore to {room?.name ?? "this room"}</button>
      </div>
    </Sheet>
  );
}

function ChoreForm({ c, rooms, isNew, onSave, onDelete, onClose }: {
  c: Chore; rooms: Room[]; isNew: boolean; onSave: (c: Chore) => void; onDelete: (c: Chore) => void; onClose: () => void;
}) {
  const [f, setF] = useState<Chore>(c);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState(() => c.freq !== "seasonal" && !!c.months?.length);
  const set = <K extends keyof Chore>(k: K, v: Chore[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleMonth = (m: number) => { const ms = new Set(f.months ?? []); ms.has(m) ? ms.delete(m) : ms.add(m); set("months", [...ms].sort((a, b) => a - b)); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    const out: Chore = { ...f, title: f.title.trim() };
    if (out.freq !== "seasonal" && !limit) delete out.months;
    else if (!out.months?.length) { setErr("Pick at least one month."); return; }
    if (!out.prn) delete out.prn;
    if (!out.owner) delete out.owner;
    if (!out.note) delete out.note;
    onSave(out);
  };
  return (
    <Sheet title={isNew ? "New chore" : "Edit chore"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Chore<input required value={f.title} onChange={(e) => set("title", e.target.value)} /></label>
        <label>Room<select value={f.room} onChange={(e) => set("room", e.target.value)}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>How often
          <select value={f.freq} onChange={(e) => set("freq", e.target.value as Freq)}>
            <option value="weekly">Every week</option><option value="monthly">Every month</option><option value="seasonal">Certain months</option>
          </select>
        </label>
        {f.freq !== "seasonal" && (
          <label className="inline"><input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} />Only in certain months (like mowing)</label>
        )}
        {(f.freq === "seasonal" || limit) && (
          <fieldset className="months"><legend>Months</legend>
            {MONTHS.map((m, i) => <button key={m} type="button" aria-pressed={!!f.months?.includes(i + 1)} className={f.months?.includes(i + 1) ? "chip chip-on" : "chip"} onClick={() => toggleMonth(i + 1)}>{m}</button>)}
          </fieldset>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <label className="inline"><input type="checkbox" checked={!!f.prn} onChange={(e) => set("prn", e.target.checked)} />Only as needed (doesn't count toward progress)</label>
        <label>Who does it
          <select value={f.owner ?? ""} onChange={(e) => set("owner", (e.target.value || undefined) as Owner | undefined)}>
            <option value="">Whoever has the room</option><option value="grant">Always Grant</option><option value="cass">Always Cass</option><option value="both">Together</option>
          </select>
        </label>
        <label>Size
          <select value={choreSize(f)} onChange={(e) => setF((x) => { const y = { ...x, size: e.target.value as Size }; delete y.effort; return y; })}>
            {SIZES.map((z) => <option key={z} value={z}>{z}: {SIZE_HINT[z]}</option>)}
          </select>
        </label>
        <label>Tip<input value={f.note ?? ""} placeholder="Products, where the supplies are" onChange={(e) => set("note", e.target.value)} /></label>
        <div className="form-actions">
          {!isNew && <button type="button" className="btn-danger" onClick={() => onDelete(c)}>Remove</button>}
          <button type="submit" className="btn-primary">{isNew ? "Add chore" : "Save chore"}</button>
        </div>
      </form>
    </Sheet>
  );
}

function RoomForm({ r, isNew, areas, hasChores, onSave, onDelete, onClose }: {
  r: Room; isNew: boolean; areas: string[]; hasChores: boolean; onSave: (r: Room) => void; onDelete: (r: Room) => void; onClose: () => void;
}) {
  const [f, setF] = useState<Room>(r);
  const set = <K extends keyof Room>(k: K, v: Room[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Sheet title={isNew ? "New room" : "Edit room"} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) onSave({ ...f, name: f.name.trim(), pinned: f.pinned || undefined }); }}>
        <label>Name<input required value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label>Part of the house<input list="areas" value={f.area} onChange={(e) => set("area", e.target.value)} /><datalist id="areas">{areas.map((a) => <option key={a} value={a} />)}</datalist></label>
        <label>When taking turns
          <select value={f.zone} onChange={(e) => set("zone", e.target.value as Zone)}>
            <option value="A">Side A</option><option value="B">Side B</option><option value="shared">Shared, always both of you</option>
          </select>
        </label>
        <label>When keeping rooms, it belongs to
          <select value={f.fixedOwner} onChange={(e) => set("fixedOwner", e.target.value as Owner)}><option value="grant">Grant</option><option value="cass">Cass</option><option value="both">Together</option></select>
        </label>
        <label className="inline"><input type="checkbox" checked={!!f.pinned} onChange={(e) => set("pinned", e.target.checked)} />Never rotate this room (like an office)</label>
        <div className="form-actions">
          {!isNew && <button type="button" className="btn-danger" disabled={hasChores} onClick={() => onDelete(r)}>Remove room</button>}
          <button type="submit" className="btn-primary">{isNew ? "Add room" : "Save room"}</button>
        </div>
        {!isNew && hasChores && <p className="soft">To remove this room, move or remove its chores first.</p>}
      </form>
    </Sheet>
  );
}

/* ================================================================= Setup */

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
    } finally { setBusy(false); }
  };
  return (
    <main className="setup">
      <h1 className="marker">Lovetta chores</h1>
      <p>Chores, house projects and shared lists for Grant and Cass.</p>
      <form className="form" onSubmit={connect}>
        <fieldset className="who"><legend>Who are you?</legend>
          <Segmented label="You are" value={f.me ?? ("" as Person)} onChange={(p) => setF({ ...f, me: p })}
            options={[{ value: "grant", label: "Grant" }, { value: "cass", label: "Cass" }]} />
        </fieldset>
        <label>Household key
          <input type="password" autoComplete="off" value={f.token} placeholder="github_pat_…" onChange={(e) => setF({ ...f, token: e.target.value })} required />
        </label>
        <details className="help">
          <summary>Where do I get the key?</summary>
          <p><b>Cass:</b> ask Grant to send it to you, then paste it here. You both use the same key.</p>
          <p><b>Grant:</b> make one on <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub's new token page</a>, choose only the <b>lovetta-chores-data</b> repo, and give it <b>Contents: read and write</b>.</p>
          <p>The key stays on this phone.</p>
        </details>
        <details className="help"><summary>Advanced</summary>
          <label>Data repo<input value={f.repo} onChange={(e) => setF({ ...f, repo: e.target.value })} /></label>
        </details>
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" className="btn-primary btn-big" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
        <button type="button" className="btn-quiet" onClick={() => { if (!f.me) { setErr("Pick who you are first."); return; } onDone({ ...f, mode: "local" }); }}>Try it without syncing</button>
      </form>
    </main>
  );
}

/* =================================================================== App */

type Tab = "today" | "week" | "chores" | "projects" | "lists";
const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" }, { id: "week", label: "Week" }, { id: "chores", label: "Chores" },
  { id: "projects", label: "Projects" }, { id: "lists", label: "Lists" },
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
  const [tab, setTab] = useState<Tab>(() => { const t = lsGet("lc:tab") as Tab; return TABS.some((x) => x.id === t) ? t : "today"; });
  const [panel, setPanel] = useState<null | { kind: "settings" } | { kind: "editor"; chore?: Chore } | { kind: "chore"; id: string } | { kind: "inbox" } | { kind: "checkin" }>(null);
  const [now, setNow] = useState(() => new Date());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [zoom, setZoomState] = useState(() => lsGet("lc:zoom") || "1");
  const dark = useDark();

  useEffect(() => lsSet("lc:tab", tab), [tab]);
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(id); }, []);

  const toast = useCallback((text: string, undo?: () => void) => {
    const id = Date.now() + Math.random();
    setToasts([{ id, text, undo }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), undo ? 6500 : 3500);
  }, []);

  const me = config.me!;
  const rooms = useMemo(() => new Map((data?.house.rooms ?? []).map((r) => [r.id, r])), [data?.house.rooms]);
  const inst = useCallback((c: Chore, at: Date = now): Inst => {
    const period = periodKey(c.freq, at);
    const key = `${period}|${c.id}`;
    const plan = data!.plans.items[key];
    const base = baseOwner(c, rooms, data!.settings, at);
    const owner: Owner = plan?.owner ?? base;
    return { c, key, period, owner, covering: !!plan?.owner && plan.owner !== base, mark: data!.log.done[key], plan, skipped: !!plan?.skip };
  }, [data, rooms, now]);
  const act = useMemo(() => (data ? makeActions(data, me, mutate, toast) : null), [data, me, mutate, toast]);

  const closePanel = useCallback(() => setPanel(null), []);

  if (setup) return <Setup initial={config} onDone={(c) => { saveConfig(c); setConfig(c); setSetup(false); }} />;

  const updateConfig = (c: Config | null) => { if (!c) { setPanel(null); setSetup(true); return; } saveConfig(c); setConfig(c); };
  const inkFor = (p: Person) => INKS.find((x) => x.id === (data?.settings.colors?.[p] ?? DEFAULT_INK[p])) ?? INKS[0];
  const style = {
    "--grant": dark ? inkFor("grant").dark : inkFor("grant").light,
    "--cass": dark ? inkFor("cass").dark : inkFor("cass").light,
    "--me": `var(--${me})`,
    "--zoom": zoom,
  } as React.CSSProperties;

  const ctx: Ctx | null = data && act ? {
    data, me, now, rooms, mutate, inst, act, toast,
    openChore: (c) => setPanel({ kind: "chore", id: c.id }),
    openInbox: () => setPanel({ kind: "inbox" }),
    openCheckin: () => setPanel({ kind: "checkin" }),
    goTab: (t) => { setTab(t); window.scrollTo(0, 0); },
  } : null;

  return (
    <div className="app" style={style}>
      {ctx ? (
        <AppCtx.Provider value={ctx}>
          <TopBar sync={sync} local={config.mode === "local"} onInbox={() => setPanel({ kind: "inbox" })} onSettings={() => setPanel({ kind: "settings" })} />
          {error && <ErrorBanner error={error} onRetry={() => { clearError(); reload(); }} onDismiss={clearError} />}
          <main className="main">
            {tab === "today" ? <TodayView /> : tab === "week" ? <WeekView /> : tab === "chores" ? <ChoresView /> : tab === "projects" ? <ProjectsView /> : <ListsView />}
          </main>
          {panel?.kind === "settings" && <SettingsSheet config={config} onConfig={updateConfig} onEdit={() => setPanel({ kind: "editor" })} onClose={() => setPanel(null)}
            zoom={zoom} setZoom={(z) => { setZoomState(z); lsSet("lc:zoom", z); }} />}
          {panel?.kind === "editor" && <Editor startChore={panel.chore} onClose={() => setPanel(panel.chore ? { kind: "chore", id: panel.chore.id } : { kind: "settings" })} />}
          {panel?.kind === "chore" && <ChoreSheet choreId={panel.id} onClose={closePanel} onEdit={(c) => setPanel({ kind: "editor", chore: c })} />}
          {panel?.kind === "inbox" && <InboxSheet onClose={() => setPanel(null)} />}
          {panel?.kind === "checkin" && <CheckinSheet onClose={() => setPanel(null)} />}
        </AppCtx.Provider>
      ) : (
        <>
          <header className="top"><span className="brand">Lovetta</span></header>
          {error && <ErrorBanner error={error} onRetry={() => { clearError(); reload(); }} onDismiss={clearError} />}
          <main className="main"><p className="empty">{error ? "Couldn't load the house. Check the message above." : "Loading the house…"}</p></main>
        </>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.text}</span>
            {t.undo && <button type="button" onClick={() => { t.undo!(); setToasts([]); }}>Undo</button>}
          </div>
        ))}
      </div>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} className={tab === t.id ? "tab tab-on" : "tab"}
            onClick={() => { setTab(t.id); window.scrollTo(0, 0); }}>{t.label}</button>
        ))}
      </nav>
    </div>
  );
}

function TopBar({ sync, local, onInbox, onSettings }: { sync: SyncState; local: boolean; onInbox: () => void; onSettings: () => void }) {
  const unread = useUnread();
  const { data, me } = useApp();
  const asks = data.activity.items.filter((a) => a.kind === "request" && a.status === "open" && a.to === me).length;
  const badge = Math.max(unread.length, asks);
  return (
    <header className="top">
      <span className="brand">Lovetta</span>
      <span className={`sync sync-${sync}`} role="status" aria-label={local ? "Not syncing" : sync === "idle" ? "Synced" : undefined}>
        {local ? "Not syncing" : sync === "saving" ? "Saving…" : sync === "error" ? "Not saved" : sync === "offline" ? "Offline" : <span className="sync-ok" title="Synced">✓</span>}
      </span>
      <button type="button" className="btn-quiet btn-inbox" onClick={onInbox} aria-label={badge ? `Inbox, ${badge} new` : "Inbox"}>
        Inbox{badge > 0 && <span className="badge">{badge}</span>}
      </button>
      <button type="button" className="btn-quiet" onClick={onSettings}>Settings</button>
    </header>
  );
}

function ErrorBanner({ error, onRetry, onDismiss }: { error: string; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="banner" role="alert">
      <span>{error}</span>
      <span className="form-actions">
        <button type="button" className="btn-quiet" onClick={onDismiss}>Dismiss</button>
        <button type="button" className="btn-primary" onClick={onRetry}>Try again</button>
      </span>
    </div>
  );
}

/* ================================================================ styles */

const CSS = `
:root {
  --board: #F3F6F5; --sheet: #FFFFFF; --ink: #1E2B30; --ink-soft: #5A6A6F; --rule: #D3DCDA;
  --both: #3F6B4F; --tile: #E9BFC3; --tile-soft: #F7E6E8; --danger: #A12A1C; --late: #A04A12;
  --radius: 12px; --tabs-h: 64px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --board: #172125; --sheet: #1F2B30; --ink: #E3EBE9; --ink-soft: #9DADB1; --rule: #34454B;
    --both: #9CC6A8; --tile: #6C3C43; --tile-soft: #33272A; --danger: #F08A7C; --late: #F0A36B;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--board); color: var(--ink); font: 16px/1.45 "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, sans-serif; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; }
button, input, select, textarea { font: inherit; color: inherit; }
button { touch-action: manipulation; }
a { color: var(--me, #2457A6); }
:focus-visible { outline: 3px solid var(--me, #2457A6); outline-offset: 2px; border-radius: 6px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.soft { color: var(--ink-soft); }
.small { font-size: 13px; }
.marker { font-family: "Kalam", "Marker Felt", cursive; font-weight: 700; letter-spacing: -0.01em; }
.quote { font-style: italic; }

.app { max-width: 680px; margin: 0 auto; min-height: 100dvh; padding-bottom: calc(var(--tabs-h) + env(safe-area-inset-bottom) + 72px); zoom: var(--zoom, 1); }
.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px; padding: calc(10px + env(safe-area-inset-top)) 16px 10px; background: var(--board); border-bottom: 1px solid var(--rule); }
.brand { font-family: "Kalam", cursive; font-weight: 700; font-size: 22px; flex: 1; min-width: 0; }
.top .btn-quiet { white-space: nowrap; padding: 8px 14px; }
.sync-ok { color: var(--both); font-weight: 700; font-size: 16px; }
.sync { font-size: 13px; color: var(--ink-soft); }
.sync-saving { color: var(--ink); }
.sync-error, .sync-offline { color: var(--danger); }
.btn-inbox { position: relative; }
.badge { display: inline-grid; place-items: center; min-width: 22px; height: 22px; margin-left: 6px; padding: 0 6px; border-radius: 99px; background: var(--danger); color: #fff; font-size: 13px; font-weight: 700; }
.main { padding: 0 16px; }
.banner { margin: 12px 16px 0; padding: 12px; border-radius: var(--radius); background: var(--tile-soft); border: 1px solid var(--tile); display: grid; gap: 8px; }

.board-head { padding: 20px 0 8px; display: grid; gap: 12px; }
.board-head h1 { margin: 0; font-size: clamp(30px, 8vw, 40px); line-height: 1.05; }
.board-head p { margin: 0; }

.progress { display: grid; gap: 6px; }
.progress-row { display: grid; grid-template-columns: 52px 1fr auto; gap: 10px; align-items: center; font-size: 14px; }
.progress-name { font-weight: 700; }
.progress-track { height: 8px; border-radius: 99px; background: var(--rule); overflow: hidden; }
.progress-fill { display: block; height: 100%; border-radius: 99px; transition: width .35s ease; }
.progress-num { color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.balance { display: grid; gap: 6px; font-size: 14px; }
.balance-label { display: flex; justify-content: space-between; gap: 10px; font-weight: 700; }
.balance-label .soft { font-weight: 400; }
.balance-bar { display: flex; height: 8px; border-radius: 99px; overflow: hidden; gap: 2px; }
.balance-bar span { display: block; transition: flex .35s ease; }

.seg { display: flex; background: var(--sheet); border: 1px solid var(--rule); border-radius: 99px; padding: 3px; gap: 2px; }
.seg button { flex: 1; border: 0; background: none; padding: 8px 10px; border-radius: 99px; cursor: pointer; font-size: 15px; min-height: 42px; color: var(--ink-soft); }
.seg .seg-on { background: var(--ink); color: var(--board); font-weight: 700; }
.seg-small button { min-height: 36px; font-size: 14px; padding: 6px 8px; }

.toolbar { display: flex; gap: 10px; align-items: center; }
.toolbar .search { flex: 1; }
.select select, .search, .form input, .form select, .form textarea, .add-row input, .owners select, .chore-sheet textarea {
  width: 100%; border: 1px solid var(--rule); background: var(--sheet); border-radius: 10px; padding: 9px 12px; min-height: 44px;
}
.select select { width: auto; }

.room { background: var(--sheet); border: 1px solid var(--rule); border-radius: var(--radius); margin: 14px 0; overflow: hidden; }
.room-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px 4px; }
.room-head h3 { margin: 0; font-size: 18px; }
.room-quiet { background: transparent; }
.room-tray { border-style: dashed; }
.room-ahead { background: transparent; border-style: dashed; }
.room-toggle { width: 100%; display: flex; justify-content: space-between; align-items: center; background: none; border: 0; padding: 14px; cursor: pointer; font-weight: 700; text-align: left; min-height: 52px; }
.room-toggle::after { content: "›"; font-size: 22px; transition: transform .2s; color: var(--ink-soft); }
.room-toggle[aria-expanded="true"]::after { transform: rotate(90deg); }
.count { margin-left: auto; margin-right: 8px; color: var(--ink-soft); font-weight: 400; font-variant-numeric: tabular-nums; }
.room-head .count { margin: 0; }
.empty-box { padding: 6px 14px 14px; margin: 0; display: grid; gap: 10px; justify-items: start; color: var(--ink-soft); }
.empty-box p { margin: 0; }

.tasks { list-style: none; margin: 0; padding: 0 0 4px; }
.tasks-card { background: var(--sheet); border: 1px solid var(--rule); border-radius: var(--radius); }
.task { display: flex; align-items: stretch; }
.tasks .task + .task { border-top: 1px solid var(--rule); }
.task-check { flex: none; width: 56px; display: grid; place-items: center; background: none; border: 0; cursor: pointer; padding: 0; }
.task-open { flex: 1; text-align: left; background: none; border: 0; padding: 12px 14px 12px 0; cursor: pointer; display: grid; gap: 2px; min-height: 54px; align-content: center; }
.task-check:active, .task-open:active { background: var(--tile-soft); }
.task-owner { display: grid; place-items: center; padding-right: 14px; }
.check { width: 30px; height: 30px; }
.check-box { fill: none; stroke: var(--ink-soft); stroke-width: 1.6; }
.check-box-dashed { stroke-dasharray: 3 3; }
.check-mark { fill: none; stroke-width: 3.4; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 30; stroke-dashoffset: 30; animation: draw .32s cubic-bezier(.3,.7,.4,1) forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
.task-title { font-size: 16px; }
.task-done .task-title { color: var(--ink-soft); text-decoration: line-through; text-decoration-color: var(--ink-soft); }
.task-skipped .task-title { color: var(--ink-soft); }
.task-meta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 13px; color: var(--ink-soft); }
.task-by { font-family: "Kalam", cursive; font-size: 15px; line-height: 1.15; }
.late { color: var(--late); font-weight: 700; }

.owner { font-family: "Kalam", cursive; font-weight: 700; line-height: 1; border: 2px solid currentColor; border-radius: 999px; display: inline-grid; place-items: center; flex: none; }
.owner-md { min-width: 34px; height: 34px; padding: 0 6px; font-size: 17px; }
.owner-sm { min-width: 28px; height: 28px; padding: 0 5px; font-size: 14px; }

.lane { margin: 10px 0; }
.lane-today { border: 2px solid var(--me); }
.lane-past { opacity: .72; }
.lane-date { font-weight: 400; font-size: 15px; }
.lane-badge { font-size: 13px; font-weight: 700; color: var(--me); }
.lane-empty { margin: 0; padding: 2px 14px 12px; color: var(--ink-soft); font-size: 14px; }

.tray-jump { justify-self: start; }
.sheet-actions { display: flex; gap: 8px; }
.size { display: inline-grid; place-items: center; min-width: 26px; height: 20px; padding: 0 5px; border-radius: 6px; font-size: 12px; font-weight: 700; letter-spacing: .02em; border: 1px solid var(--rule); color: var(--ink-soft); background: var(--board); vertical-align: 1px; }
.size-L { color: var(--ink); border-color: var(--ink-soft); }
.size-XL { color: var(--board); background: var(--ink); border-color: var(--ink); }
.fit { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center; }
.fit-label { font-weight: 700; font-size: 14px; }
.fit .seg button { padding: 6px 4px; font-size: 13px; }
.link-row { width: 100%; display: flex; justify-content: space-between; gap: 12px; background: none; border: 0; padding: 4px 0; text-align: left; cursor: pointer; }
.link-row .soft { display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; }
.load { display: grid; gap: 8px; background: var(--sheet); border: 1px solid var(--rule); border-radius: var(--radius); padding: 12px; }
.load p { margin: 0; }
.load-row { display: grid; grid-template-columns: 52px 1fr; gap: 4px 10px; align-items: center; }
.load-row .small { grid-column: 2; }
.load-bar { height: 8px; border-radius: 99px; background: var(--rule); overflow: hidden; }
.load-bar span { display: block; height: 100%; border-radius: 99px; }
.note-actions { display: flex; gap: 14px; }
.since { width: 100%; display: grid; gap: 4px; text-align: left; background: var(--sheet); border: 2px solid var(--me); border-radius: var(--radius); padding: 14px; margin: 6px 0 10px; cursor: pointer; }
.since-go { color: var(--me); font-weight: 700; }
.since-checkin { border-style: dashed; }
.request { background: var(--sheet); border: 2px solid; border-radius: var(--radius); padding: 14px; margin: 10px 0; display: grid; gap: 6px; }
.request p { margin: 0; }
.request-text { font-size: 16px; }

.ahead { list-style: none; margin: 0; padding: 4px 14px 12px; display: grid; gap: 8px; }
.ahead li { display: flex; justify-content: space-between; gap: 12px; }
.empty { color: var(--ink-soft); padding: 18px 2px; margin: 0; }
.error { color: var(--danger); margin: 0; }

.projects { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 10px; }
.project { display: flex; background: var(--sheet); border: 1px solid var(--rule); border-radius: var(--radius); border-left: 5px solid var(--rule); overflow: hidden; }
.prio-1 { border-left-color: var(--danger); }
.prio-2 { border-left-color: var(--tile); }
.project-main { flex: 1; text-align: left; background: none; border: 0; padding: 12px 14px; cursor: pointer; display: grid; gap: 4px; }
.project-title { font-weight: 700; }
.project-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 13px; color: var(--ink-soft); }
.tag-doing { color: var(--ink); font-weight: 700; }
.project-side { display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 12px 0; }

.btn-primary, .btn-quiet, .btn-danger, .btn-small, .btn-add { border-radius: 999px; cursor: pointer; min-height: 44px; padding: 8px 16px; }
.btn-primary { background: var(--ink); color: var(--board); border: 1px solid var(--ink); font-weight: 700; }
.btn-primary:disabled { opacity: .45; cursor: default; }
.btn-big { width: 100%; min-height: 52px; font-size: 17px; }
.btn-quiet { background: var(--sheet); border: 1px solid var(--rule); }
.btn-quiet-danger, .btn-danger { color: var(--danger); }
.btn-danger { background: none; border: 1px solid currentColor; margin-right: auto; }
.btn-danger:disabled { opacity: .4; }
.btn-small { min-height: 36px; padding: 4px 12px; font-size: 14px; background: none; border: 1px solid var(--rule); }
.btn-add { width: 100%; margin: 8px 0 14px; background: none; border: 2px dashed var(--rule); color: var(--ink); font-weight: 700; min-height: 50px; }
.link-btn { background: none; border: 0; padding: 4px 0; color: var(--me); font-weight: 700; cursor: pointer; font-size: inherit; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--rule); background: var(--sheet); border-radius: 999px; padding: 6px 14px; cursor: pointer; min-height: 40px; display: inline-flex; align-items: center; gap: 8px; }
.chip-on { background: var(--ink); color: var(--board); border-color: var(--ink); font-weight: 700; }
.chip-n { font-size: 13px; opacity: .75; font-variant-numeric: tabular-nums; }
.chip-new { border-style: dashed; }
.add-row { display: flex; gap: 8px; margin: 6px 0 10px; }
.add-row input { flex: 1; min-width: 0; }
.list-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }

.tabs { position: fixed; left: 0; right: 0; bottom: 0; z-index: 6; display: flex; justify-content: center; background: var(--sheet); border-top: 1px solid var(--rule); padding-bottom: env(safe-area-inset-bottom); }
.tab { flex: 1; max-width: 136px; height: var(--tabs-h); background: none; border: 0; cursor: pointer; font-size: 15px; color: var(--ink-soft); position: relative; }
.tab-on { color: var(--ink); font-weight: 700; }
.tab-on::after { content: ""; position: absolute; left: 20%; right: 20%; bottom: 13px; height: 4px; border-radius: 99px; background: var(--me); transform: rotate(-1.5deg); }

.toasts { position: fixed; left: 0; right: 0; bottom: calc(var(--tabs-h) + env(safe-area-inset-bottom) + 10px); z-index: 30; display: grid; justify-items: center; pointer-events: none; padding: 0 16px; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 16px; max-width: 520px; width: 100%; background: var(--ink); color: var(--board); border-radius: 14px; padding: 10px 10px 10px 16px; box-shadow: 0 6px 24px rgba(10,20,25,.25); animation: pop .2s ease-out; }
.toast span { flex: 1; }
.toast button { background: none; border: 1px solid currentColor; color: inherit; border-radius: 99px; padding: 6px 14px; font-weight: 700; cursor: pointer; min-height: 38px; }
@keyframes pop { from { transform: translateY(10px); opacity: 0; } }

.sheet-wrap { position: fixed; inset: 0; z-index: 20; background: rgba(15, 22, 25, .45); display: flex; align-items: flex-end; justify-content: center; }
.sheet { width: 100%; max-width: 680px; max-height: 90dvh; overflow: auto; background: var(--board); border-radius: 18px 18px 0 0; padding-bottom: calc(24px + env(safe-area-inset-bottom)); animation: rise .24s ease-out; overscroll-behavior: contain; }
.sheet-tall { min-height: 70dvh; }
@keyframes rise { from { transform: translateY(100%); } }
.sheet-head { position: sticky; top: 0; z-index: 1; background: var(--board); display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--rule); }
.sheet-head h2 { margin: 0; font-size: 20px; }
.sheet-body { padding: 4px 16px; }
.sheet-foot { padding-top: 14px; }

.chore-sheet { display: grid; gap: 16px; padding: 12px 0; }
.chore-sheet > p { margin: 0; }
.who-line { display: flex; align-items: center; gap: 10px; margin: 0; }
.done-line { display: grid; gap: 10px; padding: 12px 14px; border-left: 4px solid var(--rule); background: var(--sheet); border-radius: 0 var(--radius) var(--radius) 0; }
.block { display: grid; gap: 8px; }
.block h4, .notes h4 { margin: 0; font-size: 15px; }
.standard { margin: 0; padding: 12px 14px; background: var(--sheet); border-radius: var(--radius); border: 1px solid var(--rule); white-space: pre-wrap; }
.action-list { display: grid; gap: 8px; }
.action-list .btn-quiet { text-align: left; }
.notes { display: grid; gap: 8px; }
.note-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.note { background: var(--sheet); border-left: 4px solid; border-radius: 0 10px 10px 0; padding: 8px 12px; display: grid; gap: 2px; }
.note-by { font-family: "Kalam", cursive; font-size: 15px; }
.note .link-btn { font-size: 13px; color: var(--ink-soft); font-weight: 400; }

.feed { list-style: none; margin: 0; padding: 8px 0; display: grid; gap: 8px; }
.feed-item { background: var(--sheet); border-left: 4px solid; border-radius: 0 10px 10px 0; padding: 10px 12px; display: grid; gap: 4px; }
.feed-unread { box-shadow: inset 0 0 0 2px var(--rule); }
.feed-unread .feed-text::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); margin-right: 8px; vertical-align: 2px; }
.feed-foot { display: flex; gap: 14px; align-items: center; }

.stepper { list-style: none; display: flex; gap: 6px; padding: 12px 0 0; margin: 0; counter-reset: s; }
.stepper li { flex: 1; font-size: 12px; color: var(--ink-soft); border-top: 4px solid var(--rule); padding-top: 6px; }
.stepper .step-on { color: var(--ink); font-weight: 700; border-color: var(--me); }
.stepper .step-done { border-color: var(--ink-soft); }
.checkin { display: grid; gap: 12px; padding: 14px 0; }
.checkin h3 { margin: 0; }
.checkin p { margin: 0; }
.pick-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.pick { width: 100%; display: flex; align-items: center; gap: 12px; background: var(--sheet); border: 1px solid var(--rule); border-radius: 10px; padding: 8px 12px; text-align: left; cursor: pointer; min-height: 52px; }
.pick-on { border-color: var(--me); border-width: 2px; }
.pick-text { flex: 1; display: grid; }

.swatches { display: flex; flex-wrap: wrap; gap: 10px; }
.swatch { width: 42px; height: 42px; border-radius: 50%; border: 3px solid var(--board); box-shadow: 0 0 0 1px var(--rule); cursor: pointer; }
.swatch-on { box-shadow: 0 0 0 3px var(--ink); }
.swatch:disabled { opacity: .25; cursor: not-allowed; }

.form { display: grid; gap: 14px; padding: 12px 0; }
.form label { display: grid; gap: 6px; font-weight: 700; font-size: 15px; }
.form label.inline { display: flex; align-items: center; gap: 10px; font-weight: 400; }
.form label.inline input { width: 22px; height: 22px; min-height: 0; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; align-items: center; }
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
.help summary { cursor: pointer; font-weight: 700; min-height: 32px; }
.help p { margin: 8px 0; }

@media (prefers-reduced-motion: reduce) {
  .check-mark { animation: none; stroke-dashoffset: 0; }
  .sheet, .toast, .progress-fill, .balance-bar span { animation: none; transition: none; }
}
`;

/* ================================================================== boot */

const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<App />);

(window as any).__lovetta = { roomOwner, weekKey, monthKey, rotationSide };
