// Synthetic browser interaction only; no AWS, login, or notification calls.
import {readFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from 'playwright/test';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const assets=new Map(await Promise.all(['roster-editor.js','styles.css','invite.css','workspace.css'].map(async name=>[name,await readFile(new URL(`../simulator/${name}`,import.meta.url),'utf8')])));
 await page.route('https://kin.test/**',route=>{
  const name=new URL(route.request().url()).pathname.slice(1);
  if(assets.has(name))return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':'text/css',body:assets.get(name)});
  if(name)return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/invite.css"><link rel="stylesheet" href="/workspace.css"><body class="workspace-page"><main class="invite-page"><section id="workspace"><div id="workspace-content"><div id="app"></div></div></section></main>'});
 });
 await page.goto('https://kin.test/');
 await page.evaluate(async()=>{
  const {createRosterDraft,renderRosterEditor}=await import('/roster-editor.js');
  window.saved=[];const draft=createRosterDraft();
  const editor=renderRosterEditor({data:{limit:50,members:[{id:'person-synthetic',name:'Gowtham',relationship:'caregiver',canReceiveAlerts:false,canRename:true,canConnectSelf:true},{id:'joined-synthetic',name:'Robin',relationship:'caregiver',canReceiveAlerts:false,canRename:false,canEnableDuty:true}]},draft,isLocked:()=>false,onMessage:()=>{},onSave:async body=>{window.saved.push(body);editor.clear();}});
  document.getElementById('app').append(editor.element);
 });
 await mkdir('/tmp/kin-roster-layout',{recursive:true});
 for(const width of [320,375,390,574,620,768,1280]){
  await page.setViewportSize({width,height:900});
  const row=page.locator('.circle-people-list li').first();
  const rowBounds=await row.boundingBox();
  const details=await row.locator(':scope > div').boundingBox();
  const heading=await row.locator('h4').boundingBox();
  expect(heading.height,`Name wraps at ${width}px`).toBeLessThan(30);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}px`).toBe(true);
  for(const b of await row.getByRole('button').all()){
   const bounds=await b.boundingBox();expect(bounds.width).toBeGreaterThanOrEqual(44);expect(bounds.height).toBeGreaterThanOrEqual(44);
   expect(bounds.x,`Action clips left at ${width}px`).toBeGreaterThanOrEqual(rowBounds.x-1);
   expect(bounds.x+bounds.width,`Action clips right at ${width}px`).toBeLessThanOrEqual(rowBounds.x+rowBounds.width+1);
   if(width<=620)expect(bounds.y,`Action crowds the name at ${width}px`).toBeGreaterThanOrEqual(details.y+details.height);
  }
  if([375,768,1280].includes(width))await page.screenshot({path:`/tmp/kin-roster-layout/${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Connect to my account',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm account connection',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>window.saved.length)).toBe(0);
 await page.locator('#roster-editor-review').getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.locator('#roster-editor-form')).toBeHidden();
 await page.getByRole('button',{name:'Connect to my account',exact:true}).click();
 await page.getByRole('button',{name:'Confirm account connection',exact:true}).focus();
 await page.keyboard.press('Enter');
 expect(await page.evaluate(()=>window.saved)).toEqual([{action:'connect_self',memberId:'person-synthetic',name:'Gowtham',expectedName:'Gowtham',confirm:true}]);
 await expect(page.locator('#roster-editor-form')).toBeHidden();
 await page.getByRole('button',{name:'Set up for turns',exact:true}).click();
 await expect(page.getByRole('button',{name:'Confirm eligibility',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>window.saved.length)).toBe(1);
 await page.locator('#roster-editor-review').getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.locator('#roster-editor-form')).toBeHidden();
 await page.getByRole('button',{name:'Set up for turns',exact:true}).click();
 await page.getByRole('button',{name:'Confirm eligibility',exact:true}).focus();
 await page.keyboard.press('Enter');
 expect(await page.evaluate(()=>window.saved[1])).toEqual({action:'enable_duty',memberId:'joined-synthetic',name:'Robin',expectedName:'Robin',confirm:true});
 await expect(page.locator('#roster-editor-form')).toBeHidden();
 expect(errors).toEqual([]);
 console.log('Roster layout passed at seven widths (320–1280px), with unclipped 44px actions and mobile review/cancel/keyboard confirmation. Clean console; synthetic data only.');
} finally {await browser.close();}
