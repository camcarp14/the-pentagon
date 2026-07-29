// The execution layer is where a wrong answer becomes a wrong *day*: a
// double-booked hour, a task closed that wasn't the one meant. These tests are
// mostly about the two rules the tools promise — never guess an identity, and
// never fail silently.

import { describe, it, expect, beforeAll } from "vitest";
import { installBrowserEnv } from "../../test/env.js";

installBrowserEnv();

const store = await import("../../data/store.js");
const { runTool, TOOLS, toolDefs, describeGaps, isServerTool } = await import("../tools.js");
const { dayKey, addDays, fmtTime } = await import("../../lib/time.js");

const today = dayKey();
const reset = () => store.resetAll({ keepKey: false });

/* ── the schemas the model plans against ───────────────────────────────────── */
describe("the schemas the model plans against", () => {
  const defs = toolDefs({ webSearch: true });

  it("every tool is exposed", () => expect(defs.length === Object.keys(TOOLS).length + 1).toBe(true));
  it("web search is a server tool", () => expect(defs.some((d) => d.type === "web_search_20250305")).toBe(true));
  it("web search can be turned off", () => expect(!toolDefs({ webSearch: false }).some((d) => d.name === "web_search")).toBe(true));
  it("isServerTool recognises web_search", () => expect(isServerTool("web_search") && !isServerTool("add_tasks")).toBe(true));

  for (const d of defs) {
    if (d.type) continue;
    it(`${d.name} has a description`, () => expect(typeof d.description === "string" && d.description.length > 40).toBe(true));
    it(`${d.name} has an object schema`, () => expect(d.input_schema?.type === "object").toBe(true));
  }
});

/* ── an unknown tool fails cleanly instead of throwing ─────────────────────── */
describe("an unknown tool fails cleanly instead of throwing", () => {
  let bogus;
  beforeAll(() => { bogus = runTool("teleport", {}); });

  it("unknown tool does not succeed", () => expect(bogus.ok).toEqual(false));
  it("unknown tool explains itself", () => expect(/no tool called/i.test(bogus.summary)).toBe(true));
});

/* ── plan_day ──────────────────────────────────────────────────────────────── */
describe("plan_day", () => {
  let planned;

  beforeAll(() => {
    reset();
    planned = runTool("plan_day", {
      day: "today",
      blocks: [
        { title: "Deep work", start: "09:00", mins: 90, kind: "deep" },
        { title: "Standup", start: "11:00", mins: 30, kind: "meeting" },
      ],
    });
  });

  it("plan_day succeeded", () => expect(planned.ok).toEqual(true));
  it("plan_day created both blocks", () => expect(store.getState().blocks.length).toEqual(2));
  it("plan_day is undoable", () => expect(!!store.getState().ledger.at(-1).undo).toEqual(true));

  // Overlapping blocks inside one plan are refused with the pair named, so the
  // model can fix it in the same turn instead of quietly stacking them.
  describe("overlapping blocks inside one plan", () => {
    let overlapping;

    beforeAll(() => {
      overlapping = runTool("plan_day", {
        blocks: [
          { title: "A", start: "13:00", mins: 60 },
          { title: "B", start: "13:30", mins: 60 },
        ],
      });
    });

    it("overlapping plan is refused", () => expect(overlapping.ok).toEqual(false));
    it("refusal names both blocks", () => expect(overlapping.summary.includes("A") && overlapping.summary.includes("B")).toBe(true));
    it("refused plan changed nothing", () => expect(store.getState().blocks.length).toEqual(2));
  });

  // replace:true wipes only that day.
  describe("replace:true wipes only that day", () => {
    beforeAll(() => {
      runTool("schedule_block", { title: "Tomorrow thing", start: "09:00", day: "tomorrow" });
      runTool("plan_day", { replace: true, blocks: [{ title: "Only thing", start: "10:00", mins: 60 }] });
    });

    it("replace cleared today", () => expect(store.getState().blocks.filter((b) => b.day === today).length).toEqual(1));
    it("replace left other days alone", () => expect(store.getState().blocks.filter((b) => b.day === addDays(today, 1)).length).toEqual(1));
  });
});

