// api/approvals.js — Manager approves/rejects two kinds of pending check-ins:
//   type='early_ot'  (before 9:30 AM) — approve grants the OT hours, reject counts as normal time
//   type='late_zone' (10:05-10:30 AM) — approve waives the deduction, reject applies it
// If checkout already happened before the manager decides, the monthly_salary ledger
// is retroactively corrected by the exact delta (see applyDecision()).
const https = require("https");

function dbQuery(sql, params=[]) {
  return new Promise((resolve,reject)=>{
    const url  =(process.env.TURSO_DATABASE_URL||"").trim().replace("libsql://","https://")+"/v2/pipeline";
    const token=process.env.TURSO_AUTH_TOKEN||"";
    const args =params.map(p=>{
      if(p===null||p===undefined)return{type:"null"};
      if(typeof p==="number"){if(Number.isInteger(p))return{type:"integer",value:String(p)};return{type:"float",value:p};}
      return{type:"text",value:String(p)};
    });
    const stmt={type:"execute",stmt:args.length?{sql,args}:{sql}};
    const body=JSON.stringify({requests:[stmt,{type:"close"}]});
    const u=new URL(url);
    const opts={hostname:u.hostname,path:u.pathname,method:"POST",
      headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
    const req=https.request(opts,r=>{
      let raw="";r.on("data",d=>raw+=d);
      r.on("end",()=>{
        try{
          const parsed=JSON.parse(raw);
          if(!parsed.results)return reject(new Error("Bad response"));
          const resp=parsed.results[0];
          if(!resp||resp.type==="error")return resolve([]);
          const result=resp.response?.result;
          if(!result)return resolve([]);
          const cols=result.cols||[];
          resolve((result.rows||[]).map(row=>Object.fromEntries(cols.map((c,i)=>[c.name,row[i]?.type==="null"?null:row[i]?.value]))));
        }catch(e){reject(new Error("Parse: "+e.message));}
      });
    });
    req.on("error",e=>reject(new Error("Net: "+e.message)));
    req.write(body);req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  try {
    // GET — list approvals by status (includes 'type': 'early_ot' or 'late_zone')
    if (req.method==="GET") {
      const status = req.query?.status || "pending";
      const rows = await dbQuery(
        `SELECT ma.*, e.name, e.department FROM manager_approvals ma
         JOIN employees e ON ma.employee_id=e.employee_id
         WHERE ma.decision=? ORDER BY ma.date DESC, ma.checkin_time DESC`,
        [status]
      );
      return res.status(200).json({success:true, approvals:rows});
    }

    // POST — approve or reject (works for both early_ot and late_zone approvals)
    if (req.method==="POST") {
      const b = req.body||{};
      const { employee_id, date, decision, note } = b;
      if (!employee_id || !date || !decision)
        return res.status(400).json({error:"employee_id, date, decision required"});
      if (decision !== "approved" && decision !== "rejected")
        return res.status(400).json({error:"decision must be approved or rejected"});

      const apprRows = await dbQuery(
        "SELECT * FROM manager_approvals WHERE employee_id=? AND date=? ORDER BY id DESC LIMIT 1",
        [employee_id, date]
      );
      if (!apprRows.length) return res.status(404).json({error:"No pending approval found for this date"});
      const type = apprRows[0].type || "late_zone";

      const ist = new Date(Date.now()+5.5*60*60*1000);
      const h=ist.getUTCHours(), m=ist.getUTCMinutes();
      const ap=h>=12?"PM":"AM", h12=h%12||12;
      const decidedAt = `${h12}:${String(m).padStart(2,"0")} ${ap}`;

      await dbQuery(
        `UPDATE manager_approvals SET decision=?, decided_by='manager', decided_at=?, note=?
         WHERE employee_id=? AND date=?`,
        [decision, decidedAt, note||"", employee_id, date]
      );

      const attRows = await dbQuery("SELECT * FROM attendance WHERE employee_id=? AND date=?", [employee_id, date]);
      if (!attRows.length) return res.status(200).json({success:true, message:`Check-in ${decision}! (no attendance record to update)`});
      const a = attRows[0];

      const checkinMins = parse12h(a.checkin_time);

      if (type === "early_ot") {
        const potentialOT = Math.max(0, (600 - checkinMins) / 60);
        const desiredOT = decision === "approved" ? potentialOT : 0;
        await applyDecision(employee_id, date, a, { field:"early_ot_hours", desired:desiredOT, statusSuffix: decision==="approved"?"early_ot_approved":"early_ot_rejected", isDeduction:false });
      } else {
        const potentialDeduct = Math.max(0, (checkinMins - 600) / 60);
        const desiredDeduct = decision === "rejected" ? potentialDeduct : 0;
        await applyDecision(employee_id, date, a, { field:"deduction_hours", desired:desiredDeduct, statusSuffix: decision==="approved"?"manager_zone_approved":"manager_zone_rejected", isDeduction:true });
      }

      return res.status(200).json({success:true, message:`Check-in ${decision}!`});
    }

    res.status(405).json({error:"Method not allowed"});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
};

// Applies the manager's decision to the attendance row, and — if checkout already
// happened before the decision was made — retroactively corrects the monthly_salary
// ledger by exactly the delta, so the employee's pay reflects the decision either way.
async function applyDecision(employee_id, date, a, { field, desired, statusSuffix, isDeduction }) {
  const current = parseFloat(a[field] || 0);
  const deltaHours = desired - current;

  const alreadyCheckedOut = !!a.checkout_time && parseFloat(a.earning_total||0) !== 0;

  if (!alreadyCheckedOut) {
    // Checkout hasn't happened yet — just update the attendance row.
    // checkout.js will read this field naturally when it eventually runs.
    await dbQuery(
      `UPDATE attendance SET ${field}=?, checkin_status=? WHERE employee_id=? AND date=?`,
      [desired, statusSuffix, employee_id, date]
    );
    return;
  }

  // Checkout already happened — need the employee's rate to convert hours -> rupees,
  // and to patch both the attendance snapshot and the monthly_salary ledger.
  const empRows = await dbQuery("SELECT basic_salary, ot_rate_per_hour FROM employees WHERE employee_id=?", [employee_id]);
  const emp = empRows[0] || {};
  const sRows = await dbQuery("SELECT key,value FROM settings WHERE key='working_days_month'");
  const workDays = parseFloat(sRows[0]?.value || "26");
  const dailyRate = parseFloat(emp.basic_salary||15000) / workDays;
  const hourlyRate = dailyRate / 8;

  const hasManualOT = emp.ot_rate_per_hour !== null && emp.ot_rate_per_hour !== undefined
    && emp.ot_rate_per_hour !== "" && parseFloat(emp.ot_rate_per_hour) > 0;
  const otRate = hasManualOT ? parseFloat(emp.ot_rate_per_hour) : hourlyRate;

  const rate = isDeduction ? hourlyRate : otRate;
  const deltaAmount = Math.round(deltaHours * rate * 100) / 100;
  // OT increases pay (earning_total goes up); deduction decreases pay (earning_total goes down).
  const totalDelta = isDeduction ? -deltaAmount : deltaAmount;

  const [y, mo] = date.split("-").map(Number);

  await dbQuery(
    `UPDATE attendance SET ${field}=?, checkin_status=?,
      earning_${isDeduction?"deduction":"ot"}=earning_${isDeduction?"deduction":"ot"}+?,
      earning_total=earning_total+?
     WHERE employee_id=? AND date=?`,
    [desired, statusSuffix, deltaAmount, totalDelta, employee_id, date]
  );

  await dbQuery(
    `UPDATE monthly_salary SET
      ${isDeduction?"late_deduction":"normal_ot_amount"} = ${isDeduction?"late_deduction":"normal_ot_amount"} + ?,
      net_salary = net_salary + ?,
      updated_at = datetime('now')
     WHERE employee_id=? AND month=? AND year=?`,
    [deltaAmount, totalDelta, employee_id, mo, y]
  );
}

function parse12h(t) {
  if (!t) return 600; // default to 10:00 AM reference if somehow missing
  try {
    const parts = t.trim().split(" ");
    let [hh,mm] = parts[0].split(":").map(Number);
    if (parts[1]==="PM" && hh!==12) hh+=12;
    if (parts[1]==="AM" && hh===12) hh=0;
    return hh*60+mm;
  } catch { return 600; }
}
