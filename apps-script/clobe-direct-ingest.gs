/**
 * clobe-direct-ingest.gs — **버튼을 누르면 클로브에서 바로 읽어 cf_data 에 적재한다.**
 *
 * ⚠ 이 파일은 `clobe-drive-bridge.gs` 와 **같은 Apps Script 프로젝트**에 둔다.
 *   거기 있는 `EDGE_URL` · `SUPA_PUBLISHABLE_KEY` · `getSecret_()` 를 그대로 쓴다(중복 정의 금지).
 *
 * ═══ 왜 이게 가능한가 (2026-11-20 실측으로 확인) ═══════════════════════════
 * 종전 전제는 "클로브는 MCP 커넥터(=Claude)로만 읽을 수 있다" 였는데 **절반만 맞았다.**
 * 클로브 MCP 는 **표준 OAuth 보호 리소스**이고 다음이 전부 열려 있다:
 *   · 동적 클라이언트 등록 `/oauth/register`
 *   · authorization_code + refresh_token (scope: mcp, offline_access)
 *   · PKCE(S256), 공개 클라이언트 — 클라이언트 시크릿 불필요
 *   · 응답이 **application/json** 이다. SSE 도 세션 헤더도 없다 → UrlFetchApp 로 그대로 된다.
 * 브라우저에서 실제로 토큰을 받아 `tools/call` 로 당일 거래를 읽어 확인했다(2026-11-20).
 *
 * ═══ 흐름 ═════════════════════════════════════════════════════════════════
 *   [버튼] POST /exec  →  클로브 MCP 로 거래 읽기  →  **기존 cf-clobe-ingest Edge 로 전송**
 *   검증·중복제거·적재는 Edge 가 종전대로 한다. 이 파일은 '읽어서 넘기는' 일만 한다.
 *   드라이브도 10분 트리거도 거치지 않는다.
 *
 * ═══ 설치 ═════════════════════════════════════════════════════════════════
 *  1) 이 파일을 브리지 프로젝트에 새 스크립트로 추가 → 저장 → **웹앱으로 배포**
 *  2) 배포된 /exec 주소로 접속하면 상태 화면에 **등록해야 할 redirect_uri** 가 찍힌다
 *  3) 그 주소로 클로브에 클라이언트를 등록하고, 받은 client_id 를
 *     [프로젝트 설정 > 스크립트 속성] 에 `CLOBE_CLIENT_ID` 로 넣는다
 *  4) /exec?authorize=1 로 접속해 **1회 승인** → 콜백이 그 자리에서 토큰을 저장한다
 *  5) 대시보드 버튼을 이 /exec 주소로 연결
 *
 * ═══ 반드시 지키는 것 ═══════════════════════════════════════════════════════
 *  · **클로브는 읽기 도구만 부른다.** 쓰기·수정 도구는 어떤 경우에도 호출하지 않는다.
 *  · 회사는 **정확히 `(주)로가`** 하나로 특정될 때만 진행한다. `(주)로가JHT`·`로가온` 은 다른 회사다.
 *  · 응답은 **받은 그대로** Edge 로 넘긴다. 요약·재구성하지 않는다 — 검증은 서버가 한다.
 *  · 여러 페이지는 **하나의 객체로** 합친다: content 만 이어붙이고 합계는 첫 페이지 것을 쓴다.
 *    페이지 객체를 배열로 담으면 합계가 중복 합산돼 검증이 깨진다.
 */

/* ── 상수 ──────────────────────────────────────────────────────────────── */
var CLOBE_MCP_URL   = 'https://api.clobe.ai/mcp';
var CLOBE_AUTH_URL  = 'https://api.clobe.ai/oauth/authorize';
var CLOBE_TOKEN_URL = 'https://api.clobe.ai/oauth/token';
var CLOBE_SCOPE     = 'mcp offline_access';
var COMPANY_NAME    = '(주)로가';     // 정확히 일치해야 한다
var DEFAULT_DAYS    = 3;              // 버튼 기본: 오늘 포함 최근 3일 (깊은 스윕은 07:00 루틴 몫)
var DIRECT_MIN_INTERVAL_MS = 60 * 1000;