/* ── schedule_block and collisions ─────────────────────────────────────────── */
describe("schedule_block and collisions", () => {
  beforeAll(() => {
    reset();
    runTool("schedule_block", { title: "Client call", start: "2pm", mins: 60, kind: "meeting" });
  });

  it("12-hour time parsed", () => expect(store.getState().blocks[0].start).toEqual(840));

  describe("a colliding block", () => {
    let collided;
    beforeAll(() => { collided = runTool("schedule_block", { title: "Overlap", start: "14:30", mins: 30 }); });

    it("collision is refused", () => expect(collided.ok).toEqual(false));
    it("collision names what it hit", () => expect(collided.summary.includes("Client call")).toBe(true));
    it("refusal did not schedule", () => expect(store.getState().blocks.length).toEqual(1));
  });

  describe("force", () => {
    let forced;
    beforeAll(() => { forced = runTool("schedule_block", { title: "Overlap", start: "14:30", mins: 30, force: true }); });

    it("force overrides the collision", () => expect(forced.ok).toEqual(true));
    it("forced block was created", () => expect(store.getState().blocks.length).toEqual(2));
  });

  describe("unreadable input", () => {
    let badTime;
    let noTitle;
    beforeAll(() => {
      badTime = runTool("schedule_block", { title: "Whenever", start: "sometime after lunch" });
      noTitle = runTool("schedule_block", { title: "  ", start: "09:00" });
    });

    it("unreadable time is refused", () => expect(badTime.ok).toEqual(false));
    it("unreadable time says what it wanted", () => expect(/24h|12h/.test(badTime.summary)).toBe(true));
    it("a block needs a title", () => expect(noTitle.ok).toEqual(false));
  });
});

/* ── move_block: never guess ───────────────────────────────────────────────── */
describe("move_block: never guess", () => {
  beforeAll(() => {
    reset();
    runTool("schedule_block", { title: "Clarify outreach", start: "09:00", mins: 60 });
    runTool("schedule_block", { title: "Clarify review", start: "11:00", mins: 60 });
  });

  describe("an ambiguous or unknown reference", () => {
    let ambiguous;
    let missing;
    beforeAll(() => {
      ambiguous = runTool("move_block", { block: "Clarify", start: "15:00" });
      missing = runTool("move_block", { block: "Nonexistent thing", start: "15:00" });
    });

    it("an ambiguous reference is refused", () => expect(ambiguous.ok).toEqual(false));
    it("refusal lists the candidates", () => expect(ambiguous.summary.includes("Clarify outreach") && ambiguous.summary.includes("Clarify review")).toBe(true));
    it("an unknown reference is refused", () => expect(missing.ok).toEqual(false));
  });

  describe("an exact title", () => {
    let exact;
    beforeAll(() => { exact = runTool("move_block", { block: "Clarify review", start: "15:00" }); });

    it("an exact title resolves", () => expect(exact.ok).toEqual(true));
    it("the right block moved", () => expect(store.getState().blocks.find((b) => b.title === "Clarify review").start).toEqual(900));
    it("the other block did not move", () => expect(store.getState().blocks.find((b) => b.title === "Clarify outreach").start).toEqual(540));
  });

  describe("an id", () => {
    let byId;
    beforeAll(() => { byId = runTool("move_block", { block: store.getState().blocks[0].id, mins: 30 }); });

    it("an id resolves", () => expect(byId.ok).toEqual(true));
    it("resize applied", () => expect(store.getState().blocks[0].mins).toEqual(30));
  });

  describe("moving into a collision, and across days", () => {
    let moveCollide;
    let moveDay;
    beforeAll(() => {
      moveCollide = runTool("move_block", { block: "Clarify review", start: "09:00" });
      moveDay = runTool("move_block", { block: "Clarify review", day: "tomorrow" });
    });

    it("a move into a collision is refused", () => expect(moveCollide.ok).toEqual(false));
    it("a cross-day move works", () => expect(moveDay.ok).toEqual(true));
    it("the block changed day", () => expect(store.getState().blocks.find((b) => b.title === "Clarify review").day).toEqual(addDays(today, 1)));
  });
});

