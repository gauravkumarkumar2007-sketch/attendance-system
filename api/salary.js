// api/salary.js — Get monthly salary summary
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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { employee_id, month, year } = req.query || {};
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });

    // Default to current IST month
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

    res.status(200).json({
      success: true,
      month:   m,
      year:    y,
      salary,
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