function props_() { return PropertiesService.getScriptProperties(); }
function clientId_() {
  var v = props_().getProperty('CLOBE_CLIENT_ID');
  if (!v) throw new Error('스크립트 속성 CLOBE_CLIENT_ID 가 없습니다. 설치 3)번을 보세요.');
  return v;
}
/** 등록해야 하는 redirect_uri — 배포된 웹앱 주소 그대로 */
function redirectUri_() { return ScriptApp.getService().getUrl(); }

/* ── OAuth ─────────────────────────────────────────────────────────────── */
function b64u_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
/** PKCE verifier — Apps Script 엔 난수 API 가 없어 UUID 두 개를 이어 쓴다(v4 라 엔트로피 충분) */
function newVerifier_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

function buildAuthorizeUrl_() {
  var verifier  = newVerifier_();
  var challenge = b64u_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier));
  var state     = Utilities.getUuid();
  props_().setProperties({ CLOBE_PKCE_VERIFIER: verifier, CLOBE_OAUTH_STATE: state }, false);
  return CLOBE_AUTH_URL + '?' + [
    'response_type=code',
    'client_id=' + encodeURIComponent(clientId_()),
    'redirect_uri=' + encodeURIComponent(redirectUri_()),
    'scope=' + encodeURIComponent(CLOBE_SCOPE),
    'code_challenge=' + challenge,
    'code_challenge_method=S256',
    'state=' + state,
  ].join('&');
}

/** 콜백 — 사람이 끼지 않으므로 코드가 만료될 틈이 없다(수동 교환이 계속 실패했던 이유). */
function completeAuthorize_(code, state) {
  var p = props_();
  if (!state || state !== p.getProperty('CLOBE_OAUTH_STATE')) throw new Error('state 불일치 — 승인을 다시 시작하세요.');
  var verifier = p.getProperty('CLOBE_PKCE_VERIFIER');
  if (!verifier) throw new Error('PKCE verifier 가 없습니다 — 승인을 다시 시작하세요.');

  var res = UrlFetchApp.fetch(CLOBE_TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: {
      grant_type: 'authorization_code', code: code,
      redirect_uri: redirectUri_(), client_id: clientId_(), code_verifier: verifier,
    },
  });
  var j = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || !j.access_token) {
    throw new Error('토큰 교환 실패 [' + res.getResponseCode() + '] ' + (j.error || '') + ' ' + (j.error_description || ''));
  }
  storeTokens_(j);
  p.deleteProperty('CLOBE_PKCE_VERIFIER');
  p.deleteProperty('CLOBE_OAUTH_STATE');
  return j.refresh_token ? '승인 완료 — 갱신 토큰을 저장했습니다.' : '승인은 됐으나 갱신 토큰이 없습니다(8시간 뒤 다시 승인 필요).';
}

function storeTokens_(j) {
  var set = { CLOBE_ACCESS_TOKEN: j.access_token,
              CLOBE_TOKEN_EXP: String(Date.now() + (Number(j.expires_in || 3600) * 1000)) };
  if (j.refresh_token) set.CLOBE_REFRESH_TOKEN = j.refresh_token;   // 갱신 때 안 줄 수도 있다 — 덮어쓰지 않는다
  props_().setProperties(set, false);
}

function accessToken_() {
  var p = props_();
  var at = p.getProperty('CLOBE_ACCESS_TOKEN');
  var exp = Number(p.getProperty('CLOBE_TOKEN_EXP') || 0);
  if (at && Date.now() < exp - 60000) return at;      // 만료 1분 전부터 미리 갱신

  var rt = p.getProperty('CLOBE_REFRESH_TOKEN');
  if (!rt) throw new Error('클로브 인증이 안 돼 있습니다 — 웹앱 주소에 ?authorize=1 로 접속해 1회 승인하세요.');
  var res = UrlFetchApp.fetch(CLOBE_TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'refresh_token', refresh_token: rt, client_id: clientId_() },
  });
  var j = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || !j.access_token) {
    throw new Error('토큰 갱신 실패 [' + res.getResponseCode() + '] ' + (j.error || '') +
                    ' — 다시 승인해야 할 수 있습니다(?authorize=1).');
  }
  storeTokens_(j);
  return j.access_token;
}

