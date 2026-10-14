// Real Node child + HTTP control boundary; only the native WB sidecar is replaced.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { isPidAlive } from "../../runtime/process";
import { jobRuntimeId, registerOwnedRuntime, markRuntimeSettled, reclaimOwnedRuntimes, eligibleRuntimeReceipts, ownsJobRuntime } from "../../providers/workbuddy-ai/runtime-lifecycle";

test("terminal private runtime is reaped through real control IPC; running, unknown and desktop processes survive", {timeout:30000}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"crewdispatch-runtime-ipc-"));
  const children=[0,1,2].map(()=>spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore",windowsHide:true}));
  for(const c of children)assert.ok(c.pid);
  const done={sessionId:jobRuntimeId(root,"job-done",0),runtimeId:"owned-instance",pid:children[0]!.pid!};
  const active={sessionId:jobRuntimeId(root,"job-running",0),runtimeId:"active-instance",pid:children[1]!.pid!};
  const desktop={sessionId:"desktop-user",runtimeId:"desktop-instance",pid:children[2]!.pid!};
  let listed=[done,active,desktop];const killed:string[]=[];
  registerOwnedRuntime(root,"job-done",0,done);markRuntimeSettled(root,done);
  registerOwnedRuntime(root,"job-running",0,active);
  const server=http.createServer((req,res)=>{let text="";req.on("data",b=>text+=b);req.on("end",async()=>{
    const message=JSON.parse(text);if(message.method==="session.kill"){
      assert.deepEqual(message.params,{sessionId:done.sessionId,expectedRuntimeId:done.runtimeId});killed.push(message.params.sessionId);
      const c=children[0]!;const exited=once(c,"close");c.kill();await exited;listed=listed.filter(r=>r.sessionId!==done.sessionId);
    }
    res.end(JSON.stringify(message.method==="session.list"?listed.map(({sessionId,pid})=>({sessionId,pid})):{})); // Real installed list omits nonce.
  });});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  const transport={async request(method:string,params?:unknown){const response=await fetch(url,{method:"POST",body:JSON.stringify({method,params})});return response.json();}};
  try{
    await reclaimOwnedRuntimes({dataRoot:root,terminalAttempts:[{jobId:"job-done",generation:0}]},transport);
    assert.deepEqual(killed,[done.sessionId]);assert.equal(isPidAlive(done.pid),false);
    assert.equal(isPidAlive(active.pid),true);assert.equal(isPidAlive(desktop.pid),true);
    assert.equal(eligibleRuntimeReceipts({dataRoot:root,terminalAttempts:[{jobId:"job-done",generation:0}]}).length,0);
    assert.equal(ownsJobRuntime(root,"job-done",0),true,"archived identity still binds cancellation after release");
    const archive=JSON.parse(fs.readFileSync(path.join(root,"provider-runtime/workbuddy-ai/history",done.sessionId+".json"),"utf8"));
    assert.equal(archive.released,true);assert.equal(archive.promptSettled,true);
    await reclaimOwnedRuntimes({dataRoot:root,terminalAttempts:[{jobId:"job-running",generation:0,turnResolved:false}]},transport);
    assert.deepEqual(killed,[done.sessionId],"unknown provider turn is never reaped");
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const c of children)if(c.exitCode==null&&c.signalCode==null){const exited=once(c,"close");c.kill();await exited;}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