/* ── tasks ─────────────────────────────────────────────────────────────────── */
describe("tasks", () => {
  let captured;

  beforeAll(() => {
    reset();
    captured = runTool("add_tasks", {
      tasks: [
        { title: "Send proposal", priority: "now", due: "today" },
        { title: "Reply to supplier", venture: "ZTS" },
        { title: "  " },
      ],
    });
  });

  it("bulk capture succeeded", () => expect(captured.ok).toEqual(true));
  it("empty titles are dropped", () => expect(store.getState().tasks.length).toEqual(2));
  it("priority survived", () => expect(store.getState().tasks[0].priority).toEqual("now"));
  it("due date was parsed", () => expect(store.getState().tasks[0].due).toEqual(today));
  it("unspecified priority defaults", () => expect(store.getState().tasks[1].priority).toEqual("normal"));

  describe("nothing usable", () => {
    let noTasks;
    beforeAll(() => { noTasks = runTool("add_tasks", { tasks: [{ title: "" }] }); });

    it("a capture with nothing usable is refused", () => expect(noTasks.ok).toEqual(false));
  });

  describe("closing a task", () => {
    let closed;
    let nothingToDo;
    beforeAll(() => {
      closed = runTool("update_task", { task: "Send proposal", status: "done" });
    });

    it("closing a task by title works", () => expect(closed.ok).toEqual(true));
    it("status changed", () => expect(store.getState().tasks.find((t) => t.title === "Send proposal").status).toEqual("done"));
    it("doneAt was stamped", () => expect(!!store.getState().tasks.find((t) => t.title === "Send proposal").doneAt).toBe(true));

    it("an update with no fields is refused", () => {
      nothingToDo = runTool("update_task", { task: "Reply to supplier" });
      expect(nothingToDo.ok).toEqual(false);
    });
  });
});

/* ── follow-ups ────────────────────────────────────────────────────────────── */
describe("follow-ups", () => {
  beforeAll(() => {
    reset();
    runTool("add_followup", { who: "Northside Dental", what: "Signed proposal", due: "+2d" });
  });

  it("follow-up created", () => expect(store.getState().followups.length).toEqual(1));
  it("chase date parsed", () => expect(store.getState().followups[0].due).toEqual(addDays(today, 2)));

  describe("resolving", () => {
    let resolved;
    beforeAll(() => { resolved = runTool("resolve_followup", { followup: "Northside", outcome: "Signed" }); });

    it("resolving by partial name works", () => expect(resolved.ok).toEqual(true));
    it("follow-up closed", () => expect(store.getState().followups[0].status).toEqual("closed"));
    it("resolving a closed follow-up is refused", () => expect(runTool("resolve_followup", { followup: "Northside" }).ok).toEqual(false));
  });
});

/* ── memory ────────────────────────────────────────────────────────────────── */
describe("memory", () => {
  beforeAll(() => {
    reset();
    runTool("remember", { fact: "The Northside retainer renews quarterly." });
  });

  it("fact stored", () => expect(store.getState().memory.length).toEqual(1));

  describe("duplicates and forgetting", () => {
    let dup;
    beforeAll(() => { dup = runTool("remember", { fact: "the northside retainer renews quarterly." }); });

    it("a duplicate fact is accepted without duplicating", () => expect(dup.ok).toEqual(true));
    it("memory did not grow", () => expect(store.getState().memory.length).toEqual(1));
    it("forgetting by partial text works", () => expect(runTool("forget", { memory: "Northside retainer" }).ok).toEqual(true));
    it("memory emptied", () => expect(store.getState().memory.length).toEqual(0));
    it("forgetting something absent is refused", () => expect(runTool("forget", { memory: "anything" }).ok).toEqual(false));
  });
});

/* ── focus: one at a time ──────────────────────────────────────────────────── */
describe("focus: one at a time", () => {
  beforeAll(() => { reset(); });

  it("focus starts", () => expect(runTool("start_focus", { label: "Proposal", mins: 50 }).ok).toEqual(true));
  it("focus is running", () => expect(!!store.getState().focus).toBe(true));

  describe("a second session", () => {
    let second;
    beforeAll(() => { second = runTool("start_focus", { label: "Something else" }); });

    it("a second focus session is refused", () => expect(second.ok).toEqual(false));
    it("refusal names the running session", () => expect(second.summary.includes("Proposal")).toBe(true));
    it("ending focus works", () => expect(runTool("end_focus", { outcome: "Sent it" }).ok).toEqual(true));
    it("focus cleared", () => expect(store.getState().focus).toEqual(null));
    it("the outcome became a note", () => expect(store.getState().notes.length).toEqual(1));
    it("ending when nothing runs is refused", () => expect(runTool("end_focus", {}).ok).toEqual(false));
  });
});

