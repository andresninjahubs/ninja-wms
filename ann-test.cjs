const { chromium } = require('playwright');
const BASE = 'http://localhost:3000/admin/';
async function login(pg,email,pass){await pg.goto(BASE,{waitUntil:'networkidle'});await pg.waitForSelector('#lg-email',{timeout:8000});await pg.fill('#lg-email',email);await pg.fill('#lg-pass',pass);await pg.click('#lg-btn');await pg.waitForTimeout(1800);}
(async()=>{
  const b=await chromium.launch();
  const errs=[];
  const pg=await b.newPage({viewport:{width:1440,height:900}});
  pg.on('pageerror',e=>errs.push('ADMIN '+e.message));
  await pg.addInitScript(()=>{ window.open=()=>null; });
  await login(pg,'ana@ninjahubs.cl','demo1234');
  await pg.waitForTimeout(700);
  console.log('ADMIN bar visible:', await pg.$eval('#ann-bar', el=>el.style.display!=='none').catch(()=>false));
  console.log('ADMIN bar text:', (await pg.$eval('#ann-text', el=>el.textContent).catch(()=>'?')));
  console.log('ADMIN link label:', (await pg.$eval('#ann-link', el=>el.textContent).catch(()=>'?')));
  await pg.click('#ann-link'); await pg.waitForTimeout(600); // registra clic de ana
  // dismiss
  await pg.click('#ann-x'); await pg.waitForTimeout(200);
  console.log('ADMIN bar hidden after ✕:', await pg.$eval('#ann-bar', el=>el.style.display==='none').catch(()=>'?'));
  await pg.close();

  const rp=await b.newPage({viewport:{width:1440,height:1000}});
  rp.on('pageerror',e=>errs.push('ROOT '+e.message));
  await login(rp,'root@ninjahubs.cl','admin1234');
  console.log('ROOT has Anuncios nav:', !!(await rp.$('.nav[data-pg="announcements"]')));
  await rp.click('.nav[data-pg="announcements"]'); await rp.waitForTimeout(1000);
  console.log('ROOT announcements in list:', await rp.$$eval('#ann-list tr[data-ann]', els=>els.length));
  console.log('ROOT first title:', (await rp.$eval('#ann-list tr[data-ann] b', el=>el.textContent).catch(()=>'?')));
  await rp.waitForTimeout(700);
  console.log('ROOT click count cell:', (await rp.$eval('#ann-list [data-anncount]', el=>el.textContent).catch(()=>'?')));
  await rp.click('#ann-list [data-annc]'); await rp.waitForTimeout(800);
  console.log('ROOT clicks modal:', await rp.$eval('#m-title', el=>el.textContent).catch(()=>'?'));
  const clickRows = await rp.$$eval('.ann-clickrow:not(.head)', els=>els.map(e=>e.innerText.replace(/\s+/g,' ').trim()));
  console.log('ROOT click detail rows:', clickRows.length);
  clickRows.slice(0,5).forEach((r,i)=>console.log('  ['+i+']', r));
  await rp.click('#ac-close').catch(()=>{}); await rp.waitForTimeout(300);
  await rp.click('#ann-new'); await rp.waitForTimeout(300);
  await rp.fill('#af-title','Prueba: nueva landing de kits');
  await rp.fill('#af-url','ninjahubs.cl/kits');
  await rp.click('#af-save'); await rp.waitForTimeout(700);
  console.log('ROOT announcements after create:', await rp.$$eval('#ann-list tr[data-ann]', els=>els.length));
  await rp.screenshot({path:'/home/claude/ann-maintainer.png', clip:{x:232,y:0,width:1208,height:540}});
  await rp.close();
  console.log('ERRORS:', errs.length, errs.slice(0,4).join(' | '));
  await b.close();
})();
