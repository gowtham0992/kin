// Isolated visual fixture: synthetic browser push boundary, no AWS or messages.
import express from "express";
import { readFile } from "node:fs/promises";
const app = express();
const port = Number(process.argv[2] ?? 3069);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");
for (const asset of ["styles.css", "invite.css", "workspace.css", "push-controls.js"]) {
  app.get(`/${asset}`, async (_request, response) => {
    response.set("cache-control", "no-store").type(asset.endsWith("css") ? "css" : "js").send(await readFile(new URL(`../simulator/${asset}`, import.meta.url), "utf8"));
  });
}
app.get("/", (_request, response) => response.type("html").send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kin synthetic phone settings</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/invite.css"><link rel="stylesheet" href="/workspace.css">
<body class="workspace-page"><main class="invite-page"><h1>Phone settings preview</h1><p>Synthetic only. No phone permissions, subscriptions or messages leave this page.</p>
<label for="scenario">Preview state</label><select id="scenario"><option value="none">No phone connected</option><option value="saved">Connected and on duty</option><option value="mismatch">Different saved phone</option><option value="denied">Browser permission denied</option><option value="offline">Connection check unavailable</option><option value="uncertain">Save response lost</option></select>
<section id="push" class="kin-trust-link" aria-label="Notification settings"></section>
<script type="module">
import { createPushControls } from '/push-controls.js';
let mode='none', local=null, saved=false;
const subscription={endpoint:'https://example.invalid/synthetic',toJSON:()=>({endpoint:subscription.endpoint,keys:{p256dh:'synthetic',auth:'synthetic'}}),unsubscribe:async()=>{local=null;return true;}};
const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([subscription.endpoint,'synthetic','synthetic'])));
const id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
const notification={permission:'default',requestPermission:async()=>notification.permission=mode==='denied'?'denied':'granted'};
Object.defineProperty(window,'Notification',{value:notification});Object.defineProperty(window,'PushManager',{value:{}});
Object.defineProperty(navigator,'serviceWorker',{value:{ready:Promise.resolve({pushManager:{getSubscription:async()=>local,subscribe:async()=>local=subscription}})}});
const controls=createPushControls({container:document.getElementById('push'),request:async(_url,options)=>{
 if(mode==='offline')throw Error('synthetic unavailable');
 if(options.method==='POST'){saved=true;if(mode==='uncertain')throw Error('synthetic response lost');}
 if(options.method==='DELETE')saved=false;
 return {ok:true,json:async()=>({enrollment:{state:saved?'saved':'none',id:saved?(mode==='mismatch'?'a'.repeat(64):id):null},duty:{assigned:mode==='saved',onDuty:mode==='saved'}})};
}});
async function show(){mode=document.getElementById('scenario').value;local=['saved','mismatch'].includes(mode)?subscription:null;saved=!!local;notification.permission=mode==='denied'?'denied':saved?'granted':'default';await controls.open({publicKey:btoa('x'.repeat(65)),consentVersion:'synthetic'});document.querySelector('details').open=true;}
document.getElementById('scenario').addEventListener('change',show);await show();
</script></main></body></html>`));
app.listen(port, "127.0.0.1", (error?: Error) => {
  if (error) throw error;
  console.log(`Synthetic notification preview: http://127.0.0.1:${port}`);
});
