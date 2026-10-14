import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobRuntimeId, disposeOwnedRuntime, registerOwnedRuntime, markRuntimeSettled, eligibleRuntimeReceipts, releaseRegisteredRuntime, ownsJobRuntime } from "../../providers/workbuddy-ai/runtime-lifecycle";
import { maintainProviderResources } from "../../jobs/provider-maintenance";
import { createJobRecord } from "../../jobs/service";
import { saveJob } from "../../jobs/store";
import { createWorkBuddyAiAdapter } from "../../providers/workbuddy-ai/index";
import type { ProviderResourceMaintenanceInput } from "../../providers/provider";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-runtime-unit-"));

test("runtime ownership separates attempts, jobs and independent data roots", () => {
  const a=jobRuntimeId("C:/root", "job-a", 0);
  assert.notEqual(a,jobRuntimeId("C:/root", "job-a",1));
  assert.notEqual(a,jobRuntimeId("C:/root", "job-b",0));
  assert.notEqual(a,jobRuntimeId("C:/other", "job-a",0));
  assert.throws(()=>jobRuntimeId("C:/root", "../foreign",0));
});

test("runtime data-root identity lowercases only on Windows", () => {
  assert.equal(
    jobRuntimeId("/tmp/CaseSensitiveRoot", "job-a", 0, "win32"),
    jobRuntimeId("/tmp/casesensitiveroot", "job-a", 0, "win32")
  );
  assert.notEqual(
    jobRuntimeId("/tmp/CaseSensitiveRoot", "job-a", 0, "darwin"),
    jobRuntimeId("/tmp/casesensitiveroot", "job-a", 0, "darwin")
  );
});

test("native disposal targets only a matching opaque runtime identity and confirms OS exit", async () => {
  const own={sessionId:"owned",runtimeId:"instance-a",pid:123};
  const other={sessionId:"desktop",runtimeId:"instance-b",pid:124};
  let rows=[own,other];const calls:string[]=[];
  const t={async request(method:string,params?:unknown){calls.push(method);if(method==="session.kill"){assert.deepEqual(params,{sessionId:"owned",expectedRuntimeId:"instance-a"});rows=[other];return{};}return rows;}};
  assert.equal(await disposeOwnedRuntime(t,own,()=>false),true);
  assert.deepEqual(rows,[other]);assert.deepEqual(calls,["session.list","session.kill","session.list"]);
});

test("a changed native instance or PID is never signalled", async () => {
  for (const change of [{runtimeId:"new-instance"},{pid:222}]) {
    const own={sessionId:"owned",runtimeId:"old-instance",pid:123};let kills=0;
    const t={async request(method:string){if(method==="session.kill")kills++;return[{...own,...change}];}};
    assert.equal(await disposeOwnedRuntime(t,own,()=>false),false);assert.equal(kills,0);
  }
});

test("removed from registry but OS liveness unknown is not a confirmed release", async () => {
  const t={async request(){return[];}};
  assert.equal(await disposeOwnedRuntime(t,{sessionId:"own",runtimeId:"i",pid:123},()=>null),false);
});

