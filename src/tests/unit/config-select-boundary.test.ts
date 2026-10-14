// config-select-boundary.test.ts — the PURE "when does the effective model
// change?" logic (`nextModelBoundary`) that the in-flight switch is built on.
//
// No clock, no I/O, no CLI: every case is a config + an instant + a current
// model. The in-flight switch must only ever restart a run at a REAL local
// boundary:
//   * start inclusive / end exclusive — a window yields BOTH of its boundaries;
//   * adjacent windows → exactly one boundary at the shared second (no phantom);
//   * overlapping windows → first-match-wins, so a shadowed slot is silent;
//   * cross-midnight windows wrap past midnight;
//   * a DISABLED slot contributes no boundary at all;
//   * a boundary whose model equals the current one is skipped;
//   * a STALE target or an UNRELIABLE catalog yields NO boundary (never restart
//     onto a model CrewDispatch cannot prove);
//   * an EXPLICIT per-job model never has a boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, type CrewDispatchConfig, type TimeSlot } from "../../config/schema";
import { nextModelBoundary, nextOccurrenceMs, type CatalogEvidence } from "../../config/select";

const RELIABLE: CatalogEvidence = { ok: true, source: "cli-list-models", models: ["m/a", "m/b", "m/c"], defaultModel: "m/a" };
const UNAVAILABLE: CatalogEvidence = { ok: false, source: "unavailable", models: [], defaultModel: null };

