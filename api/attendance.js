// api/attendance.js — Personal attendance history (GET ?employee_id=)
//                      + Manager day view (GET ?date=) + Manager edit/add (PUT)
// Merged from attendance.js + attendance-all.js to save a Vercel Serverless Function slot.
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

// ── Manager view: attendance for a single day (was attendance-all.js GET) ──
async function managerDayView(req, res) {
  const { date, employee_id } = req.query || {};
  const ist   = new Date(Date.now()+5.5*60*60*1000);
  const today = date || ist.toISOString().split("T")[0];

  if (employee_id) {
    // Single-employee filter: just that person's record for the day — do NOT compute
    // "absent" against all employees here (that previously mislabeled everyone else as absent).
    const att = await dbQuery(
      `SELECT a.*, e.name, e.department FROM attendance a
       JOIN employees e ON a.employee_id=e.employee_id
       WHERE a.employee_id=? AND a.date=? ORDER BY a.checkin_time`,
      [employee_id, today]
    );
    if (att.length) {
      return res.status(200).json({
        success:true, date:today, attendance:att, absent:[],
        present_count:att.length, absent_count:0,
      });
    }
    const empRows = await dbQuery(
      "SELECT employee_id,name,department FROM employees WHERE employee_id=?",
      [employee_id]
    );
    const absent = empRows.map(e=>({...e, date:today, status:"absent", checkin_time:null, checkout_time:null}));
    return res.status(200).json({
      success:true, date:today, attendance:[], absent,
      present_count:0, absent_count:absent.length,
    });
  }

  const att = await dbQuery(
    `SELECT a.*, e.name, e.department FROM attendance a
     JOIN employees e ON a.employee_id=e.employee_id
     WHERE a.date=? ORDER BY e.name`,
    [today]
  );
  const allEmps = await dbQuery(
    "SELECT employee_id, name, department FROM employees WHERE status='active' ORDER BY name"
  );
  const presentIds = new Set(att.map(a=>a.employee_id));
  const absent = allEmps.filter(e=>!presentIds.has(e.employee_id)).map(e=>({
    ...e, date:today, status:"absent", checkin_time:null, checkout_time:null
  }));

  res.status(200).json({
    success: true, date: today,
    attendance: att, absent,
    present_count: att.length, absent_count: absent.length,
  });
}

// ── Personal view: attendance history for one employee (was attendance.js GET) ──
async function personalHistory(req, res) {
  const { employee_id, month, year } = req.query || {};
  if (!employee_id) return res.status(400).json({ error: "employee_id required" });

  let sql    = "SELECT * FROM attendance WHERE employee_id=?";
  let params = [employee_id];

  if (month && year) {
    const m     = parseInt(month);
    const y     = parseInt(year);
    const start = `${y}-${String(m).padStart(2,"0")}-01`;
    const end   = `${y}-${String(m).padStart(2,"0")}-31`;
    sql    = "SELECT * FROM attendance WHERE employee_id=? AND date>=? AND date<=? ORDER BY date DESC";
    params = [employee_id, start, end];
  } else {
    sql    = "SELECT * FROM attendance WHERE employee_id=? ORDER BY date DESC LIMIT 30";
    params = [employee_id];
  }

  const rows = await dbQuery(sql, params);
  res.status(200).json({ success: true, attendance: rows });
}

