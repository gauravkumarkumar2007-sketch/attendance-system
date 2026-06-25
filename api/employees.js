// api/employees.js — Employee CRUD
const https = require("https");

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const url   = (process.env.TURSO_DATABASE_URL||"").trim().replace("libsql://","https://") + "/v2/pipeline";
    const token = process.env.TURSO_AUTH_TOKEN;
    const args  = params.map(p => {
      if (p === null || p === undefined) return { type: "null" };
      if (typeof p === "number") {
        if (Number.isInteger(p)) return { type: "integer", value: String(p) };
        return { type: "real", value: String(p) };
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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const id = req.query?.id;
      const rows = id
        ? await dbQuery("SELECT * FROM employees WHERE employee_id=?", [id])
        : await dbQuery("SELECT employee_id,telegram_user_id,name,phone,department,designation,joining_date,basic_salary,ot_rate_per_hour,status FROM employees WHERE status='active' ORDER BY name");
      return res.status(200).json({ success: true, employees: rows });
    }

    if (req.method === "POST") {
      const b = req.body;
      await dbQuery(`INSERT INTO employees(employee_id,telegram_user_id,name,phone,department,designation,joining_date,basic_salary,ot_rate_per_hour,status) VALUES(?,?,?,?,?,?,?,?,?,'active')`,
        [b.employee_id,b.telegram_user_id,b.name,b.phone,b.department,b.designation,b.joining_date,b.basic_salary||0,b.ot_rate_per_hour||50]);
      return res.status(200).json({ success: true, message: "Employee added!" });
    }

    if (req.method === "PUT") {
      const b = req.body;
      await dbQuery(`UPDATE employees SET telegram_user_id=?,name=?,phone=?,department=?,designation=?,basic_salary=?,ot_rate_per_hour=?,status=? WHERE employee_id=?`,
        [b.telegram_user_id,b.name,b.phone,b.department,b.designation,b.basic_salary,b.ot_rate_per_hour,b.status||"active",b.employee_id]);
      return res.status(200).json({ success: true, message: "Employee updated!" });
    }

    if (req.method === "DELETE") {
      const b = req.body;
      await dbQuery("UPDATE employees SET status='inactive' WHERE employee_id=?", [b.employee_id]);
      return res.status(200).json({ success: true, message: "Employee deactivated!" });
    }

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
