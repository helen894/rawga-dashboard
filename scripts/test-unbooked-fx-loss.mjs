#!/usr/bin/env node
/**
 * test-unbooked-fx-loss.mjs — 잔액 대조 카드의 '미기표 외환차손' 표시 로직 검증.
 *
 * 왜: 이 줄은 `cat_data.fx_adjust_base.unbooked_loss` 를 읽는다. 필드가 없거나 0 이면
 * **표시가 사라져야** 한다 — 값이 없을 때 0원이나 NaN 이 화면에 뜨면 근거 없는 숫자를
 * 보여주는 셈이다. 표시 전용이라 현금 계산에는 영향이 없지만, 잘못 뜨면 오독을 만든다.
 *
 * index.html 에서 unbookedFxLoss 를 잘라내 격리 실행한다.
 */
import fs from 'node:fs';
const html=fs.readFileSync('index.html','utf8');
const grab=(n)=>{const i=html.indexOf('function '+n+'(');let d=0,st=false;
 for(let j=html.indexOf('{',i);j<html.length;j++){if(html[j]==='{'){d++;st=true;}else if(html[j]==='}'){d--;if(st&&d===0)return html.slice(i,j+1);}}};
const mk=(base)=>new Function('const fxAdjustBase='+JSON.stringify(base)+';'+grab('unbookedFxLoss')+'return unbookedFxLoss;')();
let p=0,f=0; const eq=(l,g,w)=>{ if(g===w){p++;console.log('  OK  '+l);} else {f++;console.log('  ✗   '+l+'  기대 '+w+' 실제 '+g);} };
eq('값 있음', mk({unbooked_loss:121576679})(), 121576679);
eq('0 이면 미표시', mk({unbooked_loss:0})(), 0);
eq('음수면 미표시', mk({unbooked_loss:-5})(), 0);
eq('필드 없음', mk({pre_krw:1})(), 0);
eq('base 자체가 null', mk(null)(), 0);
eq('문자열 숫자도 받는다', mk({unbooked_loss:'121576679'})(), 121576679);
eq('숫자 아닌 문자열', mk({unbooked_loss:'abc'})(), 0);
console.log(f?('✗ '+f+'건 실패'):('전부 통과 ('+p+'/'+p+')'));
process.exitCode=f?1:0;