/* ── MCP (JSON-RPC over HTTP) ──────────────────────────────────────────── */
var _mcpId = 0;
function mcp_(method, params, notify) {
  var body = { jsonrpc: '2.0', method: method, params: params };
  if (!notify) body.id = ++_mcpId;
  var res = UrlFetchApp.fetch(CLOBE_MCP_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + accessToken_(), Accept: 'application/json, text/event-stream' },
    payload: JSON.stringify(body),
  });
  if (notify) return null;
  var txt = res.getContentText() || '';
  if (res.getResponseCode() !== 200) throw new Error('MCP HTTP ' + res.getResponseCode() + ' ' + txt.slice(0, 200));
  /* 서버가 SSE 로 답할 경우 대비 — 지금은 application/json 이지만 바뀔 수 있다 */
  if (txt.indexOf('data:') === 0 || txt.indexOf('\ndata:') >= 0) {
    var m = txt.match(/^data:\s*(.+)$/m);
    if (m) txt = m[1];
  }
  var j = JSON.parse(txt);
  if (j.error) throw new Error('MCP 오류 ' + JSON.stringify(j.error).slice(0, 200));
  return j.result;
}

/** 도구 호출 — 결과는 content[0].text 안에 JSON 문자열로 들어온다 */
function tool_(name, args) {
  var r = mcp_('tools/call', { name: name, arguments: args });
  var t = r && r.content && r.content[0] && r.content[0].text;
  if (!t) throw new Error(name + ' 응답에 내용이 없습니다');
  return JSON.parse(t);
}

function mcpHandshake_() {
  mcp_('initialize', { protocolVersion: '2025-06-18', capabilities: {},
                       clientInfo: { name: 'rawga-direct-ingest', version: '1.0' } });
  mcp_('notifications/initialized', {}, true);
}

/* ── 적재 ──────────────────────────────────────────────────────────────── */
/** 클로브 수집일이 오늘보다 며칠 뒤처졌는가. 판정 불가(빈 값·'(확인 실패)')면 0.
 *  ⚠ 0 은 '최신' 과 '모름' 을 겸한다 — 모르는 걸 경고로 올리면 매일 울어서 아무도 안 본다.
 *  ⚠ 두 값 다 yyyy-MM-dd 라 Date.parse 는 UTC 자정으로 읽는다. 같은 기준끼리 빼므로
 *    시간대 보정이 필요 없다 — 한쪽에만 시각을 붙이면 그 순간 하루씩 틀어진다. */
function collectionLagDays_(asOfDay, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDay) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return 0;
  if (asOfDay >= today) return 0;          // 미래값은 시계 어긋남 — 지연으로 치지 않는다
  return Math.round((Date.parse(today) - Date.parse(asOfDay)) / 86400000);
}

function daysBack_(n) {
  var tz = Session.getScriptTimeZone(), out = [];
  for (var i = n - 1; i >= 0; i--) {
    out.push(Utilities.formatDate(new Date(Date.now() - i * 864e5), tz, 'yyyy-MM-dd'));
  }
  return out;
}

/** 하루치를 끝까지 받아 **하나의 객체**로 합친다 (합계는 첫 페이지 것만 쓴다) */
function fetchDay_(companyId, day) {
  var merged = null, cursor = null, guard = 0;
  do {
    var input = { companyId: companyId, startDate: day, endDate: day, size: 100 };
    if (cursor) input.cursor = cursor;
    var d = tool_('get_labeled_transactions', { input: input });
    if (!merged) merged = d;
    else merged.content = (merged.content || []).concat(d.content || []);
    cursor = d.hasNext ? d.nextCursor : null;
  } while (cursor && ++guard < 20);
  merged.hasNext = false; merged.nextCursor = null;
  return merged;
}

/** 원본 보존 — 적재한(또는 실패한) 클로브 응답을 그대로 드라이브에 남긴다.
    ⚠ 드라이브를 **경유하지는 않는다.** 적재는 이미 Edge 로 끝났고 이건 감사 흔적일 뿐이다.
      이름에 시각을 넣어 클라우드 루틴이 쓰는 cf-YYYYMMDD.json 과 겹치지 않게 한다.
      '대기' 에는 절대 쓰지 않는다 — 거기 쓰면 브리지가 집어가 이중 적재 시도가 된다. */
