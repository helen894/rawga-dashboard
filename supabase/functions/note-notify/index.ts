/**
 * note-notify — Supabase Edge Function
 *
 * 입출금 메모의 `@멘션` 을 **메일로 알린다.**
 *
 * 왜 Edge 인가: 프런트는 publishable 키만 가져서 메일을 못 보낸다(SMTP 시크릿은 서버에만 있다).
 *   주간 리포트(send-weekly-report)와 **같은 Gmail SMTP 시크릿**을 그대로 쓴다.
 *
 * ⚠⚠ 보안 — 이 함수의 핵심은 '누구에게 보낼 수 있는가' 를 막는 것이다.
 *   게이트웨이(verify_jwt)는 publishable 키만 있으면 통과시키고, 그 키는 index.html 에 박혀
 *   공개 배포된다. 그래서 **요청 본문의 주소를 믿고 보내면 임의 주소로 메일을 쏘는 통로가 된다.**
 *   두 겹으로 막는다:
 *     ① 받는 주소는 **요청이 아니라 DB 에서** 가져온다 — noteId 로 cf_notes 를 다시 읽는다.
 *        메모를 만들려면 로그인(RLS: author_email = auth.jwt()->>'email')이 필요하다.
 *     ② 그렇게 얻은 멘션도 **cat_data('dashboard_users') 명단 안에 있는 주소만** 남긴다.
 *        명단 밖이면 조용히 버린다(에러로 알려 주면 주소 존재 여부를 떠보는 통로가 된다).
 *
 * ⚠ 중복 발송: 보낸 뒤 notified_at 을 찍고, 이미 찍혀 있으면 아무것도 하지 않는다.
 *   없으면 새로고침·재시도마다 같은 멘션으로 메일이 또 나간다.
 *
 * 요청: POST { noteId: "<uuid>" }
 *   헤더에 apikey/Authorization(publishable) 필요 — 게이트웨이가 요구한다.
 * 응답: { ok, sent, skipped, reason? }
 */
import nodemailer from "npm:nodemailer@6.9.14";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")              || "";
const SERVICE_ROLE       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GMAIL_USER         = Deno.env.get("GMAIL_USER")                || "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")        || "";
const DASHBOARD_URL      = Deno.env.get("DASHBOARD_URL")             || "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

