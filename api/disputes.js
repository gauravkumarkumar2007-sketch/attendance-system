// api/disputes.js — Employee raises disputes AND leave requests (merged via 'type' column
// to avoid using another Vercel Serverless Function slot). Manager resolves/decides either.
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

function escapeHtml(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function sendTelegramMessage(chatId, text) {
  return new Promise((resolve) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !chatId) return resolve(false);
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
    const options = {
      hostname: "api.telegram.org", path: `/bot${token}/sendMessage`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const r = https.request(options, resp => { let d=""; resp.on("data",c=>d+=c); resp.on("end",()=>resolve(true)); });
    r.on("error", () => resolve(false));
    r.write(body); r.end();
  });
}

// All YYYY-MM-DD dates from start to end inclusive. Capped at 31 days.
function enumerateDates(start, end) {
  const dates = [];
  let cur = new Date(start+"T00:00:00Z");
  const endD = new Date(end+"T00:00:00Z");
  if (isNaN(cur) || isNaN(endD) || endD < cur) return dates;
  while (cur <= endD && dates.length <= 31) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate()+1);
  }
  return dates;
}

async function resolveDispute(record, b, res) {
  const status = b.status || "resolved";
  const reply = String(b.manager_reply||"").trim();
  const ist = new Date(Date.now()+5.5*60*60*1000);
  const h=ist.getUTCHours(), m=ist.getUTCMinutes();
  const ap=h>=12?"PM":"AM", h12=h%12||12;
  const resolvedAt = `${h12}:${String(m).padStart(2,"0")} ${ap}, ${ist.toISOString().split("T")[0]}`;

  await dbQuery(
    `UPDATE disputes SET status=?, manager_reply=?, resolved_at=? WHERE id=?`,
    [status, reply, resolvedAt, record.id]
  );

  try {
    const empRows = await dbQuery("SELECT name, telegram_user_id FROM employees WHERE employee_id=?", [record.employee_id]);
    const emp = empRows[0];
    if (emp && emp.telegram_user_id) {
      const msg = `💬 <b>Dispute Update</b>\n${escapeHtml(String(record.issue||"").slice(0,120))}\n\nReply: ${escapeHtml(reply||"(no message)")}`;
      await sendTelegramMessage(emp.telegram_user_id, msg);
    }
  } catch(e) {}

  res.status(200).json({success:true, message:"Dispute updated!"});
}