function archive_(day, payload, ok) {
  try {
    var d = dirs_();
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss');
    (ok ? d.done : d.hold).createFile('direct-cf-' + day.replace(/-/g, '') + '-' + stamp + '.json',
                                      JSON.stringify(payload), MimeType.PLAIN_TEXT);
  } catch (e) { Logger.log('원본 보존 실패(' + day + '): ' + e.message); }
}

/**
 * @param days  조회할 일수 (오늘 포함, 역순)
 * @param opts  { archive: 성공분도 보존할지, notifyOnFail: 실패 시 메일 보낼지 }
 *              버튼은 둘 다 끈다(눌릴 때마다 파일이 쌓이면 '완료' 가 쓰레기통이 된다).
 *              예약 실행은 둘 다 켠다 — **조용히 멈추는 것**이 이 프로젝트에서 제일 아팠다.
 */
function runDirectIngest(days, opts) {
  opts = opts || {};
  var n = Math.max(1, Math.min(14, Number(days) || DEFAULT_DAYS));
  mcpHandshake_();

  /* ① 회사 — 정확히 일치하는 것 하나일 때만 */
  var ctx = tool_('get_my_context', { input: {} });
  var hit = (ctx.companies || []).filter(function (c) { return c.companyName === COMPANY_NAME; });
  if (hit.length !== 1) throw new Error('회사 특정 실패 — "' + COMPANY_NAME + '" 와 정확히 일치하는 항목이 ' + hit.length + '개입니다.');
  var companyId = hit[0].companyId;

  /* ② 수집 상태 — 막지는 않되 천장을 알려 준다(클로브가 긁은 데까지만 온다) */
  var asOf = '';
  try {
    var st = tool_('get_scraping_status', { input: { companyId: companyId } });
    (st.assets || []).forEach(function (a) {
      if (a.category === 'BANK' && a.scrapedAt && a.scrapedAt > asOf) asOf = a.scrapedAt;
    });
  } catch (e) { asOf = '(확인 실패)'; }

  /* ③ 외화 계좌·환율 — 통화별 평가환율을 모아 둔다 */
  var fxAccounts = {}, rateByCur = {};
  var accts = (tool_('get_bank_accounts', { input: { companyId: companyId } }).accounts) || [];
  accts.forEach(function (a) {
    if (a.accountType !== 'FX') return;
    fxAccounts[String(a.bankAccountId)] = a.currencyCode;
    if (!rateByCur[a.currencyCode] && a.balance > 0) rateByCur[a.currencyCode] = a.krwBalance / a.balance;
  });
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  /* ④ 날짜별로 받아서 그대로 Edge 로 */
  var lines = [], added = 0, skipped = 0, failed = 0;
  daysBack_(n).forEach(function (day) {
    var page;
    try { page = fetchDay_(companyId, day); }
    catch (e) { failed++; lines.push('✗ ' + day + ' 조회 실패: ' + e.message); return; }

    var rows = page.content || [];
    if (!rows.length) { lines.push('· ' + day + ' 거래 없음'); return; }

    /* 그 날 외화 거래의 통화에 맞는 환율을 쓴다. 섞여 있으면 Edge 가 걸러낸다(FX_MIXED_CURRENCY). */
    var curs = {};
    rows.forEach(function (r) { var c = fxAccounts[String(r.accountId)]; if (c) curs[c] = 1; });
    var cur = Object.keys(curs)[0] || 'USD';
    var fxRef = rateByCur[cur] || 0;

    var res = UrlFetchApp.fetch(EDGE_URL, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: SUPA_PUBLISHABLE_KEY, Authorization: 'Bearer ' + SUPA_PUBLISHABLE_KEY },
      payload: JSON.stringify({
        secret: getSecret_(), action: 'ingest',
        pages: page, fxAccounts: fxAccounts, fxRef: fxRef, fxRefAsOf: today,
        allowToday: true, allowLargeCancel: false,
      }),
    });
    var code = res.getResponseCode(), body = {};
    try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) {}

    if (code === 200 && body.ok) {
      added += (body.added || 0); skipped += (body.skipped || 0);
      lines.push('✓ ' + day + ' ' + rows.length + '건 → 추가 ' + (body.added || 0) + ' · 중복 ' + (body.skipped || 0));
      if (opts.archive) archive_(day, page, true);
    } else if (code === 422) {
      failed++;
      lines.push('⚠ ' + day + ' 검증 중단 [' + (body.code || '') + '] ' + (body.error || '').slice(0, 90));
      archive_(day, page, false);      // 검증 실패는 **언제나** 원본을 남긴다 — 사람이 봐야 한다
    } else {
      failed++;
      lines.push('✗ ' + day + ' HTTP ' + code + ' ' + (body.error || '').slice(0, 90));
      archive_(day, page, false);
    }
  });

  /* ⑤ 신선도 — **'거래 없음' 과 '클로브가 아직 안 긁었음' 은 다른 사건이다.**
     둘이 같은 글자로 나오면 하루 늦은 숫자를 맞다고 믿게 된다. 2026-11-23 에 실제로 그랬다:
     07:00 에 돌았는데 클로브 수집은 09:13 이라, 그날 07:06 카드대금 6,148,296 이 다음 날에야
     들어왔다. 그런데 로그는 '거래 없음' 이라 아무도 몰랐다. **지연 일수를 머리줄에 박는다.** */
  var asOfDay = String(asOf || '').slice(0, 10);
  var lagDays = collectionLagDays_(asOfDay, today);
  var warn = lagDays
    ? ' ⚠ 클로브 수집이 ' + lagDays + '일 전(' + asOfDay + ') — 그 뒤 거래는 아직 안 들어옵니다'
    : '';

  var head = '클로브 직접 적재 · ' + n + '일 · 추가 ' + added + '건 (중복 ' + skipped + ', 실패 ' + failed + ')' + warn;
  var out = head + '\n수집 기준 ' + asOf + (lagDays ? '  [' + lagDays + '일 지연]' : '  [당일]') + '\n' + lines.join('\n');
  props_().setProperty('DIRECT_LAST_RESULT', out.slice(0, 8000));
  props_().setProperty('DIRECT_LAST_RUN_AT', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
  props_().setProperty('DIRECT_LAST_ASOF', asOfDay + (lagDays ? ' (' + lagDays + '일 지연)' : ' (당일)'));
  Logger.log(out);

  /* ⚠ 실패했는데 아무도 모르는 상태를 만들지 않는다. 성공했을 때는 조용히 — 매번 메일이 오면
     곧 안 읽게 되고 진짜 사고가 묻힌다(브리지가 같은 원칙으로 돌고 있다). */
  /* 수집이 이틀 넘게 멈추면 **실패가 아니어도** 알린다. 그 상태에서 적재는 매일 '성공' 으로
     끝나지만 들어오는 게 없다 — 실패 알림만 걸어 두면 영원히 조용하다. */
  if (lagDays >= 2 && opts.notifyOnFail) {
    notify_('[자금 대시보드] 클로브 수집이 ' + lagDays + '일째 멈춰 있습니다',
            out + '\n\n· 적재 자체는 정상입니다 — 가져올 자료가 클로브에 없습니다.' +
                  '\n· app.clobe.ai 에서 데이터 최신화를 실행하면 다음 예약 실행이 집어 옵니다.');
  }

  if (failed && opts.notifyOnFail) {
    notify_('[자금 대시보드] 클로브 직접 적재 실패 ' + failed + '건', out +
            '\n\n· 실패한 날짜의 클로브 원본은 드라이브 ' + ROOT_FOLDER + '/' + DIR_HOLD + ' 에 남겨 뒀습니다.' +
            '\n· 네트워크·일시 오류면 다음 날 예약 실행이 같은 날짜를 다시 집습니다(중복은 Edge 가 거릅니다).');
  }
  return out;
}

