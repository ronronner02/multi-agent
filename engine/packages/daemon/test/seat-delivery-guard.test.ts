import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { SeatDeliveryGuard, type GuardTarget } from "../src/domain/seat-delivery-guard.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('a'),('b');");
  db.exec(outboxEntriesSchema.sql); db.exec(seatDeliveryGuardSchema.sql);
  const targets: Record<string, GuardTarget> = {
    a: { nodeId: "a", session: "a", occupant: "g1", pane: "%1" },
    b: { nodeId: "b", session: "b", occupant: "g2", pane: "%2" },
  };
  return { db, targets, guard: new SeatDeliveryGuard(db, name => Object.values(targets).find(t => t.nodeId === name || t.session === name || t.pane === name) ?? null), outbox: new OutboxHandler(db) };
}
function signal() { let release!: () => void; const ready = new Promise<void>(r => { release = r; }); return { ready, release }; }

describe("delivery pause and durable custody", () => {
  it("does not activate between paste/submit or before lifecycle finishes", async () => {
    const { db, guard } = fixture(); const pasted = signal(); const finish = signal(); const writes: string[] = [];
    const running = guard.operation("a", async () => {
      await guard.input("a", async () => { writes.push("paste"); }); pasted.release(); await finish.ready;
      await guard.input("a", async () => { writes.push("submit"); }); writes.push("lifecycle complete");
    });
    await pasted.ready;
    const pending = await guard.set("a", true, "actor", "protect draft", 1);
    expect(pending).toMatchObject({ desired: true, effective: false, pending: true });
    finish.release(); await running; await new Promise(r => setTimeout(r, 0));
    expect(writes).toEqual(["paste", "submit", "lifecycle complete"]);
    expect(guard.preference("a")).toMatchObject({ effective: true, pending: false });
    await expect(guard.input("a", async () => { writes.push("bad"); })).rejects.toMatchObject({ code: "typing_guard_enabled" });
    db.close();
  });
  it("service-level strict pause permits only explicit human input and sibling", async () => {
    const { db, guard } = fixture(); await guard.set("a", true, "actor", "draft"); const writes: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(guard.input("a", async () => { writes.push("automated"); })).rejects.toMatchObject({ code: "typing_guard_enabled" });
    }
    await guard.humanInput("a", () => guard.input("a", async () => { writes.push("human"); }));
    await guard.input("b", async () => { writes.push("sibling"); });
    expect(writes).toEqual(["human", "sibling"]);
    await guard.set("a", false, "actor", "resume new delivery");
    await guard.input("a", async () => { writes.push("off"); }); expect(writes.at(-1)).toBe("off"); db.close();
  });
  it("refuses stale occupants, unknown identity and escaped lease writes", async () => {
    const { db, guard, targets } = fixture();
    await guard.operation("a", async () => {
      targets.a = { ...targets.a!, occupant: "replacement" };
      await expect(guard.input("a", async () => {})).rejects.toMatchObject({ code: "guard_target_changed" });
    });
    await expect(guard.input("unknown", async () => {})).rejects.toMatchObject({ code: "guard_target_unknown" });
    const go=signal(); let detached!: Promise<void>;
    await guard.operation("a", async () => { detached = go.ready.then(() => guard.input("a", async () => {})); });
    await guard.set("a", true, "actor", "pause");go.release();
    await expect(detached).rejects.toMatchObject({ code: "typing_guard_enabled" }); db.close();
  });
  it("retains one ID; detects mismatch; retirement frees quota without deleting evidence", () => {
    const { db, targets, outbox } = fixture(); const input = { outboxId: "id", senderSession: "sender", destinationSession: "a", body: "draft-safe" };
    expect(outbox.retain(input, targets.a!).deliveryState).toBe("retained");
    expect(outbox.retain(input, targets.a!).outboxId).toBe("id");
    expect(() => outbox.retain({ ...input, body: "different" }, targets.a!)).toThrow("different content");
    expect(outbox.markDelivered("id").deliveryState).toBe("retained");
    expect(outbox.retire("id", "person", "read outside pane")).toMatchObject({ deliveryState: "retired", deliveredAt: null, body: "draft-safe", retiredBy: "person" });
    expect(outbox.heldForNode("a").total).toBe(0);
    expect(outbox.listPending("id")).toEqual([]); db.close();
  });
  it("rolls back rejected staging but retains committed overflow members with original bodies", () => {
    const { db, targets, outbox } = fixture();
    for(let i=0;i<100;i++) outbox.retain({ outboxId: `h${i}`, senderSession: "s", destinationSession:"a", body:`body${i}` },targets.a!);
    const next={outboxId:"next",senderSession:"s",destinationSession:"a",body:"new"};
    expect(() => db.transaction(() => { outbox.retain(next,targets.a!); })()).toThrow("quota");
    expect(outbox.getById("next")).toBeNull();
    for(const id of ["committed1","committed2"]) { outbox.record({...next,outboxId:id,body:id});outbox.claimForDelivery(id);outbox.retain({...next,outboxId:id,body:id},targets.a!,true); }
    expect(outbox.heldForNode("a",100).total).toBe(102);expect(outbox.heldForNode("a",100).truncated).toBe(true);
    expect(outbox.getById("committed2")!.body).toBe("committed2");
    outbox.retire("h0","person","ack");outbox.retire("h1","person","ack");outbox.retire("h2","person","ack");
    expect(outbox.retain(next,targets.a!).deliveryState).toBe("retained");db.close();
  });
  it("guard DB failure cannot fall through to input; crash activation honors desired", async () => {
    const { db, guard } = fixture(); let writes=0;
    db.prepare("INSERT INTO seat_delivery_guards VALUES ('a',1,0,'actor','crash','now')").run();
    guard.recoverActivation();expect(guard.preference("a")).toMatchObject({desired:true,effective:true});
    db.exec("DROP TABLE seat_delivery_guards");await expect(guard.input("a", async () => {writes++;})).rejects.toThrow();
    expect(writes).toBe(0);db.close();
  });
});