/* ── profile and directives ────────────────────────────────────────────────── */
describe("profile and directives", () => {
  let prof;

  beforeAll(() => {
    reset();
    prof = runTool("update_profile", { name: "Cameron", workStart: "07:30", addDirective: "Never book before 8am." });
  });

  it("profile update succeeded", () => expect(prof.ok).toEqual(true));
  it("name set", () => expect(store.getState().profile.name).toEqual("Cameron"));
  it("work start parsed", () => expect(store.getState().profile.workStart).toEqual(450));
  it("directive stored", () => expect(store.getState().profile.directives.length).toEqual(1));

  describe("duplicate and removal", () => {
    beforeAll(() => { runTool("update_profile", { addDirective: "never book before 8am." }); });

    it("a duplicate directive is not stored twice", () => expect(store.getState().profile.directives.length).toEqual(1));
    it("removing a directive works", () => expect(runTool("update_profile", { removeDirective: "Never book" }).ok).toEqual(true));
    it("directive removed", () => expect(store.getState().profile.directives.length).toEqual(0));
    it("an empty profile update is refused", () => expect(runTool("update_profile", {}).ok).toEqual(false));
    it("an unreadable work time is refused", () => expect(runTool("update_profile", { workEnd: "evening" }).ok).toEqual(false));
  });
});

/* ── read_state returns parseable JSON ─────────────────────────────────────── */
describe("read_state returns parseable JSON", () => {
  let read;
  let parsed;

  beforeAll(() => {
    reset();
    runTool("plan_day", { blocks: [{ title: "Deep work", start: "09:00", mins: 120 }] });
    runTool("add_tasks", { tasks: [{ title: "A thing" }] });
    read = runTool("read_state", { include: ["plan", "tasks", "followups", "memory"] });
    parsed = JSON.parse(read.result);
  });

  it("read_state succeeded", () => expect(read.ok).toEqual(true));
  it("read_state reports the plan", () => expect(parsed.plan.length).toEqual(1));
  it("read_state reports open tasks", () => expect(parsed.tasks.length).toEqual(1));
  it("read_state states the current time", () => expect(typeof parsed.now.time === "string").toBe(true));
  it("read_state does not touch the ledger", () => expect(store.getState().ledger.filter((e) => e.action === "read_state").length).toEqual(0));
});

/* ── search ────────────────────────────────────────────────────────────────── */
describe("search", () => {
  let found;
  let nothing;

  beforeAll(() => {
    runTool("capture_note", { text: "Supplier quoted 14 dollars a unit at 500." });
    found = JSON.parse(runTool("search_memory", { query: "supplier" }).result);
    nothing = JSON.parse(runTool("search_memory", { query: "zzzzz" }).result);
  });

  it("search finds the note", () => expect(found.notes.length).toEqual(1));
  it("search reports no matches honestly", () => expect(nothing.notes.length + nothing.tasks.length).toEqual(0));
  it("an empty search is refused", () => expect(runTool("search_memory", { query: "  " }).ok).toEqual(false));
});

/* ── gap analysis ──────────────────────────────────────────────────────────── */
describe("gap analysis", () => {
  let gaps;

  beforeAll(() => {
    store.set({
      blocks: [
        { id: "g1", day: today, start: 540, mins: 60, title: "A", status: "planned" },
        { id: "g2", day: today, start: 720, mins: 60, title: "B", status: "planned" },
      ],
    });
    gaps = describeGaps(store.getState(), today, 480, 1080);
  });

  it("three gaps around two blocks", () => expect(gaps.length).toEqual(3));
  it("first gap starts at the day start", () => expect(gaps[0].from).toEqual(fmtTime(480)));
  it("first gap is an hour", () => expect(gaps[0].mins).toEqual(60));
  it("middle gap spans the lunch hole", () => expect(gaps[1].mins).toEqual(120));
  it("last gap runs to the day end", () => expect(gaps[2].mins).toEqual(300));

  // Back-to-back blocks leave no gap between them.
  describe("back-to-back blocks", () => {
    let tight;

    beforeAll(() => {
      store.set({
        blocks: [
          { id: "h1", day: today, start: 540, mins: 60, title: "A", status: "planned" },
          { id: "h2", day: today, start: 600, mins: 60, title: "B", status: "planned" },
        ],
      });
      tight = describeGaps(store.getState(), today, 540, 660);
    });

    it("no gap between touching blocks", () => expect(tight.length).toEqual(0));
  });

  // A cancelled block doesn't hold time.
  describe("a cancelled block", () => {
    beforeAll(() => {
      store.set({ blocks: [{ id: "c1", day: today, start: 540, mins: 60, title: "A", status: "cancelled" }] });
    });

    it("cancelled blocks free their time", () => expect(describeGaps(store.getState(), today, 540, 600).length).toEqual(1));
  });
});
