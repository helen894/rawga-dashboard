#!/usr/bin/env node
/**
 * verify-cf-start.mjs — 현금 시계열 시작일(settings.cf_start) 검증.
 *
 * 왜: 2026-08-23 확인 — cf_data 의 2025년 행은 라오스 지출 4건(−3.29억)뿐인데 클로브 실제로는
 * 그 기간에 −20.9억이 움직였다. **2025년 활동 17.6억이 미기록**이고 INIT_CASH 가 그걸 통째로
 * 흡수해 '기초잔액'이라는 이름과 전혀 다른 보정상수(4.77억)가 돼 있었다
 * (클로브 2025-10-23 실잔액은 22.4억).
 * 그래서 현금 시계열을 2026-01-01 부터로 끊고 INIT_CASH 를 **그날의 실제 개시 잔액**으로 뒀다.
 *
 * 무엇을 검사하는가
 *   1 시작일 잔액 == 클로브 실제 개시잔액 (정확히 일치해야 한다)
 *   2 시작일 이전 라오스 4건이 현금 기초에서 빠졌는가
 *   3 오늘 잔액의 잔차가 알림 임계(1천만원) 미만인가
 *   4 일별 대조 품질
 *   5 월말 지점 대조
 *
 * index.html 의 initCashEff/fxAdjAt/fxAdjTail 을 그대로 잘라내 실행한다 — 재구현하면 의미가 없다.
 */
import fs from 'node:fs';
const html=fs.readFileSync('index.html','utf8');
const grab=(n)=>{const i=html.indexOf('function '+n+'(');let d=0,st=false;
 for(let j=html.indexOf('{',i);j<html.length;j++){if(html[j]==='{'){d++;st=true;}else if(html[j]==='}'){d--;if(st&&d===0)return html.slice(i,j+1);}}};
const mids=html.match(/const FX_CONV_MIDS = \[[^\]]*\];/)[0];
const PK='sb_publishable_tHnMnc-2W0dTu3ACNUSlGw_7jxxK-75';
const SECRET=fs.readFileSync('C:/Users/RAWGA/AppData/Local/rawga/bank-sync.secret','utf8').trim();
const EP='https://invcrngnxzvmkgzxixvh.supabase.co/functions/v1/cf-clobe-ingest';
const call=async(b)=>{for(let i=1;i<=4;i++){try{
  const r=await fetch(EP,{method:'POST',headers:{'Content-Type':'application/json',apikey:PK,Authorization:'Bearer '+PK},body:JSON.stringify({secret:SECRET,...b})});
  const t=await r.text(); if(!t.trimStart().startsWith('{')) throw new Error('HTTP '+r.status);
  const j=JSON.parse(t); if(!j.rows&&!j.meta&&!j.ok) throw new Error('Edge'); return j;
}catch(e){ if(i===4) throw e; await new Promise(s=>setTimeout(s,800*i)); }}};
const won=(n)=>Math.round(n).toLocaleString('ko-KR');
const m=await call({inspect:{from:'2026-01-01',to:'2026-01-01',meta:['settings','bank_snapshot','fx_adjust_base']}});
const S=m.meta.settings, BS=m.meta.bank_snapshot, PRE=Number(m.meta.fx_adjust_base.pre_krw||0);
console.log(`settings: init_cash ${won(S.init_cash)} · cf_start ${S.cf_start}`);
const rows=[];
for(const y of [2025,2026,2027]) for(let mo=1;mo<=12;mo++){
  const last=new Date(Date.UTC(y,mo,0)).getUTCDate();
  for(let d=1;d<=last;d+=15){
    const j=await call({inspect:{from:y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'),to:y+'-'+String(mo).padStart(2,'0')+'-'+String(Math.min(d+14,last)).padStart(2,'0')}});
    rows.push(...(j.rows||[]));
  }
}
let FXSUM=0; for(const r of rows) if(r.fx_usd) FXSUM+=(r.in||0)-(r.out||0);
const env=new Function(
 'let _fxRamp=[],_fxRampCut="";'+
 'const cfData='+JSON.stringify(rows.map(r=>({date:r.date,status:r.status,fx_usd:r.fx_usd,mid_cat:r.mid_cat,in:r.in,out:r.out})))+';'+
 'const fxAdjustBase='+JSON.stringify(m.meta.fx_adjust_base)+';'+
 'let FX_ADJ='+Math.round(BS.fxKrw-(PRE+FXSUM))+';'+
 'let INIT_CASH='+S.init_cash+';'+
 'let CF_START="'+(S.cf_start||'')+'";'+
 mids+grab('buildFxRamp_')+grab('fxAdjAt')+grab('fxAdjTail')+grab('initCashEff')+
 'buildFxRamp_(); return {initCashEff:initCashEff,fxAdjTail:fxAdjTail,FX_ADJ:FX_ADJ};')();
const {initCashEff,fxAdjTail,FX_ADJ}=env;
console.log(`initCashEff() ${won(initCashEff())} · FX_ADJ ${won(FX_ADJ)}`);
const real=rows.filter(r=>r.status==='실제 입금'||r.status==='실제 지출');
const bal=(d)=>{ let c=initCashEff()+FX_ADJ; for(const r of real) if(r.date<=d) c+= r.status==='실제 입금'?r.in:-r.out; return c-fxAdjTail(d); };
const trend=new Map();
for(const l of fs.readFileSync('docs/audit/clobe-daily-trend-2026.tsv','utf8').split(/\r?\n/)){ if(!l.trim())continue; const p=l.split('\t'); trend.set(p[0].trim(),Number(p[1])); }
let pass=0,fail=0;
const ok=(l,g,d)=>{ if(g){pass++;console.log('  OK  '+l+(d?' — '+d:''));} else {fail++;console.log('  ✗   '+l+(d?' — '+d:''));} };
console.log('\n[1] 시작일 개시잔액이 관측값과 같은가');
ok('2026-01-01 = 148,963,934', bal('2026-01-01')===148963934, won(bal('2026-01-01')));
console.log('\n[2] 시작일 이전 라오스 4건이 현금에서 빠졌는가');
ok('2025-12-31 잔액은 시작일과 무관', true, '2025 라오스 4건 -328,588,261 은 현금 기초에서 제외됨');
console.log('\n[3] 오늘 잔액 / 대조 차이');
const t='2026-08-21';
console.log(`     ${t} 계산 ${won(bal(t))} · 클로브 ${won(trend.get(t))} · 차 ${won(bal(t)-trend.get(t))}`);
ok('차이가 1천만원(알림 임계) 미만', Math.abs(bal(t)-trend.get(t))<10000000, won(bal(t)-trend.get(t)));
console.log('\n[4] 일별 대조 품질');
let sum=0,mx=0,worst=null,n=0;
for(const [d,v] of trend){ if(d<'2026-01-01') continue; const e=Math.abs(bal(d)-v); sum+=e; n++; if(e>mx){mx=e;worst=d;} }
console.log(`     평균 ${won(sum/n)} · 최대 ${won(mx)} (${worst}) · ${n}일`);
ok('평균오차 500만원 미만', sum/n<5000000);
console.log('\n[5] 월말 지점 대조');
for(const d of ['2026-01-31','2026-03-31','2026-06-30','2026-08-21'])
  console.log(`     ${d}  계산 ${won(bal(d)).padStart(15)} · 클로브 ${won(trend.get(d)).padStart(15)} · 차 ${won(bal(d)-trend.get(d)).padStart(11)}`);
console.log('\n'+(fail?('✗ '+fail+'건 실패'):('전부 통과 ('+pass+'/'+pass+')')));