// ── Manager edit/add attendance record (was attendance-all.js PUT) ──
async function managerEdit(req, res) {
  const b = req.body || {};

  const existing = await dbQuery(
    "SELECT id FROM attendance WHERE employee_id=? AND date=?",
    [b.employee_id, b.date]
  );

  if (existing.length) {
    await dbQuery(
      `UPDATE attendance SET
        checkin_time=?, checkout_time=?, working_hours=?,
        early_ot_hours=?, late_ot_hours=?, deduction_hours=?,
        is_sunday=?, ot_multiplier=?, checkin_status=?,
        checkout_status=?, status=?
      WHERE employee_id=? AND date=?`,
      [b.checkin_time||null, b.checkout_time||null,
       parseFloat(b.working_hours||0), parseFloat(b.early_ot_hours||0),
       parseFloat(b.late_ot_hours||0), parseFloat(b.deduction_hours||0),
       parseInt(b.is_sunday||0), parseFloat(b.ot_multiplier||1.0),
       b.checkin_status||"normal", b.checkout_status||"normal",
       b.status||"present", b.employee_id, b.date]
    );
  } else {
    await dbQuery(
      `INSERT INTO attendance
        (employee_id, date, checkin_time, checkout_time, working_hours,
         early_ot_hours, late_ot_hours, deduction_hours, is_sunday,
         ot_multiplier, checkin_status, checkout_status, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.employee_id, b.date,
       b.checkin_time||null, b.checkout_time||null,
       parseFloat(b.working_hours||0), parseFloat(b.early_ot_hours||0),
       parseFloat(b.late_ot_hours||0), parseFloat(b.deduction_hours||0),
       parseInt(b.is_sunday||0), parseFloat(b.ot_multiplier||1.0),
       b.checkin_status||"normal", b.checkout_status||"normal",
       b.status||"present"]
    );
  }
  res.status(200).json({ success:true, message:"Attendance saved!" });
}

// ── Manager disapproves attendance (e.g. selfie mismatch) → marks the day
//    absent and reverses any salary already credited for that day, using the
//    exact earning_* snapshot saved at checkout time (so the reversal is precise). ──
async function disapproveAttendance(req, res) {
  const { employee_id, date } = req.body || {};
  if (!employee_id || !date)
    return res.status(400).json({ error: "employee_id and date required" });

  const rows = await dbQuery(
    "SELECT * FROM attendance WHERE employee_id=? AND date=?",
    [employee_id, date]
  );
  if (!rows.length)
    return res.status(404).json({ error: "No attendance record found for this date" });

  const a = rows[0];
  if (a.status === "absent")
    return res.status(400).json({ error: "Already marked absent" });

  // If checkout already happened, salary for this day was credited — reverse it.
  const earningTotal = parseFloat(a.earning_total || 0);
  if (a.checkout_time && earningTotal > 0) {
    const [y, m] = date.split("-").map(Number);
    await dbQuery(
      `UPDATE monthly_salary SET
        total_present    = MAX(0, total_present-1),
        basic_earned     = MAX(0, basic_earned - ?),
        normal_ot_amount = MAX(0, normal_ot_amount - ?),
        late_deduction   = MAX(0, late_deduction - ?),
        net_salary       = net_salary - ?,
        updated_at = datetime('now')
      WHERE employee_id=? AND month=? AND year=?`,
      [parseFloat(a.earning_basic||0), parseFloat(a.earning_ot||0),
       parseFloat(a.earning_deduction||0), earningTotal,
       employee_id, m, y]
    );
  }

  // Mark the day absent and zero out pay fields so it can't be double-counted later.
  await dbQuery(
    `UPDATE attendance SET
      status='absent', checkin_status='disapproved', checkout_status='disapproved',
      working_hours=0, early_ot_hours=0, late_ot_hours=0, deduction_hours=0,
      earning_basic=0, earning_ot=0, earning_deduction=0, earning_total=0
    WHERE employee_id=? AND date=?`,
    [employee_id, date]
  );

  res.status(200).json({ success:true, message:"Attendance disapproved — marked absent, salary reversed." });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      // ?date= present → manager day view. Otherwise → personal history.
      if (req.query?.date !== undefined) {
        return await managerDayView(req, res);
      }
      return await personalHistory(req, res);
    }

    if (req.method === "PUT") {
      if (req.body && req.body.disapprove) {
        return await disapproveAttendance(req, res);
      }
      return await managerEdit(req, res);
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