/** HTML 이스케이프 — 메모 본문은 사람이 쓴 자유 텍스트라 그대로 넣으면 안 된다 */
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ ok: false, error: "Server configuration error: SUPABASE_URL / SERVICE_ROLE" }, 500);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const noteId = String(body.noteId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(noteId)) return json({ ok: false, error: "noteId(uuid) 가 필요합니다" }, 400);

  /* ① 메모를 DB 에서 다시 읽는다 — 요청 본문의 주소를 믿지 않는다 */
  const nRes = await rest(`cf_notes?id=eq.${noteId}&select=*&limit=1`);
  if (!nRes.ok) return json({ ok: false, error: `cf_notes 조회 실패: ${nRes.status}` }, 500);
  const note = (await nRes.json())?.[0] as Record<string, unknown> | undefined;
  if (!note) return json({ ok: false, error: "메모를 찾을 수 없습니다" }, 404);

  if (note.notified_at) {
    return json({ ok: true, sent: 0, skipped: "already_notified" });
  }

  const author   = String(note.author_email || "");
  const mentions = Array.isArray(note.mentions) ? (note.mentions as string[]) : [];
  if (mentions.length === 0) return json({ ok: true, sent: 0, skipped: "no_mentions" });

  /* ② 명단 안에 있는 주소만 남긴다 + 본인 멘션 제외 */
  const uRes = await rest(`cat_data?key=eq.dashboard_users&select=data&limit=1`);
  const uRow = uRes.ok ? (await uRes.json())?.[0] : null;
  const roster = Array.isArray(uRow?.data) ? uRow.data as Array<Record<string, unknown>> : [];
  const allowed = new Set(
    roster.map((u) => String(u.email || "").trim().toLowerCase()).filter(Boolean),
  );
  const nameOf = (email: string) =>
    String(roster.find((u) => String(u.email || "").toLowerCase() === email)?.name || email);

  const to = [...new Set(mentions.map((m) => String(m).trim().toLowerCase()))]
    .filter((m) => allowed.has(m))          // 명단 밖은 버린다
    .filter((m) => m !== author.toLowerCase());   // 본인이 본인을 멘션하면 안 보낸다

  if (to.length === 0) {
    /* 명단 밖이어서 걸렀는지, 본인뿐이어서인지는 구분해 돌려주되 주소는 노출하지 않는다 */
    await rest(`cf_notes?id=eq.${noteId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ notified_at: new Date().toISOString() }),
    });
    return json({ ok: true, sent: 0, skipped: "no_eligible_recipient" });
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return json({ ok: false, error: "Server configuration error: GMAIL_USER / GMAIL_APP_PASSWORD" }, 500);
  }

  /* ③ 메일 — 주간 리포트와 같은 SMTP 경로 */
  const authorName = nameOf(author.toLowerCase());
  const bodyText   = String(note.body || "");
  const isReply    = !!note.parent_id;
  /* 그 메모를 지목해 연다(입출금 탭 + 해당 거래 행 + 메모 창).
     WARN 해시가 아니라 **쿼리**로 보낸다 — 구글 로그인 리디렉션이 해시를 토큰으로 덮어쓴다.
       대시보드가 뜨자마자 이 값을 sessionStorage 로 옮겨 로그인 왕복을 견딘다. */
  const deepLink   = /^https?:\/\/.+/i.test(DASHBOARD_URL)
    ? `${DASHBOARD_URL.split("#")[0]}${DASHBOARD_URL.includes("?") ? "&" : "?"}note=${encodeURIComponent(noteId)}`
    : "";

  const subject = `[RAWGA 자금] ${authorName}님이 ${isReply ? "답글에서 " : ""}회원님을 언급했습니다`;
  const html = `<!DOCTYPE html>
<html lang="ko"><body style="margin:0;padding:0;background:#F2F5F1;font-family:'Malgun Gothic',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#314840;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:14px;font-weight:700">
      RAWGA 자금 대시보드 · 입출금 메모
    </div>
    <div style="background:#fff;border:1px solid rgba(49,72,64,.12);border-top:none;border-radius:0 0 10px 10px;padding:18px">
      <p style="margin:0 0 12px;font-size:13px;color:#55655D">
        <b style="color:#1B2B30">${esc(authorName)}</b> 님이 ${isReply ? "답글에서 " : ""}회원님을 언급했습니다.
      </p>
      <div style="background:#F6F9F4;border-left:3px solid #314840;border-radius:4px;padding:12px 14px;font-size:13px;line-height:1.75;color:#1B2B30;white-space:pre-wrap">${esc(bodyText)}</div>
      ${deepLink ? `<p style="margin:16px 0 0"><a href="${esc(deepLink)}" style="display:inline-block;background:#314840;color:#fff;text-decoration:none;font-size:13px;padding:9px 16px;border-radius:7px">대시보드에서 보기</a></p>` : ""}
      <p style="margin:16px 0 0;font-size:11px;color:#94A296">
        입출금 내역 탭의 메모에 달린 멘션 알림입니다. 이 메일에 답장해도 메모에는 반영되지 않습니다.
      </p>
    </div>
  </div>
</body></html>`;

  let sent = 0;
  let errorMessage: string | null = null;
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"RAWGA 자금 대시보드" <${GMAIL_USER}>`,
      to,                       // 명단으로 걸러진 주소만
      subject,
      html,
    });
    sent = to.length;
  } catch (e) {
    errorMessage = (e as Error).message;
  }

  /* ④ 보냈든 실패했든 notified_at 을 찍는다.
     ⚠ 실패해도 찍는 이유: 실패를 이유로 비워 두면 화면이 다시 그려질 때마다 재시도가 돌아
       같은 멘션으로 메일 폭탄이 될 수 있다. 실패는 응답으로 알리고 사람이 판단한다. */
  await rest(`cf_notes?id=eq.${noteId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ notified_at: new Date().toISOString() }),
  });

  if (errorMessage) return json({ ok: false, sent: 0, error: `메일 발송 실패: ${errorMessage}` }, 502);
  return json({ ok: true, sent });
});
