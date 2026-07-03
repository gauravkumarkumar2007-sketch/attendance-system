// api/salary.js — Personal salary summary (GET ?employee_id=) + Manager all-employee salary (GET without employee_id)
// Merged from salary.js + salary-all.js to save a Vercel Serverless Function slot.
const https = require("https");

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const rawUrl = process.env.TURSO_DATABASE_URL;
    const token  = process.env.TURSO_AUTH_TOKEN;
    if (!rawUrl) return reject(new Error("TURSO_DATABASE_URL not set"));
    const httpUrl = rawUrl.trim().replace("libsql://", "https://") + "/v2/pipeline";
    let urlObj;
    try { urlObj = new URL(httpUrl); } catch(e) { return reject(new Error("Bad DB URL")); }
    const args = params.map(p => {
      if (p === null || p === undefined) return { type: "null" };
      if (typeof p === "number") {
        if (Number.isInteger(p)) return { type: "integer", value: String(p) };
        return { type: "float", value: p };
      }
      return { type: "text", value: String(p) };
    });
    const stmt = { type: "execute", stmt: args.length ? { sql, args } : { sql } };
    const body = JSON.stringify({ requests: [stmt, { type: "close" }] });
    const options = {
      hostname: urlObj.hostname, path: urlObj.pathname, method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, r => {
      let raw = "";
      r.on("data", d => raw += d);
      r.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error("Turso: " + parsed.error));
          if (!parsed.results) return reject(new Error("Bad response"));
          const resp = parsed.results[0];
          if (!resp || resp.type === "error") return resolve([]);
          const result = resp.response?.result;
          if (!result) return resolve([]);
          const cols = result.cols || [];
          const rows = result.rows || [];
          resolve(rows.map(row => Object.fromEntries(cols.map((c,i) => [c.name, row[i]?.type==="null" ? null : row[i]?.value]))));
        } catch(e) { reject(new Error("Parse error: " + e.message)); }
      });
    });
    req.on("error", e => reject(new Error("Network: " + e.message)));
    req.write(body); req.end();
  });
}

// ── Personal: one employee's monthly summary (was salary.js) ──
async function personalSalary(req, res) {
  const { employee_id, month, year } = req.query || {};

  const ist = new Date(Date.now() + 5.5*60*60*1000);
  const m   = parseInt(month) || (ist.getUTCMonth() + 1);
  const y   = parseInt(year)  || ist.getUTCFullYear();

  const rows = await dbQuery(
    "SELECT * FROM monthly_salary WHERE employee_id=? AND month=? AND year=?",
    [employee_id, m, y]
  );

  const salary = rows[0] || {
    total_present: 0, total_absent: 0, total_late: 0,
    early_ot_hours: 0, late_ot_hours: 0,
    basic_earned: 0, normal_ot_amount: 0,
    late_deduction: 0, net_salary: 0,
  };

  res.status(200).json({ success: true, month: m, year: y, salary });
}

// ── Manager: all employees' salary for a month (was salary-all.js) ──
async function allSalary(req, res) {
  const ist   = new Date(Date.now()+5.5*60*60*1000);
  const month = parseInt(req.query?.month) || (ist.getUTCMonth()+1);
  const year  = parseInt(req.query?.year)  || ist.getUTCFullYear();

  const emps = await dbQuery(
    "SELECT employee_id,name,department,basic_salary,ot_rate_per_hour FROM employees WHERE status='active' ORDER BY name"
  );

  const salRows = await dbQuery(
    "SELECT * FROM monthly_salary WHERE month=? AND year=?",
    [month, year]
  );
  const salMap = Object.fromEntries(salRows.map(s=>[s.employee_id, s]));

  const sRows    = await dbQuery("SELECT value FROM settings WHERE key='working_days_month'");
  const workDays = parseFloat(sRows[0]?.value || "26");

  const result = emps.map(e=>{
    const sal = salMap[e.employee_id] || {
      total_present:0, total_absent:0, total_late:0,
      early_ot_hours:0, late_ot_hours:0,
      basic_earned:0, normal_ot_amount:0,
      late_deduction:0, net_salary:0, is_locked:0,
    };
    const hasManualOT = e.ot_rate_per_hour !== null && e.ot_rate_per_hour !== undefined
      && e.ot_rate_per_hour !== "" && parseFloat(e.ot_rate_per_hour) > 0;
    const effectiveOTRate = hasManualOT
      ? parseFloat(e.ot_rate_per_hour)
      : Math.round((parseFloat(e.basic_salary||15000) / workDays / 8) * 100) / 100;
    return { ...e, ...sal, effective_ot_rate: effectiveOTRate, ot_rate_mode: hasManualOT ? "manual" : "auto" };
  });

  res.status(200).json({ success:true, month, year, employees:result });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  try {
    if (req.query?.employee_id) {
      return await personalSalary(req, res);
    }
    return await allSalary(req, res);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
