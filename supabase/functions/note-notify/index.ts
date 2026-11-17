/**
 * note-notify — Supabase Edge Function
 *
 * 입출금 메모의 `@멘션` 과 **답글**을 메일로 알린다.
 *   · 멘션 → 멘션된 사람에게
 *   · 답글 → **그 스레드에 참여한 사람 전원**(원글 작성자 + 먼저 답글을 단 사람들)
 *   둘 다 해당하면 멘션이 이긴다 — 한 사람에게 두 통이 가지 않는다.
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
  const parentId = note.parent_id ? String(note.parent_id) : "";

  /* notified_at 찍기 — 보냈든 못 보냈든 한 번만 돌게 한다.
     ⚠ 실패해도 찍는다: 비워 두면 화면이 다시 그려질 때마다 재시도가 돌아 메일 폭탄이 된다. */
  const markNotified = () =>
    rest(`cf_notes?id=eq.${noteId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ notified_at: new Date().toISOString() }),
    });

  /* 답글이면 **그 스레드에 참여한 사람 전원**이 받는다 — 원글 작성자 + 먼저 답글을 단 사람들.
     대화에 낀 사람이 흐름을 놓치지 않게 (2026-11-17 결정).
     스레드는 2단(원글 + 답글들)이라 '원글 하나 + 그 원글을 부모로 둔 답글들' 이 전부다. */
  let participants: string[] = [];
  let rootBody = "";
  if (parentId) {
    const tRes = await rest(
      `cf_notes?or=(id.eq.${parentId},parent_id.eq.${parentId})&select=id,author_email,body`,
    );
    if (tRes.ok) {
      const thread = (await tRes.json()) as Array<Record<string, unknown>>;
      participants = thread.map((x) => String(x.author_email || ""));
      rootBody = String(thread.find((x) => String(x.id) === parentId)?.body || "");
    }
  }

  if (mentions.length === 0 && participants.length === 0) {
    await markNotified();
    return json({ ok: true, sent: 0, skipped: "no_recipient" });
  }

  /* ② 명단 안에 있는 주소만 남긴다 + 본인 제외 */
  const uRes = await rest(`cat_data?key=eq.dashboard_users&select=data&limit=1`);
  const uRow = uRes.ok ? (await uRes.json())?.[0] : null;
  const roster = Array.isArray(uRow?.data) ? uRow.data as Array<Record<string, unknown>> : [];
  const allowed = new Set(
    roster.map((u) => String(u.email || "").trim().toLowerCase()).filter(Boolean),
  );
  const nameOf = (email: string) =>
    String(roster.find((u) => String(u.email || "").toLowerCase() === email)?.name || email);

  const norm = (e: unknown) => String(e || "").trim().toLowerCase();
  const self = norm(author);
  const pick = (list: string[]) =>
    [...new Set(list.map(norm))].filter((e) => e && allowed.has(e) && e !== self);

  const toMention = pick(mentions);
  const mentionSet = new Set(toMention);
  /* 멘션이 우선 — 멘션도 받고 참여자이기도 하면 **한 통만** 간다 */
  const toReply = pick(participants).filter((e) => !mentionSet.has(e));

  if (toMention.length === 0 && toReply.length === 0) {
    /* 명단 밖이어서 걸렀는지, 본인뿐이어서인지는 구분해 돌려주되 주소는 노출하지 않는다 */
    await markNotified();
    return json({ ok: true, sent: 0, skipped: "no_eligible_recipient" });
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return json({ ok: false, error: "Server configuration error: GMAIL_USER / GMAIL_APP_PASSWORD" }, 500);
  }

  /* ③ 메일 — 주간 리포트와 같은 SMTP 경로 */
  const authorName = nameOf(self);
  const bodyText   = String(note.body || "");
  const isReply    = !!parentId;

  /* 그 메모를 지목해 연다(입출금 탭 + 해당 거래 행 + 메모 창).
     ⚠ 해시가 아니라 **쿼리**로 보낸다 — 구글 로그인 리디렉션이 해시를 토큰으로 덮어쓴다.
       대시보드가 뜨자마자 이 값을 sessionStorage 로 옮겨 로그인 왕복을 견딘다. */
  const deepLink = /^https?:\/\/.+/i.test(DASHBOARD_URL)
    ? `${DASHBOARD_URL.split("#")[0]}${DASHBOARD_URL.includes("?") ? "&" : "?"}note=${encodeURIComponent(noteId)}`
    : "";

  const mailHtml = (lead: string, withRoot: boolean) => `<!DOCTYPE html>
<html lang="ko"><body style="margin:0;padding:0;background:#F2F5F1;font-family:'Malgun Gothic',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#314840;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:14px;font-weight:700">
      RAWGA 자금 대시보드 · 입출금 메모
    </div>
    <div style="background:#fff;border:1px solid rgba(49,72,64,.12);border-top:none;border-radius:0 0 10px 10px;padding:18px">
      <p style="margin:0 0 12px;font-size:13px;color:#55655D">${lead}</p>
      ${withRoot && rootBody ? `<div style="font-size:11px;color:#94A296;margin:0 0 4px">원래 메모</div>
      <div style="background:#F2F5F1;border-radius:4px;padding:9px 12px;font-size:12px;line-height:1.7;color:#55655D;white-space:pre-wrap;margin:0 0 12px">${esc(rootBody.slice(0, 300))}</div>` : ""}
      <div style="background:#F6F9F4;border-left:3px solid #314840;border-radius:4px;padding:12px 14px;font-size:13px;line-height:1.75;color:#1B2B30;white-space:pre-wrap">${esc(bodyText)}</div>
      ${deepLink ? `<p style="margin:16px 0 0"><a href="${esc(deepLink)}" style="display:inline-block;background:#314840;color:#fff;text-decoration:none;font-size:13px;padding:9px 16px;border-radius:7px">대시보드에서 보기</a></p>` : ""}
      <p style="margin:16px 0 0;font-size:11px;color:#94A296">
        입출금 내역 탭의 메모 알림입니다. 이 메일에 답장해도 메모에는 반영되지 않습니다.
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
    const from = `"RAWGA 자금 대시보드" <${GMAIL_USER}>`;

    /* 두 무리는 받는 이유가 달라 제목·첫 줄이 다르다 — 그래서 메일도 따로 나간다(최대 2통) */
    if (toMention.length) {
      await transporter.sendMail({
        from,
        to: toMention,                 // 명단으로 걸러진 주소만
        subject: `[RAWGA 자금] ${authorName}님이 ${isReply ? "답글에서 " : ""}회원님을 언급했습니다`,
        html: mailHtml(
          `<b style="color:#1B2B30">${esc(authorName)}</b> 님이 ${isReply ? "답글에서 " : ""}회원님을 언급했습니다.`,
          isReply,
        ),
      });
      sent += toMention.length;
    }
    if (toReply.length) {
      await transporter.sendMail({
        from,
        to: toReply,
        subject: `[RAWGA 자금] ${authorName}님이 답글을 남겼습니다`,
        html: mailHtml(
          `<b style="color:#1B2B30">${esc(authorName)}</b> 님이 회원님이 참여한 메모에 답글을 남겼습니다.`,
          true,
        ),
      });
      sent += toReply.length;
    }
  } catch (e) {
    errorMessage = (e as Error).message;
    sent = 0;
  }

  await markNotified();

  if (errorMessage) return json({ ok: false, sent: 0, error: `메일 발송 실패: ${errorMessage}` }, 502);
  return json({ ok: true, sent });
});
