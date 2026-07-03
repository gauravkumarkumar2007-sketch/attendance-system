// api/checkout.js — Check-out + Salary Calculation
// FIX: month/year now declared before use (was causing a ReferenceError crash on every checkout).
// FIX: daily rate now uses the "working_days_month" setting (matches Settings page field) instead of raw calendar days.
const https = require("https");

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const url   = (process.env.TURSO_DATABASE_URL||"").trim().replace("libsql://","https://") + "/v2/pipeline";
    const token = process.env.TURSO_AUTH_TOKEN;
    const args = params.map(p => {
      if (p === null || p === undefined) return { type: "null" };
      if (typeof p === "number") {
        if (Number.isInteger(p)) return { type: "integer", value: String(p) };
        return { type: "float", value: p };
      }
      return { type: "text", value: String(p) };
    });
    const body = JSON.stringify({ requests: [{ type:"execute", stmt:{ sql, args }}, { type:"close" }]});
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname, path: urlObj.pathname, method: "POST",
      headers: { "Authorization":`Bearer ${token}`, "Content-Type":"application/json", "Content-Length":Buffer.byteLength(body) }
    };
    const req = https.request(options, r => {
      let data = "";
      r.on("data", d => data += d);
      r.on("end", () => {
        try {
          const result = JSON.parse(data);
          const resp   = result.results[0];
          if (resp.type === "error") return reject(new Error(resp.error.message));
          const { cols, rows } = resp.response.result;
          resolve(rows.map(row => Object.fromEntries(cols.map((c,i) => [c.name, row[i].type==="null" ? null : row[i].value]))));
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

function getIST() {
  const ist = new Date(Date.now() + 5.5*60*60*1000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), day = ist.getUTCDay();
  const ap = h >= 12 ? "PM" : "AM", h12 = h%12||12;
  return { today: ist.toISOString().split("T")[0], h, m, day,
           month: ist.getUTCMonth()+1, year: ist.getUTCFullYear(),
           nowMins: h*60+m, timeStr: `${h12}:${String(m).padStart(2,"0")} ${ap}` };
}

function toMins(t) { const [h,m]=t.split(":").map(Number); return h*60+m; }

function parse12h(t) {
  try {
    const [time, ap] = t.trim().split(" ");
    let [h, m] = time.split(":").map(Number);
    if (ap==="PM" && h!==12) h+=12;
    if (ap==="AM" && h===12) h=0;
    return h*60+m;
  } catch { return 9*60; }
}

// Escapes the few characters that matter for Telegram's HTML parse mode.
function escapeHtml(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// Sends a message via the Telegram Bot API. Fails silently (never throws) —
// a missing bot token, un-started chat, or network hiccup should never break checkout.
function sendTelegramMessage(chatId, text) {
  return new Promise((resolve) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !chatId) return resolve(false);
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${token}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, r => {
      let data=""; r.on("data",d=>data+=d);
      r.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(false));
    req.write(body); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { telegram_user_id, selfie_base64 = "" } = req.body;
    if (!telegram_user_id) return res.status(400).json({ error: "Telegram ID required" });

    const emps = await dbQuery("SELECT * FROM employees WHERE telegram_user_id=? AND status='active'", [telegram_user_id]);
    if (!emps.length) return res.status(404).json({ error: "Employee not found" });
    const emp = emps[0];

    const sRows = await dbQuery("SELECT key,value FROM settings");
    const s = Object.fromEntries(sRows.map(r => [r.key, r.value]));

    // month/year now come from getIST() itself, declared before any use below.
    const { today, nowMins, timeStr, month, year } = getIST();

    const att = await dbQuery("SELECT * FROM attendance WHERE employee_id=? AND date=?", [emp.employee_id, today]);
    if (!att.length || !att[0].checkin_time) return res.status(400).json({ error: "Not checked in today" });
    if (att[0].checkout_time) return res.status(400).json({ error: "Already checked out today" });
    const a = att[0];

    const coolS = toMins(s.cooling_start || "17:50");
    const coolE = toMins(s.cooling_end   || "18:10");
    const offE  = toMins(s.office_end    || "18:00");

    let zone;
    if      (nowMins < coolS)  zone = "early_exit";
    else if (nowMins <= coolE) zone = "cooling";
    else                       zone = "late_ot";

    const inMins     = parse12h(a.checkin_time);
    const workMins   = Math.max(0, nowMins - inMins);
    const otMul      = parseFloat(a.ot_multiplier || 1);
    const basic      = parseFloat(emp.basic_salary || 15000);
    const workDays   = parseFloat(s.working_days_month || "26");
    const dailyRate  = basic / workDays;
    const hourlyRate = dailyRate / 8;

    // OT rate: manual value on the employee record wins; otherwise auto-calculate
    // from basic salary (hourlyRate), so it stays in sync if basic salary changes.
    // (0/null/blank all mean "no manual rate set" — the DB column defaults to 0.)
    const hasManualOT = emp.ot_rate_per_hour !== null && emp.ot_rate_per_hour !== undefined
      && emp.ot_rate_per_hour !== "" && parseFloat(emp.ot_rate_per_hour) > 0;
    const otRate       = hasManualOT ? parseFloat(emp.ot_rate_per_hour) : hourlyRate;

    const isSundayOrHoliday = otMul > 1;

    // ── Sunday/Holiday: the ENTIRE day's work is OT, paid at 2x rate.
    //    No daily/base rate, no early/late deductions apply on these days. ──
    let reportedEarlyOT, reportedLateOT, reportedOTAmt, reportedDailyRate, reportedDeduct, todayEarn;

    if (isSundayOrHoliday) {
      // Sunday/Holiday: the day's base salary is paid as usual, PLUS the entire
      // work done that day counts as OT on top, at 2x rate. No deductions apply.
      const holidayHours = Math.round(workMins/60 * 100) / 100;
      reportedEarlyOT   = 0;
      reportedLateOT    = holidayHours;                      // full day shows up as "OT hours"
      reportedDailyRate = dailyRate;                         // base pay still applies
      reportedDeduct    = 0;                                 // no deductions on a holiday
      reportedOTAmt     = Math.round(holidayHours * otRate * otMul * 100) / 100;
      todayEarn         = Math.round((dailyRate + reportedOTAmt) * 100) / 100;
    } else {
      const earlyOT     = parseFloat(a.early_ot_hours || 0);
      const lateOT      = zone === "late_ot"    ? Math.max(0, (nowMins-coolE)/60) : 0;
      const exitDeduct  = zone === "early_exit" ? Math.max(0, (offE-nowMins)/60)  : 0;

      const earlyOTAmt    = earlyOT * otRate;                // normal days: OT always at 1x (otMul is 1 here)
      const lateOTAmt     = lateOT  * otRate;
      const lateDeduct    = parseFloat(a.deduction_hours || 0) * hourlyRate;
      const exitDeductAmt = exitDeduct * hourlyRate;

      reportedEarlyOT   = earlyOT;
      reportedLateOT    = lateOT;
      reportedDailyRate = dailyRate;
      reportedDeduct    = lateDeduct + exitDeductAmt;
      reportedOTAmt     = earlyOTAmt + lateOTAmt;
      todayEarn         = Math.round((dailyRate + reportedOTAmt - reportedDeduct) * 100) / 100;
    }

    await dbQuery(`UPDATE attendance SET checkout_time=?,working_hours=?,late_ot_hours=?,checkout_status=?,checkout_selfie_base64=?,
        earning_basic=?,earning_ot=?,earning_deduction=?,earning_total=?
      WHERE employee_id=? AND date=?`,
      [timeStr, Math.round(workMins/60*100)/100, Math.round(reportedLateOT*100)/100, zone, selfie_base64,
       reportedDailyRate, reportedOTAmt, reportedDeduct, todayEarn,
       emp.employee_id, today]);

    const sal = await dbQuery("SELECT * FROM monthly_salary WHERE employee_id=? AND month=? AND year=?", [emp.employee_id, month, year]);

    if (sal.length) {
      await dbQuery(`UPDATE monthly_salary SET total_present=total_present+1,early_ot_hours=early_ot_hours+?,late_ot_hours=late_ot_hours+?,basic_earned=basic_earned+?,normal_ot_amount=normal_ot_amount+?,late_deduction=late_deduction+?,net_salary=net_salary+?,updated_at=datetime('now') WHERE employee_id=? AND month=? AND year=?`,
        [reportedEarlyOT, reportedLateOT, reportedDailyRate, reportedOTAmt, reportedDeduct, todayEarn, emp.employee_id, month, year]);
    } else {
      await dbQuery(`INSERT INTO monthly_salary(employee_id,month,year,total_present,early_ot_hours,late_ot_hours,basic_earned,normal_ot_amount,late_deduction,net_salary) VALUES(?,?,?,1,?,?,?,?,?,?)`,
        [emp.employee_id, month, year, reportedEarlyOT, reportedLateOT, reportedDailyRate, reportedOTAmt, reportedDeduct, todayEarn]);
    }

    const ms = (await dbQuery("SELECT * FROM monthly_salary WHERE employee_id=? AND month=? AND year=?", [emp.employee_id, month, year]))[0] || {};

    // ── Telegram reports: one to the employee, one to the manager group.
    //    Best-effort — never blocks or fails the checkout itself. ──
    try {
      const otHoursTotal = Math.round((reportedEarlyOT + reportedLateOT) * 100) / 100;
      const safeName = escapeHtml(emp.name);
      const employeeMsg =
        `✅ <b>Attendance Report</b> — ${today}\n\n` +
        `Check-in: ${a.checkin_time}\n` +
        `Check-out: ${timeStr}\n` +
        `Working Hours: ${Math.round(workMins/60*100)/100}h\n` +
        `OT Hours: ${otHoursTotal}h\n` +
        `Today's Earning: ₹${todayEarn}\n\n` +
        `<b>This Month</b>\n` +
        `Present: ${ms.total_present||0} | Net Salary: ₹${Math.round(parseFloat(ms.net_salary||0))}`;

      const groupMsg =
        `📋 <b>${safeName}</b> (${emp.employee_id}) checked out\n` +
        `${today} | In: ${a.checkin_time} → Out: ${timeStr}\n` +
        `Hours: ${Math.round(workMins/60*100)/100}h | OT: ${otHoursTotal}h | Earning: ₹${todayEarn}`;

      await Promise.allSettled([
        sendTelegramMessage(emp.telegram_user_id, employeeMsg),
        sendTelegramMessage(s.telegram_group_chat_id, groupMsg),
      ]);
    } catch(e) { /* never fail checkout because of Telegram */ }

    res.status(200).json({
      success: true, employee: emp.name, employee_id: emp.employee_id,
      checkin_time: a.checkin_time, checkout_time: timeStr,
      working_hours: Math.round(workMins/60*100)/100,
      early_ot_hours: reportedEarlyOT, late_ot_hours: reportedLateOT,
      zone, today_earning: todayEarn,
      daily_rate: Math.round(reportedDailyRate*100)/100,
      ot_amount:  Math.round(reportedOTAmt*100)/100,
      deduction:  Math.round(reportedDeduct*100)/100,
      ot_multiplier: otMul,
      is_holiday_pay: isSundayOrHoliday,
      month_summary: {
        present:    parseInt(ms.total_present    || 0),
        absent:     parseInt(ms.total_absent     || 0),
        late:       parseInt(ms.total_late       || 0),
        total_ot:   Math.round((parseFloat(ms.early_ot_hours||0)+parseFloat(ms.late_ot_hours||0))*100)/100,
        basic:      Math.round(parseFloat(ms.basic_earned     ||0)*100)/100,
        ot_amount:  Math.round(parseFloat(ms.normal_ot_amount ||0)*100)/100,
        deductions: Math.round(parseFloat(ms.late_deduction   ||0)*100)/100,
        net_salary: Math.round(parseFloat(ms.net_salary       ||0)*100)/100,
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
