// api/attendance.js — Get attendance records
const https = require("https");

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const rawUrl = process.env.TURSO_DATABASE_URL;
    const token  = process.env.TURSO_AUTH_TOKEN;
    if (!rawUrl) return reject(new Error("TURSO_DATABASE_URL not set"));
    if (!token)  return reject(new Error("TURSO_AUTH_TOKEN not set"));
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
          if (!parsed.results) return reject(new Error("Bad response: " + raw.substring(0,100)));
          const resp = parsed.results[0];
          if (!resp) return resolve([]);
          if (resp.type === "error") return reject(new Error(resp.error?.message || "DB error"));
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
    const empId = req.query?.employee_id;
    const month = req.query?.month;
    const year  = req.query?.year;

    if (!empId) return res.status(400).json({ error: "employee_id required" });

    let sql    = "SELECT * FROM attendance WHERE employee_id=?";
    let params = [empId];

    if (month && year) {
      // Get specific month
      const ist   = new Date(Date.now() + 5.5*60*60*1000);
      const m     = parseInt(month);
      const y     = parseInt(year);
      const start = `${y}-${String(m).padStart(2,"0")}-01`;
      const end   = `${y}-${String(m).padStart(2,"0")}-31`;
      sql    = "SELECT * FROM attendance WHERE employee_id=? AND date>=? AND date<=? ORDER BY date DESC";
      params = [empId, start, end];
    } else {
      // Get last 30 records
      sql    = "SELECT * FROM attendance WHERE employee_id=? ORDER BY date DESC LIMIT 30";
      params = [empId];
    }

    const rows = await dbQuery(sql, params);
    res.status(200).json({ success: true, attendance: rows });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