/* ── 예약 실행 ─────────────────────────────────────────────────────────────
   클라우드 루틴(클로브→드라이브)을 대신한다. 드라이브를 경유하지 않으므로
   10분 브리지 트리거를 기다릴 일도 없다.

   ⚠ 시각은 못 박지 못한다. 구글이 일부러 분산시킨다 — atHour 만 쓰면 분이 **무작위**이고,
     nearMinute 를 써야 **±15분**으로 좁혀진다. 아래 괄호가 실제로 도는 구간이다. */

/** 하루 세 번 — [시, 분].
 *
 *  07:00 (06:45~07:15)  밤사이 재수집분. **보통 비어 있다.** 클로브 정기 수집이 09:1x 라
 *                       이 회차가 읽는 건 사실상 어제치고, 머리줄에 '1일 전' 이 붙는 게 정상이다.
 *  11:30 (11:15~11:45)  오늘치가 처음 들어오는 회차. 셋 중 **본진**이다.
 *  16:30 (16:15~16:45)  장중 재수집분을 줍는다.
 *
 *  ⚠ 왜 07:00 하나로는 안 됐나 (2026-11-23). 클로브 정기 수집이 09:12~09:13 이라 07:00 에만
 *    돌면 매일 어제치를 읽는다. 적재는 늘 '성공' 인데 대시보드만 하루 늦고, 로그는
 *    '거래 없음' 이라 아무도 모른다. 11-23 07:06 카드대금 6,148,296 이 그렇게 밀렸다.
 *  ⚠ 오후 회차가 헛돌지 않는 근거. 클로브는 정기 수집 말고도 **다시 긁는다** — 2026-11-23 에
 *    10:28 재수집 요청 → 기업은행 6계좌가 10:32 에 다시 수집됐다(나머지는 09:1x 그대로).
 *    즉 클로브에서 '최신화' 를 누르면 그다음 회차가 알아서 집어 온다.
 *  ⚠ 클로브 수집 시각이 바뀌면 여기도 옮긴다. 근거는 get_scraping_status 의 scrapedAt 이고,
 *    웹앱 doGet 의 '수집 기준' 줄에 매 회차 찍힌다. 분 단위가 꼭 필요하면 외부 cron 으로
 *    이 웹앱에 POST 하면 되지만(주간 리포트 방식), 신선도를 정하는 건 우리가 아니라
 *    **클로브가 언제 수집했는가** 라 실익은 없다. */
