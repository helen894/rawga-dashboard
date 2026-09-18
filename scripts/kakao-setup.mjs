#!/usr/bin/env node
/**
 * kakao-setup.mjs — 카카오 '나에게 보내기' 최초 1회 토큰 발급.
 *
 * 왜 이 단계가 필요한가: 카카오 메시지 API 는 사용자 동의가 있어야 하고, 동의는 브라우저에서
 *   본인이 직접 눌러야 한다. 그 결과로 나오는 **인가 코드(code)** 를 refresh_token 으로
 *   바꾸는 게 이 스크립트다. refresh_token 은 한 번 받아 두면 매일 쓰는 한 계속 연장된다
 *   (두 달 넘게 안 쓰면 만료 — 매일 도는 알림이라 실질적으로 만료되지 않는다).
 *
 * ⚠ 토큰을 화면에 찍지 않는다. 시크릿 파일에 직접 쓴다 — 은행 시크릿과 같은 자리·같은 방식.
 * ⚠ 인가 코드는 **10분 · 1회용**이다. 받자마자 바로 이 스크립트를 돌려야 한다.
 *
 * 쓰는 법
 *   node scripts/kakao-setup.mjs --key <REST_API_키> --redirect <리디렉트URI> --code <인가코드>
 *
 * 인가 코드 받는 법 (브라우저 주소창에 붙여넣고 동의 → 돌아온 주소의 ?code= 뒤 값)
 *   https://kauth.kakao.com/oauth/authorize?client_id=<REST_API_키>&redirect_uri=<리디렉트URI>&response_type=code&scope=talk_message
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SECRET = 'C:/Users/RAWGA/AppData/Local/rawga/kakao.secret';
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const key = opt('--key'), redirect = opt('--redirect'), code = opt('--code');
if (!key || !redirect || !code) {
  console.error('사용법: node scripts/kakao-setup.mjs --key <REST_API_키> --redirect <리디렉트URI> --code <인가코드>');
  console.error('\n인가 코드는 아래 주소로 동의한 뒤 돌아온 주소의 ?code= 값입니다 (10분·1회용):');
  console.error(`  https://kauth.kakao.com/oauth/authorize?client_id=<REST_API_키>&redirect_uri=<리디렉트URI>&response_type=code&scope=talk_message`);
  process.exit(1);
}

const body = new URLSearchParams({
  grant_type: 'authorization_code', client_id: key, redirect_uri: redirect, code,
});
const res = await fetch('https://kauth.kakao.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
  body,
});
const j = await res.json().catch(() => ({}));
if (!res.ok || !j.refresh_token) {
  console.error(`토큰 발급 실패 (HTTP ${res.status})`);
  console.error(`  error=${j.error || '-'} / ${j.error_description || ''}`);
  if (String(j.error) === 'invalid_grant') {
    console.error('  → 인가 코드가 이미 쓰였거나 10분이 지났습니다. 동의 주소부터 다시 받으세요.');
  }
  if (String(j.error_description || '').includes('redirect')) {
    console.error('  → 리디렉트 URI 가 콘솔에 등록한 값과 글자 하나까지 같아야 합니다.');
  }
  process.exit(1);
}
/* scope 확인 — talk_message 가 없으면 보내기 단계에서 403 이 난다. 여기서 먼저 잡는다. */
const scopes = String(j.scope || '');
if (!scopes.includes('talk_message')) {
  console.error(`발급은 됐지만 talk_message 동의가 없습니다 (받은 scope: ${scopes || '없음'})`);
  console.error('  → 콘솔 [카카오 로그인 > 동의항목] 에서 "카카오톡 메시지 전송" 을 켜고 다시 동의하세요.');
  process.exit(1);
}
mkdirSync(dirname(SECRET), { recursive: true });
writeFileSync(SECRET, JSON.stringify({ rest_key: key, refresh_token: j.refresh_token }), 'utf8');
console.log('발급 완료.');
console.log(`  저장 위치 : ${SECRET}`);
console.log(`  scope     : ${scopes}`);
console.log(`  만료      : refresh_token ${Math.round((j.refresh_token_expires_in || 0) / 86400)}일 (매일 쓰면 자동 연장)`);
console.log('\n다음: node scripts/notify-pending-kakao.mjs --dry   (보내지 않고 문구만 확인)');
