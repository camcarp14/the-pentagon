// Companion to scripts/toolrow-check.mjs, which owns the phone. This file owns
// the desktop, where the tools live in a left rail. Split that way because the
// two layouts are genuinely different components with different failure modes —
// the row could collapse to one column, the rail can be covered by a tool's own
// fixed furniture, and neither harness can see the other's bug.
//
//   npm run build && python3 -m http.server 4181 --directory apps/shell/dist
//   node scripts/rail-check.mjs
import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://127.0.0.1:4181";
const f = Math.floor(Date.now()/1000)+3600;
const session = { access_token:"t", token_type:"bearer", expires_in:3600, expires_at:f, refresh_token:"r",
  user:{ id:"00000000-0000-0000-0000-000000000001", aud:"authenticated", role:"authenticated", email:"stub@example.com", app_metadata:{}, user_metadata:{}, created_at:new Date(0).toISOString() } };
const ORDER = ["zts","clarify","runway","macro","looper","business","sync","ideas"];
const b = await chromium.launch({ executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage({ viewport:{width:1440,height:900} });
await p.addInitScript(([s,o])=>{ for(const k of ["sb-stub-auth-token","sb-localhost-auth-token"]) try{localStorage.setItem(k,JSON.stringify(s))}catch{}
  try{localStorage.setItem("cc_tab_prefs",JSON.stringify({order:o,hidden:[]}))}catch{} },[session,ORDER]);
await p.route("**/*",(r)=>{ const u=r.request().url();
  if(u.startsWith(BASE)) return r.continue();
  if(/\/rest\/v1\//i.test(u)) return r.fulfill({status:200,contentType:"application/json",body:"[]"});
  if(/\/auth\/v1\//i.test(u)) return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({user:session.user,session})});
  return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}); });
let bad=0; const fail=(m)=>{bad++;console.log("FAIL  "+m)}; const ok=(m)=>console.log("ok    "+m);
for (const tool of ORDER) {
  await p.goto(`${BASE}/#/${tool}`,{waitUntil:"networkidle",timeout:45000});
  await p.waitForTimeout(1200);
  for (const w of [1024,1440,1920]) {
    await p.setViewportSize({width:w,height:900}); await p.waitForTimeout(250);
    const m = await p.evaluate(() => {
      const nav=document.querySelector('nav[aria-label="Switch tool"]');
      const railEl=nav?nav.parentElement:null;
      const r=railEl?railEl.getBoundingClientRect():null;
      // does anything cover the rail's own buttons?
      let covered=0, tested=0;
      if(nav) for(const btn of nav.querySelectorAll("button")){
        const bb=btn.getBoundingClientRect(); if(bb.width<2) continue; tested++;
        const el=document.elementFromPoint(bb.left+bb.width/2, bb.top+bb.height/2);
        if(!el || !btn.contains(el) && el!==btn) covered++;
      }
      // fixed elements that start left of the rail's right edge
      const intruders=[];
      if(r) for(const el of document.querySelectorAll("*")){
        const cs=getComputedStyle(el); if(cs.position!=="fixed") continue;
        const eb=el.getBoundingClientRect();
        if(eb.width<4||eb.height<4) continue;
        if(railEl && (railEl===el||railEl.contains(el))) continue;
        if(eb.left < r.right - 1) intruders.push((el.className&&String(el.className).slice(0,28))||el.tagName);
      }
      return { railW: r?Math.round(r.width):0, railH:r?Math.round(r.height):0,
        shellRail: getComputedStyle(document.documentElement).getPropertyValue("--shell-rail").trim(),
        covered, tested, intruders: intruders.slice(0,6), nIntr: intruders.length,
        overflow: document.documentElement.scrollWidth - innerWidth };
    });
    const tag=`${tool}@${w}`;
    if(!m.railW) fail(`${tag}: no rail rendered`);
    else if(m.covered) fail(`${tag}: ${m.covered}/${m.tested} rail buttons covered by something`);
    else if(m.nIntr) fail(`${tag}: ${m.nIntr} fixed element(s) reach under the rail: ${m.intruders.join(", ")}`);
    else if(m.overflow>0) fail(`${tag}: page scrolls sideways ${m.overflow}px`);
    else if(parseInt(m.shellRail,10)!==m.railW) fail(`${tag}: --shell-rail ${m.shellRail} vs measured ${m.railW}px`);
    else ok(`${tag}: rail ${m.railW}x${m.railH}, --shell-rail ${m.shellRail}, ${m.tested} buttons clear, overflow 0`);
  }
}
// mobile: no rail, unchanged
await p.setViewportSize({width:393,height:852}); await p.goto(`${BASE}/#/zts`,{waitUntil:"networkidle"}); await p.waitForTimeout(900);
const mob = await p.evaluate(()=>({ rail: !!document.querySelector('nav[aria-label="Switch tool"]'),
  shellRail: getComputedStyle(document.documentElement).getPropertyValue("--shell-rail").trim(),
  toolrow: !!document.querySelector(".toolrow"), overflow: document.documentElement.scrollWidth-innerWidth }));
if(mob.rail) fail("393px: rail rendered on mobile"); else if(!mob.toolrow) fail("393px: toolrow missing on mobile");
else if(parseInt(mob.shellRail,10)!==0) fail(`393px: --shell-rail is ${mob.shellRail}, expected 0px`);
else if(mob.overflow>0) fail(`393px: overflow ${mob.overflow}px`); else ok(`393px: no rail, toolrow present, --shell-rail ${mob.shellRail}, overflow 0`);
await b.close();
console.log(bad===0?"\nrail: all checks passed":`\nrail: ${bad} check(s) failed`);
process.exit(bad===0?0:1);