var DIRECT_SCHEDULE = [[7, 0], [11, 30], [16, 30]];

function runDailyDirectIngest() {
  return runDirectIngest(6, { archive: true, notifyOnFail: true });   // 6일 — 연휴·주말을 덮는다
}

/** nearMinute 는 ±15분이다. 사람이 읽을 실제 구간으로 바꿔 준다(자정을 넘으면 감싼다). */
function scheduleSpan_(h, m) {
  var t = h * 60 + m;
  return hhmm_(t - 15) + '~' + hhmm_(t + 15);
}
function hhmm_(t) {
  t = ((t % 1440) + 1440) % 1440;
  return ('0' + Math.floor(t / 60)).slice(-2) + ':' + ('0' + (t % 60)).slice(-2);
}

/** ⚠ 이름이 setupDirectTrigger 가 **아니다.** 구글 프로젝트에 옛 사본이 남아 있으면 같은
 *    이름의 함수 중 하나만 이기고 **경고가 없다** — 2026-11-23 에 새 코드를 저장하고도 옛
 *    07:00 메시지가 찍힌 게 그 증상이다. 이름을 바꿔 그 싸움 자체를 피한다.
 *    옛 사본을 지우고 나서도 이 이름을 그대로 쓴다(되돌리면 같은 함정에 다시 빠진다). */
function setupDirectSchedule() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyDirectIngest') ScriptApp.deleteTrigger(t);
  });
  var spans = DIRECT_SCHEDULE.map(function (hm) {
    ScriptApp.newTrigger('runDailyDirectIngest').timeBased()
      .atHour(hm[0]).nearMinute(hm[1]).everyDays(1).create();
    return scheduleSpan_(hm[0], hm[1]);
  });
  var msg = '예약 완료 — 매일 ' + spans.length + '회 (' + spans.join(' / ') + ') runDailyDirectIngest 가 돕니다.';
  Logger.log(msg);
  return msg;
}

