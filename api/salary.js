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
    late_deduction: 0, manual_bonus: 0, manual_deduction: 0, manual_note: "",
    net_salary: 0,
  };

  res.status(200).json({ success: true, month: m, year: y, salary });
}

// ── Manager: all employees' salary for a month (was salary-all.js) ──
async function allSalary(req, res) {
  const ist   = new Date(Date.now()+5.5*60*60*1000);
  const month = parseInt(req.query?.month) || (ist.getUTCMonth()+1);
  const year  = parseInt(req.query?.year)  || ist.getUTCFullYear();

  const emps = await dbQuery(
    "SELECT employee_id,name,department,designation,basic_salary,ot_rate_per_hour FROM employees WHERE status='active' ORDER BY name"
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
      late_deduction:0, manual_bonus:0, manual_deduction:0, manual_note:"",
      net_salary:0, is_locked:0,
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

// ── Manager: add a manual bonus or deduction to an employee's month (PUT) ──
async function adjustSalary(req, res) {
  const { employee_id, month, year, type, amount, note } = req.body || {};
  if (!employee_id || !month || !year || !type || !amount)
    return res.status(400).json({ error: "employee_id, month, year, type, amount required" });
  if (type !== "bonus" && type !== "deduction")
    return res.status(400).json({ error: "type must be 'bonus' or 'deduction'" });
  const amt = Math.abs(parseFloat(amount));
  if (!amt || amt <= 0) return res.status(400).json({ error: "amount must be a positive number" });

  const sign = type === "bonus" ? 1 : -1;
  const cleanNote = String(note||"").trim().slice(0,100); // keep notes short
  const noteLine = `${type==="bonus"?"+":"-"}₹${amt}${cleanNote?" ("+cleanNote+")":""}`;

  const existing = await dbQuery(
    "SELECT manual_note FROM monthly_salary WHERE employee_id=? AND month=? AND year=?",
    [employee_id, month, year]
  );

  if (existing.length) {
    const col = type === "bonus" ? "manual_bonus" : "manual_deduction";
    const combinedNote = (existing[0].manual_note ? existing[0].manual_note+" | " : "") + noteLine;
    await dbQuery(
      `UPDATE monthly_salary SET ${col}=${col}+?, net_salary=net_salary+?, manual_note=?, updated_at=datetime('now')
       WHERE employee_id=? AND month=? AND year=?`,
      [amt, sign*amt, combinedNote, employee_id, month, year]
    );
  } else {
    await dbQuery(
      `INSERT INTO monthly_salary(employee_id,month,year,manual_bonus,manual_deduction,manual_note,net_salary)
       VALUES(?,?,?,?,?,?,?)`,
      [employee_id, month, year, type==="bonus"?amt:0, type==="deduction"?amt:0, noteLine, sign*amt]
    );
  }

  res.status(200).json({ success:true, message:`${type==="bonus"?"Bonus":"Deduction"} of ₹${amt} added!` });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "PUT") {
      return await adjustSalary(req, res);
    }
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    if (req.query?.employee_id) {
      return await personalSalary(req, res);
    }
    return await allSalary(req, res);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