test("only recorded terminal attempts are eligible; unknown and legacy slots remain protected", () => {
  const root=temp();try{
    const runtime={sessionId:jobRuntimeId(root,"job-a",0),runtimeId:"opaque",pid:123};
    registerOwnedRuntime(root,"job-a",0,runtime);
    assert.equal(ownsJobRuntime(root,"job-a",0),true);
    assert.equal(eligibleRuntimeReceipts({dataRoot:root,terminalAttempts:[{jobId:"job-a",generation:0,turnResolved:false}]}).length,0);
    markRuntimeSettled(root,runtime);
    assert.equal(eligibleRuntimeReceipts({dataRoot:root,terminalAttempts:[]}).length,0);
    assert.equal(eligibleRuntimeReceipts({dataRoot:root,terminalAttempts:[{jobId:"job-a",generation:1}]}).length,0);
    assert.equal(eligibleRuntimeReceipts({dataRoot:root,terminalAttempts:[{jobId:"job-a",generation:0}]}).length,1);
    assert.throws(()=>registerOwnedRuntime(root,"job-a",0,{...runtime,sessionId:"jobquay-host-v2-legacy"}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("cleanup failures retain ownership and stop after three native attempts", async () => {
  const root=temp();try{
    const runtime={sessionId:jobRuntimeId(root,"job-a",0),runtimeId:"opaque",pid:123};registerOwnedRuntime(root,"job-a",0,runtime);
    let calls=0;const t={async request(){calls++;throw Error("native unavailable");}};
    for(let i=0;i<4;i++)assert.equal(await releaseRegisteredRuntime(root,t,runtime),false);
    assert.equal(calls,3);assert.equal(eligibleRuntimeReceipts({dataRoot:root,terminalAttempts:[{jobId:"job-a",generation:0}]}).length,0);
    assert.equal(ownsJobRuntime(root,"job-a",0),true);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("generic maintenance excludes nonterminal, retained-child and unresolved provider turns", async () => {
  const root=temp();try{
    const done=createJobRecord({task:"fixture",cwd:root,provider:"workbuddy-ai"});done.status="done";done.finishedAt=new Date().toISOString();saveJob(root,done);
    const running=createJobRecord({task:"running",cwd:root,provider:"workbuddy-ai"});running.status="running";saveJob(root,running);
    const held=createJobRecord({task:"held",cwd:root,provider:"workbuddy-ai"});held.status="done";held.childPid=123;saveJob(root,held);
    const orphan=createJobRecord({task:"orphan",cwd:root,provider:"workbuddy-ai"});orphan.status="orphaned";saveJob(root,orphan);
    const calls:ProviderResourceMaintenanceInput[]=[];
    const adapter={...createWorkBuddyAiAdapter({platform:"linux"}),async maintainResources(input:ProviderResourceMaintenanceInput){calls.push(input);}};
    await maintainProviderResources(root,[adapter]);assert.equal(calls.length,1);assert.deepEqual(calls[0]!.terminalAttempts,[{jobId:done.id,generation:0,turnResolved:true}]);
    fs.writeFileSync(path.join(root,"jobs","unknown.json"),"not json");await maintainProviderResources(root,[adapter]);assert.equal(calls.length,1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test("terminal with an established unresolved turn needs native prompt settlement before reclaim", { skip: process.platform === "win32" || process.platform === "darwin" ? false : "WorkBuddy Desktop route owns native out-of-tree runtimes only on Windows/macOS" }, async () => {
  const root = temp();
  try {
    const done = createJobRecord({ task: "fixture", cwd: root, provider: "workbuddy-ai" });
    done.status = "done";
    done.finishedAt = new Date().toISOString();
    done.sessionId = "native-session";
    saveJob(root, done);
    const runtime = { sessionId: jobRuntimeId(root, done.id, 0), runtimeId: "opaque", pid: 123 };
    registerOwnedRuntime(root, done.id, 0, runtime);
    const inputs: ProviderResourceMaintenanceInput[] = [];
    const adapter = { ...createWorkBuddyAiAdapter({ platform: "linux" }),
      async maintainResources(input: ProviderResourceMaintenanceInput) { inputs.push(input); } };
    await maintainProviderResources(root, [adapter]);
    assert.equal(inputs[0]!.terminalAttempts[0]!.turnResolved, false);
    assert.equal(eligibleRuntimeReceipts(inputs[0]!).length, 0);
    markRuntimeSettled(root, runtime);
    assert.equal(eligibleRuntimeReceipts(inputs[0]!).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("private runtime attribution survives disposal during the original-connection cancel acknowledgment", async () => {
  const { TurnCancelChannel } = await import("../../providers/workbuddy-ai/cancel-channel");
  const { cancelWorkBuddyTurn } = await import("../../providers/workbuddy-ai/turn-cancel");
  const root = temp();
  const runtime = { sessionId: jobRuntimeId(root, "job-race", 0), runtimeId: "opaque", pid: 123 };
  registerOwnedRuntime(root, "job-race", 0, runtime);
  const channel = new TurnCancelChannel({ provider: "workbuddy-ai", jobId: "job-race", generation: 0,
    sessionId: "acp-race", dataRoot: root }, { pollMs: 10 });
  let delivered = 0;
  const stop = channel.watch(async () => {
    delivered++;
    // Replace ONLY the native disposal boundary: it removes the active receipt
    // before the real production watcher publishes the cancellation acknowledgment.
    const active = path.join(root, "provider-runtime", "workbuddy-ai", runtime.sessionId + ".json");
    const history = path.join(path.dirname(active), "history");
    fs.mkdirSync(history);
    fs.renameSync(active, path.join(history, path.basename(active)));
  });
  try {
    const result = await cancelWorkBuddyTurn({ provider: "workbuddy-ai", jobId: "job-race", generation: 0,
      sessionId: "acp-race", cwd: root, model: "fixture", permissionMode: "default", effort: null,
      cliPath: "C:/wb/cli", childPid: process.pid, attemptStartedAtMs: Date.now(), dataRoot: root },
      { cancelAckWaitMs: 2_000, transport: { async request() { throw Error("No sidecar request expected"); }, close() {} } });
    assert.equal(delivered, 1);
    assert.equal(result.requested, true);
    assert.deepEqual(result.ownedRoots, [runtime.pid]);
    assert.equal(result.slotKey, runtime.sessionId);
    assert.equal(result.ownershipUnknown, false);
    assert.equal(ownsJobRuntime(root, "job-race", 0), true);
  } finally { stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