async function decideLeave(record, b, res) {
  const decision = b.decision;
  if (!["approved_paid","approved_unpaid","rejected"].includes(decision))
    return res.status(400).json({error:"decision must be approved_paid, approved_unpaid, or rejected"});

  const note = String(b.manager_reply||"").trim().slice(0,200);
  const ist = new Date(Date.now()+5.5*60*60*1000);
  const h=ist.getUTCHours(), m=ist.getUTCMinutes();
  const ap=h>=12?"PM":"AM", h12=h%12||12;
  const resolvedAt = `${h12}:${String(m).padStart(2,"0")} ${ap}, ${ist.toISOString().split("T")[0]}`;
  const isPaid = decision === "approved_paid";

  await dbQuery(
    `UPDATE disputes SET status=?, manager_reply=?, resolved_at=?, is_paid=? WHERE id=?`,
    [decision, note, resolvedAt, decision==="rejected"?null:(isPaid?1:0), record.id]
  );

  if (decision !== "rejected") {
    const dates = enumerateDates(record.date, record.end_date || record.date);
    let dailyRate = 0;
    if (isPaid) {
      const empRows = await dbQuery("SELECT basic_salary FROM employees WHERE employee_id=?", [record.employee_id]);
      const sRows = await dbQuery("SELECT value FROM settings WHERE key='working_days_month'");
      const workDays = parseFloat(sRows[0]?.value || "26");
      dailyRate = parseFloat((empRows[0]||{}).basic_salary || 15000) / workDays;
    }
    const leaveLabel = `${record.leave_type||"leave"} (${isPaid?"Paid":"Unpaid"})`;

    for (const d of dates) {
      const existing = await dbQuery("SELECT id FROM attendance WHERE employee_id=? AND date=?", [record.employee_id, d]);
      if (existing.length) {
        await dbQuery("UPDATE attendance SET status='leave', leave_type=? WHERE employee_id=? AND date=?",
          [leaveLabel, record.employee_id, d]);
      } else {
        await dbQuery("INSERT INTO attendance (employee_id, date, status, leave_type) VALUES (?,?,'leave',?)",
          [record.employee_id, d, leaveLabel]);
      }

      if (isPaid) {
        const [y, mo] = d.split("-").map(Number);
        const existingSal = await dbQuery("SELECT id FROM monthly_salary WHERE employee_id=? AND month=? AND year=?", [record.employee_id, mo, y]);
        const amt = Math.round(dailyRate*100)/100;
        if (existingSal.length) {
          await dbQuery(
            `UPDATE monthly_salary SET basic_earned=basic_earned+?, net_salary=net_salary+?, updated_at=datetime('now') WHERE employee_id=? AND month=? AND year=?`,
            [amt, amt, record.employee_id, mo, y]
          );
        } else {
          await dbQuery(
            `INSERT INTO monthly_salary(employee_id,month,year,basic_earned,net_salary) VALUES(?,?,?,?,?)`,
            [record.employee_id, mo, y, amt, amt]
          );
        }
      }
    }
  }

  try {
    const empRows = await dbQuery("SELECT name, telegram_user_id FROM employees WHERE employee_id=?", [record.employee_id]);
    const emp = empRows[0];
    if (emp && emp.telegram_user_id) {
      const dateRange = record.end_date && record.end_date !== record.date ? `${record.date} to ${record.end_date}` : record.date;
      const msg = decision === "rejected"
        ? `❌ <b>Leave Request Rejected</b>\n${dateRange}${note?"\nReason: "+escapeHtml(note):""}`
        : `✅ <b>Leave Approved (${isPaid?"Paid":"Unpaid"})</b>\n${dateRange}${note?"\nNote: "+escapeHtml(note):""}`;
      await sendTelegramMessage(emp.telegram_user_id, msg);
    }
  } catch(e) {}

  res.status(200).json({success:true, message:`Leave ${decision}!`});
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  try {
    // GET — list disputes/leaves (filterable by employee_id, status, and/or type)
    if (req.method==="GET") {
      const { employee_id, status, type } = req.query||{};
      const conditions = [], params = [];
      if (employee_id) { conditions.push("d.employee_id=?"); params.push(employee_id); }
      if (status)      { conditions.push("d.status=?");      params.push(status); }
      if (type)        { conditions.push("d.type=?");        params.push(type); }
      const where = conditions.length ? "WHERE "+conditions.join(" AND ") : "";
      const sql = `SELECT d.*, e.name, e.department FROM disputes d JOIN employees e ON d.employee_id=e.employee_id ${where} ORDER BY d.created_at DESC`;
      const rows = await dbQuery(sql, params);
      return res.status(200).json({success:true, disputes:rows});
    }

    // POST — employee raises a new dispute OR a new leave request (type:'leave' in body)
    if (req.method==="POST") {
      const b = req.body||{};

      if (b.type === "leave") {
        if (!b.employee_id || !b.start_date || !b.end_date)
          return res.status(400).json({error:"employee_id, start_date, end_date required"});
        const dates = enumerateDates(b.start_date, b.end_date);
        if (!dates.length) return res.status(400).json({error:"Invalid date range (end date must be on/after start date, max 31 days)"});
        await dbQuery(
          `INSERT INTO disputes (employee_id, date, end_date, type, leave_type, issue, status) VALUES (?,?,?,'leave',?,?,'pending')`,
          [b.employee_id, b.start_date, b.end_date, b.leave_type||"casual", b.reason||""]
        );
        return res.status(200).json({success:true, message:"Leave request submitted!"});
      }

      if (!b.employee_id || !b.issue)
        return res.status(400).json({error:"employee_id and issue required"});
      await dbQuery(
        `INSERT INTO disputes (employee_id, date, issue, status, type) VALUES (?,?,?,'pending','dispute')`,
        [b.employee_id, b.date||null, b.issue]
      );
      return res.status(200).json({success:true, message:"Dispute submitted!"});
    }

    // PUT — manager resolves a dispute, or decides a leave request
    if (req.method==="PUT") {
      const b = req.body||{};
      if (!b.id) return res.status(400).json({error:"id required"});
      b.id = parseInt(b.id);

      const rows = await dbQuery("SELECT * FROM disputes WHERE id=?", [b.id]);
      if (!rows.length) return res.status(404).json({error:"Not found"});
      const record = rows[0];

      if (record.type === "leave") return await decideLeave(record, b, res);
      return await resolveDispute(record, b, res);
    }

    res.status(405).json({error:"Method not allowed"});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
};