/** 지금 **실제로 도는** 코드가 새 사본인지 본다.
 *  옛 파일이 이름 싸움에서 이기고 있으면 '고쳤는데 안 바뀐다' 로만 나타나므로,
 *  눈으로 확인할 자리를 만들어 둔다. runDirectIngest 는 두 사본에 다 있고
 *  collectionLagDays_ 를 부르는 건 새 사본뿐이라, 이게 판별선이다. */
function checkCodeVersion() {
  var rows = [];
  var live = String(runDirectIngest).indexOf('collectionLagDays_') >= 0;
  rows.push((live ? '✅ 새 사본이 돈다' : '❌ 옛 사본이 이기고 있다 — 다른 .gs 파일을 지워야 한다')
            + ' — runDirectIngest');
  rows.push((typeof collectionLagDays_ === 'function' ? '✅ 있음' : '❌ 없음') + ' — collectionLagDays_');
  rows.push((typeof DIRECT_SCHEDULE !== 'undefined' && DIRECT_SCHEDULE.length === 3
             ? '✅ ' + DIRECT_SCHEDULE.map(function (hm) { return scheduleSpan_(hm[0], hm[1]); }).join(' / ')
             : '❌ 예약표 없음') + ' — DIRECT_SCHEDULE');
  var msg = rows.join('\n');
  Logger.log(msg);
  return msg;
}

function removeDirectTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyDirectIngest') { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log('예약 해제 ' + n + '건');
  return '예약 해제 ' + n + '건';
}

/* ── 웹앱 ──────────────────────────────────────────────────────────────── */
function text_(s) { return ContentService.createTextOutput(s); }
function html_(s) { return HtmlService.createHtmlOutput(s); }

/** GET 은 상태·승인 전용 — **적재하지 않는다.** 크롤러가 적재를 돌리면 안 된다. */
function doGet(e) {
  var q = (e && e.parameter) || {};
  var p = props_();

  if (q.code) {
    try { return html_('<p>' + completeAuthorize_(q.code, q.state) + '</p><p>이 창은 닫으셔도 됩니다.</p>'); }
    catch (err) { return html_('<p>승인 실패: ' + err.message + '</p>'); }
  }
  if (q.authorize) {
    try {
      var u = buildAuthorizeUrl_();
      return html_('<p>아래를 눌러 클로브에서 승인하세요.</p><p><a href="' + u + '" target="_top">클로브 승인하러 가기</a></p>');
    } catch (err) { return html_('<p>승인 URL 생성 실패: ' + err.message + '</p>'); }
  }

  return text_([
    '[클로브 직접 적재]',
    '등록할 redirect_uri : ' + redirectUri_(),
    'CLOBE_CLIENT_ID     : ' + (p.getProperty('CLOBE_CLIENT_ID') ? '설정됨' : '⚠ 없음'),
    '클로브 인증          : ' + (p.getProperty('CLOBE_REFRESH_TOKEN') ? '완료' : '⚠ 미완료 (?authorize=1)'),
    '마지막 실행          : ' + (p.getProperty('DIRECT_LAST_RUN_AT') || '(없음)'),
    '',
    (p.getProperty('DIRECT_LAST_RESULT') || ''),
    '',
    '(적재는 POST 로만 실행됩니다)',
  ].join('\n'));
}

/** POST 만 실제로 적재한다 — 대시보드 버튼이 쓰는 경로. */
function doPost(e) {
  var p = props_();
  var last = Number(p.getProperty('DIRECT_LAST_RUN_MS') || 0);
  var now = Date.now();
  if (now - last < DIRECT_MIN_INTERVAL_MS) return text_('너무 잦은 호출입니다 — 잠시 후 다시 시도하세요.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return text_('다른 적재가 진행 중입니다 — 잠시 후 다시 시도하세요.');

  try {
    p.setProperty('DIRECT_LAST_RUN_MS', String(now));
    var days = (e && e.parameter && e.parameter.days) || DEFAULT_DAYS;
    return text_(runDirectIngest(days));
  } catch (err) {
    var msg = '적재 실패: ' + err.message;
    p.setProperty('DIRECT_LAST_RESULT', msg);
    return text_(msg);
  } finally {
    lock.releaseLock();
  }
}

/** 편집기에서 손으로 돌려 볼 때 */
function runDirectOnce() { Logger.log(runDirectIngest(DEFAULT_DAYS)); }