function transportFixture() {
  const f = fixture();
  const commands: string[] = [];
  const files: string[] = [];
  const tmux = new TmuxAdapter(async command => { commands.push(command); return ""; }, {
    writeFile: async (_path, text) => { files.push(text); }, unlink: async () => {},
    tmpName: () => "/inert/launch", bufferName: () => "inert-buffer",
  });
  tmux.deliveryGuard = f.guard;
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => {
    const target = f.guard.maybeTarget(name);
    return target?.pane ? [{ id: target.pane } as never] : [];
  });
  const transport = new SessionTransport({ db: f.db, tmuxAdapter: tmux, rigRepo: {} as never, sessionRegistry: {} as never, sleep: async () => {} });
  return { ...f, tmux, transport, commands, files };
}

describe("real adapter/transport guard boundaries with no external effects", () => {
  it("retains raw/force/verify/danger sends without even capturing or writing; submit-only refuses", async () => {
    const f = transportFixture(); await f.guard.set("a", true, "person", "draft");
    for (const options of [{}, {force:true}, {verify:true}, {dangerouslyInteract:true,reason:"explicit"}, {waitForIdleMs:10}]) {
      const result = await f.transport.send("a", "message", options);
      expect(result).toMatchObject({ok:true,outcome:"retained",sent:false,verified:false});
      expect(result.outboxIds).toHaveLength(1);
    }
    expect(await f.transport.send("a", "", {submitOnly:true,expectedStagedText:"message"})).toMatchObject({ok:false,reason:"typing_guard_enabled",sent:false});
    expect(f.commands).toEqual([]);expect(f.files).toEqual([]);expect(f.tmux.listPanes).not.toHaveBeenCalled();
    expect(f.outbox.heldForNode("a").total).toBe(5);f.db.close();
  });
  it("one retained ID stays not-delivered after disable/retirement, and preserves committed coalesced IDs", async () => {
    const f = transportFixture();await f.guard.set("a",true,"person","draft");
    const opts={deliveryId:"exact",actorSession:"sender"};
    await f.transport.send("a","body",opts);await f.transport.send("a","body",opts);
    expect(f.outbox.heldForNode("a").total).toBe(1);
    expect(await f.transport.send("a","changed",opts)).toMatchObject({ok:false,reason:"delivery_identity_conflict"});
    for (const id of ["wake1","wake2"]) { f.outbox.record({outboxId:id,senderSession:"sender",destinationSession:"a",body:`original ${id}`});f.outbox.claimForDelivery(id); }
    expect(await f.transport.send("a","combined",{committedOutboxIds:["wake1","wake2"]})).toMatchObject({outcome:"retained",outboxIds:["wake1","wake2"]});
    expect(f.outbox.getById("wake2")!.body).toBe("original wake2");
    await f.guard.set("a",false,"person","new sends only");f.outbox.retire("exact","person","acknowledge");
    expect(await f.transport.send("a","body",opts)).toMatchObject({outcome:"retained",sent:false});
    expect(f.commands).toEqual([]);expect(f.db.prepare("SELECT count(*) AS n FROM outbox_entries").get()).toEqual({n:3});f.db.close();
  });
  it("automatic low-level keys/text/shell and lifecycle creation refuse, human broker path and sibling write", async () => {
    const f=transportFixture();await f.guard.set("a",true,"person","draft");
    expect(await f.tmux.sendText("a","automatic")).toMatchObject({ok:false,code:"typing_guard_enabled"});
    expect(await f.tmux.sendKeys("%1",["Enter"])).toMatchObject({ok:false,code:"typing_guard_enabled"});
    expect(await f.tmux.sendShellCommand("a","command")).toMatchObject({ok:false,code:"typing_guard_enabled"});
    expect(await f.tmux.createSession("a",undefined,{OPENRIG_NODE_ID:"a"})).toMatchObject({ok:false,code:"guard_lease_required"});
    expect(f.commands).toEqual([]);
    expect(await f.tmux.humanInput("a",()=>f.tmux.sendKeys("a",["x"]))).toEqual({ok:true});
    expect(await f.tmux.sendKeys("b",["Enter"])).toEqual({ok:true});
    expect(f.commands).toHaveLength(2);expect(f.commands[0]).toContain("%1");expect(f.commands[1]).toContain("%2");f.db.close();
  });
  it("checks actual pane identity after asynchronous observation and refuses replacement/unknown targets", async () => {
    const f=transportFixture();
    vi.mocked(f.tmux.listPanes).mockResolvedValue([{id:"%replacement"} as never]);
    expect(await f.tmux.sendText("a","bad")).toMatchObject({ok:false,code:"guard_target_unknown"});
    expect(await f.tmux.sendKeys("unknown",["Enter"])).toMatchObject({ok:false,code:"guard_target_unknown"});
    vi.mocked(f.tmux.listPanes).mockImplementation(async () => { f.targets.a={...f.targets.a!,occupant:"other"};return [{id:"%1"} as never]; });
    expect(await f.tmux.sendKeys("a",["Enter"])).toMatchObject({ok:false,code:"guard_target_changed"});
    expect(f.commands).toEqual([]);expect(f.files).toEqual([]);f.db.close();
  });
  it("whole multi-node lifecycle keeps activation pending through rebind and final submit", async () => {
    const f=transportFixture();const started=signal(),finish=signal();
    const work=f.guard.lifecycle(["b","a"],async()=>{
      started.release();await finish.ready;
      f.targets.a={...f.targets.a!,occupant:"new",pane:"%3"};f.guard.rebindLifecycle("a");
      await f.guard.lifecycle(["a"],async()=>{expect(await f.tmux.sendKeys("a",["Enter"])).toEqual({ok:true});});
    });
    await started.ready;expect(await f.guard.set("a",true,"person","draft",1)).toMatchObject({pending:true,effective:false});
    finish.release();await work;await new Promise(r=>setTimeout(r,0));
    expect(f.guard.preference("a").effective).toBe(true);expect(f.commands).toHaveLength(1);expect(f.commands[0]).toContain("%3");f.db.close();
  });
  it("private probe exemption requires fresh allocation, never an existing managed or recycled pane", async () => {
    const f=transportFixture();await f.guard.set("a",true,"person","draft");
    expect(await f.tmux.createProbeSession("a")).toMatchObject({ok:false,code:"guard_target_managed"});
    expect(f.commands).toEqual([]);
    vi.mocked(f.tmux.listPanes).mockResolvedValue([{id:"%probe"} as never]);
    expect(await f.tmux.createProbeSession("private-probe")).toEqual({ok:true});
    expect(await f.tmux.sendKeys("private-probe",["Enter"])).toEqual({ok:true});
    const count=f.commands.length;
    vi.mocked(f.tmux.listPanes).mockResolvedValue([{id:"%recycled"} as never]);
    expect(await f.tmux.sendText("private-probe","bad")).toMatchObject({ok:false});
    expect(await f.tmux.killSession("private-probe")).toMatchObject({ok:false});
    expect(f.commands).toHaveLength(count);f.db.close();
  });
});