/** A local instant on a fixed day (2026-09-24), so every case is reproducible. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 24, hour, minute, 0, 0);
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function cfg(patch: Partial<CrewDispatchConfig>): CrewDispatchConfig {
  return { ...defaultConfig(), ...patch };
}

function slot(start: string, end: string, model: string, enabled = true): TimeSlot {
  return { start, end, model, enabled };
}

test("nextOccurrenceMs maps a second-of-day to its NEXT local occurrence (wraps past midnight)", () => {
  const now = at(9, 0).getTime();
  assert.equal(nextOccurrenceMs(9 * 3600, now) - now, 24 * 3600 * 1000, "the same second is strictly in the future");
  assert.equal(new Date(nextOccurrenceMs(8 * 3600, now)).getHours(), 8, "an earlier second lands tomorrow");
  assert.equal(new Date(nextOccurrenceMs(10 * 3600, now)).getHours(), 10, "a later second lands today");
});

test("a normal window yields BOTH of its boundaries (start inclusive, end exclusive)", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/b")] });
  // Running on the default, before the window: the boundary is the window START.
  const enter = nextModelBoundary({ config, now: at(7, 0), catalog: RELIABLE, currentModel: "m/a" });
  assert.equal(enter?.model, "m/b");
  assert.equal(enter?.source, "slot");
  assert.equal(enter?.slotIndex, 0);
  assert.equal(new Date(enter!.atMs).getHours(), 8);
  // Running on the slot, inside the window: the boundary is the window END.
  const leave = nextModelBoundary({ config, now: at(9, 0), catalog: RELIABLE, currentModel: "m/b" });
  assert.equal(leave?.model, "m/a");
  assert.equal(leave?.source, "config-default");
  assert.equal(new Date(leave!.atMs).getHours(), 12);
  // At the END second the window is already over: 12:00 never switches INTO it.
  const after = nextModelBoundary({ config, now: at(12, 0), catalog: RELIABLE, currentModel: "m/a" });
  assert.equal(after?.model, "m/b", "the next boundary is tomorrow's 08:00, not 12:00");
  assert.equal(new Date(after!.atMs).getDate(), new Date(at(12, 0)).getDate() + 1);
});

test("adjacent windows yield exactly one boundary at the shared second (no phantom)", () => {
  const config = cfg({
    defaultModel: "m/a",
    timeSlots: [slot("08:00", "12:00", "m/b"), slot("12:00", "18:00", "m/c")]
  });
  const b = nextModelBoundary({ config, now: at(9, 0), catalog: RELIABLE, currentModel: "m/b" });
  assert.equal(b?.model, "m/c", "12:00 hands over to the next window");
  assert.equal(new Date(b!.atMs).getHours(), 12);
  const c = nextModelBoundary({ config, now: at(13, 0), catalog: RELIABLE, currentModel: "m/c" });
  assert.equal(c?.model, "m/a", "18:00 ends the second window");
  assert.equal(new Date(c!.atMs).getHours(), 18);
});

test("overlapping windows: the FIRST slot wins, so a shadowed slot is never a switch target", () => {
  const config = cfg({
    defaultModel: "m/a",
    timeSlots: [slot("08:00", "18:00", "m/b"), slot("10:00", "11:00", "m/c")]
  });
  // Both 10:00 and 11:00 are candidate seconds, but the first slot still matches
  // there, so the effective model does NOT change → neither is a boundary.
  const b = nextModelBoundary({ config, now: at(9, 0), catalog: RELIABLE, currentModel: "m/b" });
  assert.equal(b?.model, "m/a", "the first real boundary is the dominant window's END");
  assert.equal(new Date(b!.atMs).getHours(), 18);
  assert.notEqual(b?.model, "m/c");
});

test("a cross-midnight window yields its boundaries wrapped past midnight", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("23:00", "08:00", "m/b")] });
  const enter = nextModelBoundary({ config, now: at(21, 0), catalog: RELIABLE, currentModel: "m/a" });
  assert.equal(enter?.model, "m/b");
  assert.equal(new Date(enter!.atMs).getHours(), 23);
  // From inside the window the END (08:00) is the NEXT day, before 23:00 again.
  const leave = nextModelBoundary({ config, now: at(23, 30), catalog: RELIABLE, currentModel: "m/b" });
  assert.equal(leave?.model, "m/a");
  assert.equal(new Date(leave!.atMs).getHours(), 8);
  assert.equal(new Date(leave!.atMs).getDate(), new Date(at(23, 30)).getDate() + 1, "wrapped past midnight");
});

test("a DISABLED slot contributes no boundary at all", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/b", false)] });
  assert.equal(nextModelBoundary({ config, now: at(9, 0), catalog: RELIABLE, currentModel: "m/a" }), null);
  // No slot at all: nothing can ever change.
  assert.equal(nextModelBoundary({ config: defaultConfig(), now: at(9, 0), catalog: RELIABLE, currentModel: "m/a" }), null);
});

test("a boundary whose model equals the current one is skipped (a same-model boundary never restarts)", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/a")] });
  assert.equal(nextModelBoundary({ config, now: at(9, 0), catalog: RELIABLE, currentModel: "m/a" }), null);
  // Two different windows carrying the SAME id are silent too.
  const same = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/a"), slot("12:00", "18:00", "m/a")] });
  assert.equal(nextModelBoundary({ config: same, now: at(9, 0), catalog: RELIABLE, currentModel: "m/a" }), null);
});

test("a STALE target is never a switch target (the stale boundary is skipped, not repaired)", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/zzz")] });
  // Entering the window would need m/zzz, which the catalog does not list → skip
  // that boundary; leaving it (12:00 → m/a) equals the current model → skip too.
  assert.equal(nextModelBoundary({ config, now: at(7, 0), catalog: RELIABLE, currentModel: "m/a" }), null);
});

test("an UNRELIABLE CLI catalog yields NO boundary (never restart onto an unverifiable model)", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/b")] });
  assert.equal(nextModelBoundary({ config, now: at(7, 0), catalog: UNAVAILABLE, currentModel: "m/a" }), null);
});

test("an EXPLICIT per-job model never has a boundary (it never switches with the clock)", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/b")] });
  assert.equal(nextModelBoundary({ config, now: at(7, 0), catalog: RELIABLE, explicitModel: "m/a", currentModel: "m/a" }), null);
});

test("the boundary instant is the NEXT occurrence, so the switch never fires backwards", () => {
  const config = cfg({ defaultModel: "m/a", timeSlots: [slot("08:00", "12:00", "m/b")] });
  const b = nextModelBoundary({ config, now: at(13, 0), catalog: RELIABLE, currentModel: "m/b" });
  // The window is already over, but the CURRENT model is still the window's.
  // Tomorrow's 08:00 would only re-enter the SAME model (skipped), so the next
  // real CHANGE is tomorrow's 12:00, where the window ends again → m/a.
  assert.ok(b);
  assert.ok(b!.atMs > at(13, 0).getTime());
  assert.equal(hhmm(new Date(b!.atMs)), "12:00");
  assert.equal(b?.model, "m/a");
  assert.equal(new Date(b!.atMs).getDate(), new Date(at(13, 0)).getDate() + 1, "never a boundary in the past");
});
