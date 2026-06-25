// api/checkin.js
const https = require("https");

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const rawUrl = process.env.TURSO_DATABASE_URL;
    const token  = process.env.TURSO_AUTH_TOKEN;
    if (!rawUrl) return reject(new Error("TURSO_DATABASE_URL not set"));
    if (!token)  return reject(new Error("TURSO_AUTH_TOKEN not set"));

    const httpUrl = rawUrl.trim().replace("libsql://", "https://") + "/v2/pipeline";

    let urlObj;
    try { urlObj = new URL(httpUrl); }
    catch(e) { return reject(new Error("Bad DB URL: " + httpUrl)); }

    // Build args — only include if we have params
    const args = params.map(p => {
      if (p === null || p === undefined) return { type: "null" };
      if (typeof p === "number") {
        if (Number.isInteger(p)) return { type: "integer", value: String(p) };
        return { type: "float", value: String(p) };
      }
      return { type: "text", value: String(p) };
    });

    const stmt  = { type: "execute", stmt: args.length ? { sql, args } : { sql } };
    const reqBody = JSON.stringify({ requests: [stmt, { type: "close" }] });

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   "POST",
      headers:  {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(reqBody),
      },
    };

    const req = https.request(options, (r) => {
      let raw = "";
      r.on("data", d => raw += d);
      r.on("end", () => {
        try {
          const parsed = JSON.parse(raw);

          // Handle Turso error response
          if (parsed.error) return reject(new Error("Turso: " + parsed.error));
          if (!parsed.results) return reject(new Error("Turso bad response: " + raw.substring(0, 200)));

          const resp = parsed.results[0];
          if (!resp) return reject(new Error("No result in response"));
          if (resp.type === "error") return reject(new Error(resp.error?.message || "DB error"));

          const result = resp.response?.result;
          if (!result) return resolve([]); // INSERT/UPDATE returns no rows

          const cols = result.cols || [];
          const rows = result.rows || [];
          resolve(rows.map(row =>
            Object.fromEntries(cols.map((c, i) => [
              c.name,
              row[i]?.type === "null" ? null : row[i]?.value
            ]))
          ));
        } catch(e) {
          reject(new Error("Parse error: " + e.message + " | Raw: " + raw.substring(0, 100)));
        }
      });
    });
    req.on("error", e => reject(new Error("Network error: " + e.message)));
    req.write(reqBody);
    req.end();
  });
}

function getIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes();
  const ap = h >= 12 ? "PM" : "AM", h12 = h % 12 || 12;
  return {
    today:   ist.toISOString().split("T")[0],
    h, m, day: ist.getUTCDay(),
    nowMins: h * 60 + m,
    timeStr: `${h12}:${String(m).padStart(2, "0")} ${ap}`
  };
}

function toMins(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

function getDist(la1, lo1, la2, lo2) {
  const R = 6371000;
  const dL = (la2-la1) * Math.PI/180, dl = (lo2-lo1) * Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const { telegram_user_id, location_lat, location_lng, selfie_base64 = "" } = body;

    if (!telegram_user_id)
      return res.status(400).json({ error: "telegram_user_id required" });

    // Get employee
    const emps = await dbQuery(
      "SELECT * FROM employees WHERE telegram_user_id=? AND status='active'",
      [telegram_user_id]
    );
    if (!emps.length)
      return res.status(404).json({ error: "Employee not found: " + telegram_user_id });
    const emp = emps[0];

    // Get settings
    const sRows = await dbQuery("SELECT key, value FROM settings");
    const s = Object.fromEntries(sRows.map(r => [r.key, r.value]));

    const { today, h, m, day, nowMins, timeStr } = getIST();

    // Already checked in?
    const existing = await dbQuery(
      "SELECT checkin_time FROM attendance WHERE employee_id=? AND date=?",
      [emp.employee_id, today]
    );
    if (existing.length && existing[0].checkin_time)
      return res.status(400).json({ error: "Already checked in today at " + existing[0].checkin_time });

    // Location check
    if (location_lat && location_lng) {
      const dist = getDist(
        parseFloat(location_lat), parseFloat(location_lng),
        parseFloat(s.office_lat || "28.6139"),
        parseFloat(s.office_lng || "77.2090")
      );
      const radius = parseFloat(s.radius_meters || "100");
      if (dist > radius)
        return res.status(400).json({ error: `Too far from office (${Math.round(dist)}m away, max ${radius}m)` });
    }

    // Time zone
    let zone;
    if      (nowMins < toMins(s.early_ot_cutoff    || "09:30")) zone = "early_ot";
    else if (nowMins < toMins(s.normal_end          || "10:05")) zone = "normal";
    else if (nowMins < toMins(s.manager_zone_end    || "10:30")) zone = "manager_zone";
    else                                                          zone = "late_deduct";

    const earlyOT = zone === "early_ot"    ? Math.max(0, (600 - nowMins) / 60) : 0;
    const deduct  = zone === "late_deduct" ? Math.max(0, (nowMins - 600) / 60) : 0;
    const isSun   = day === 0 ? 1 : 0;
    const hol     = await dbQuery("SELECT id FROM holidays WHERE date=?", [today]);
    const isHol   = hol.length ? 1 : 0;
    const otMul   = (isSun || isHol) ? 2.0 : 1.0;

    // Save to DB
    await dbQuery(
      `INSERT INTO attendance
        (employee_id, date, checkin_time, early_ot_hours, is_sunday,
         is_holiday, ot_multiplier, checkin_status, deduction_hours,
         location_lat, location_lng, selfie_base64, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'present')`,
      [emp.employee_id, today, timeStr, earlyOT, isSun,
       isHol, otMul, zone, deduct,
       location_lat || null, location_lng || null,
       selfie_base64.substring(0, 100)]
    );

    if (zone === "manager_zone") {
      await dbQuery(
        "INSERT INTO manager_approvals(employee_id,date,checkin_time,decision) VALUES(?,?,?,'pending')",
        [emp.employee_id, today, timeStr]
      );
    }

    res.status(200).json({
      success:       true,
      message:       "Check-in successful!",
      employee:      emp.name,
      employee_id:   emp.employee_id,
      time:          timeStr,
      zone,
      early_ot:      Math.round(earlyOT * 100) / 100,
      deduction:     Math.round(deduct  * 100) / 100,
      is_sunday:     !!isSun,
      ot_multiplier: otMul,
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