function queueFixture() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','rig','worker'),('b','rig','sibling');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');`);
  const guard = new SeatDeliveryGuard(db, name=>resolveGuardTarget(db,name));
  const writes:string[]=[];
  const tmux = new TmuxAdapter(async command=>{writes.push(command);return "";}); tmux.deliveryGuard=guard;
  const rigRepo=new RigRepository(db), sessionRegistry=new SessionRegistry(db);
  db.exec("INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');");
  vi.spyOn(tmux,"probeSession").mockResolvedValue({state:"present"});
  vi.spyOn(tmux,"getPaneCommand").mockResolvedValue("bash");
  vi.spyOn(tmux,"listPanes").mockImplementation(async name=>[{id:guard.target(name).pane!} as never]);
  const transport=new SessionTransport({db,tmuxAdapter:tmux,rigRepo,sessionRegistry,sleep:async()=>{}});
  const bus=new EventBus(db), outbox=new OutboxHandler(db);
  const repo=new QueueRepository(db,bus,{validateRig:()=>true,transport,loadHumanRegistry:()=>({ok:true,entities:[],warnings:[]})});
  repo.attachOutbox(outbox);
  return {db,guard,transport,outbox,bus,repo,writes,tmux,rigRepo,sessionRegistry};
}

describe("real queue transaction and retained delivery",()=>{
  async function createWithFullHeldQuota() {
    const f=queueFixture();
    try {
      await f.guard.set("a",true,"person","draft");
      for(let i=0;i<100;i++) f.outbox.retain({outboxId:`full${i}`,senderSession:"sender@test",destinationSession:"worker@test",body:"held"},f.guard.target("a"));
      const row=await f.repo.create({sourceSession:"sender@test",destinationSession:"worker@test",body:"keep this task"});
      expect(f.repo.getById(row.qitemId)!.body).toBe("keep this task");
      expect(row.lastNudgeResult).toMatch(/^failed:.*quota/i);
      expect(f.db.prepare("SELECT count(*) n FROM queue_items").get()).toEqual({n:1});
      expect(f.outbox.heldForNode("a").total).toBe(100);
      expect(f.outbox.getById(`wake-intent-${row.qitemId}`)).toBeNull();
      expect(f.writes).toEqual([]);
      return row;
    } finally { f.db.close(); }
  }
  it("ordinary create survives full held quota without bypassing retention limits",async()=>{
    await createWithFullHeldQuota();
  });
  it("ordinary create full-quota receipt names the unretained wake",async()=>{
    const row=await createWithFullHeldQuota();
    expect(row.lastNudgeResult).toContain("wake not retained");
  });
  it("precommit quota refusal rolls back closure, successor, transitions and events",async()=>{
    const f=queueFixture();const source=await f.repo.create({sourceSession:"sender@test",destinationSession:"relay@test",body:"work",nudge:false});
    await f.guard.set("a",true,"person","draft");
    for(let i=0;i<100;i++) f.outbox.retain({outboxId:`full${i}`,senderSession:"sender@test",destinationSession:"worker@test",body:"held"},f.guard.target("a"));
    const before=JSON.stringify(f.db.prepare("SELECT * FROM queue_transitions").all());
    const events=JSON.stringify(f.db.prepare("SELECT * FROM events").all());
    await expect(f.repo.handoff({qitemId:source.qitemId,fromSession:"relay@test",toSession:"worker@test"})).rejects.toThrow("quota");
    expect(f.repo.getById(source.qitemId)!.state).toBe("pending");
    expect(f.db.prepare("SELECT count(*) n FROM queue_items").get()).toEqual({n:1});
    expect(JSON.stringify(f.db.prepare("SELECT * FROM queue_transitions").all())).toBe(before);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM events").all())).toBe(events);
    expect(f.writes).toEqual([]);f.db.close();
  });
  it("handoff retains one audited intent without duplicate transport record or delivered label",async()=>{
    const f=queueFixture();const source=await f.repo.create({sourceSession:"sender@test",destinationSession:"relay@test",body:"work",nudge:false});
    await f.guard.set("a",true,"person","draft");
    const {created,closed}=await f.repo.handoff({qitemId:source.qitemId,fromSession:"relay@test",toSession:"worker@test"});
    expect(closed.state).toBe("handed-off");expect(created.state).toBe("pending");
    await vi.waitFor(()=>expect(f.repo.getById(created.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    const held=f.outbox.heldForNode("a");expect(held.total).toBe(1);
    expect(held.items[0]).toMatchObject({outboxId:`wake-intent-${created.qitemId}`,auditPointer:created.qitemId,deliveryState:"retained",deliveredAt:null,guardBinding:{nodeId:"a",occupant:"g1",pane:"%1"}});
    expect(held.items[0]!.body).toContain(created.qitemId);
    await f.repo.deliverWakeForSuccessor(created.qitemId,"worker@test",true,"relay@test");
    await f.guard.set("a",false,"person","new sends");
    expect(await f.repo.drainPendingWakeIntents()).toEqual({delivered:0,indeterminate:0,failed:0,retained:0});
    f.outbox.retire(held.items[0]!.outboxId,"person","read");
    expect(f.repo.getById(created.qitemId)!.state).toBe("pending");expect(f.writes).toEqual([]);f.db.close();
  });
  it("postcommit activation retains exact staged intent beyond quota, without fictional rollback",async()=>{
    const f=queueFixture();const source=await f.repo.create({sourceSession:"sender@test",destinationSession:"relay@test",body:"work",nudge:false});
    for(let i=0;i<100;i++) f.outbox.retain({outboxId:`full${i}`,senderSession:"sender@test",destinationSession:"worker@test",body:"held"},f.guard.target("a"));
    let activation:Promise<unknown>|undefined;
    const off=f.bus.subscribe(event=>{if(event.type==="queue.handed_off") activation=f.guard.set("a",true,"person","postcommit");});
    const {created,closed}=await f.repo.handoff({qitemId:source.qitemId,fromSession:"relay@test",toSession:"worker@test"});
    await activation;off();expect(closed.state).toBe("handed-off");
    await vi.waitFor(()=>expect(f.repo.getById(created.qitemId)!.lastNudgeResult).toBe("retained:typing_guard"));
    expect(f.outbox.heldForNode("a").total).toBe(101);expect(f.outbox.getById(`wake-intent-${created.qitemId}`)!.body).toContain(created.qitemId);
    expect(f.writes).toEqual([]);f.db.close();
  });
  it("pending coalesced members retain individual frozen bodies and refuse a changed occupant",async()=>{
    const f=queueFixture();const ids:string[]=[];
    for(let i=0;i<2;i++) {
      const item=await f.repo.create({sourceSession:"sender@test",destinationSession:"worker@test",body:`work${i}`,nudge:false});
      f.repo.stageWakeIntent(item.qitemId,"sender@test","worker@test",null,true);ids.push(`wake-intent-${item.qitemId}`);
      f.db.prepare("UPDATE outbox_entries SET tags=? WHERE outbox_id=?").run(JSON.stringify(["queue:return:common"]),ids[i]);
    }
    const bodies=ids.map(id=>f.outbox.getById(id)!.body);
    await f.guard.set("a",true,"person","pause");await f.repo.drainPendingWakeIntents();
    for(let i=0;i<2;i++) expect(f.outbox.getById(ids[i]!)!).toMatchObject({body:bodies[i],deliveryState:"retained",deliveredAt:null});
    expect(f.outbox.heldForNode("a").total).toBe(2);expect(f.writes).toEqual([]);
    const item=await f.repo.create({sourceSession:"sender@test",destinationSession:"sibling@test",body:"old generation",nudge:false});
    f.repo.stageWakeIntent(item.qitemId,"sender@test","sibling@test",null,true);
    f.db.prepare("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('gb2','b',2,'new','fresh')").run();
    await f.repo.drainPendingWakeIntents();
    expect(f.outbox.getById(`wake-intent-${item.qitemId}`)!.deliveryState).toBe("failed");
    expect(f.repo.getById(item.qitemId)!.lastNudgeResult).toContain("identity changed");expect(f.writes).toEqual([]);f.db.close();
  });
});
