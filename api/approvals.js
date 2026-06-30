// api/approvals.js — Manager approve/reject 10:05-10:30 check-ins
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
    // GET — list pending approvals (or all by status filter)
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

    // POST — approve or reject
    if (req.method==="POST") {
      const b = req.body||{};
      const { employee_id, date, decision, note } = b;
      if (!employee_id || !date || !decision)
        return res.status(400).json({error:"employee_id, date, decision required"});
      if (decision !== "approved" && decision !== "rejected")
        return res.status(400).json({error:"decision must be approved or rejected"});

      const ist = new Date(Date.now()+5.5*60*60*1000);
      const h=ist.getUTCHours(), m=ist.getUTCMinutes();
      const ap=h>=12?"PM":"AM", h12=h%12||12;
      const decidedAt = `${h12}:${String(m).padStart(2,"0")} ${ap}`;

      // Update approval record
      await dbQuery(
        `UPDATE manager_approvals SET decision=?, decided_by='manager', decided_at=?, note=?
         WHERE employee_id=? AND date=?`,
        [decision, decidedAt, note||"", employee_id, date]
      );

      if (decision === "approved") {
        // No deduction — clear it
        await dbQuery(
          `UPDATE attendance SET deduction_hours=0, checkin_status='manager_zone_approved' WHERE employee_id=? AND date=?`,
          [employee_id, date]
        );
      } else {
        // Rejected — apply deduction from 10:00 AM to actual checkin time
        const attRows = await dbQuery(
          "SELECT checkin_time FROM attendance WHERE employee_id=? AND date=?",
          [employee_id, date]
        );
        if (attRows.length) {
          const t = attRows[0].checkin_time;
          try {
            const dt = new Date(`2000-01-01 ${t}`);
            // Parse 12h format manually
            const parts = t.trim().split(" ");
            let [hh,mm] = parts[0].split(":").map(Number);
            if (parts[1]==="PM" && hh!==12) hh+=12;
            if (parts[1]==="AM" && hh===12) hh=0;
            const checkinMins = hh*60+mm;
            const deductHrs = Math.max(0, (checkinMins-600)/60);
            await dbQuery(
              `UPDATE attendance SET deduction_hours=?, checkin_status='manager_zone_rejected' WHERE employee_id=? AND date=?`,
              [deductHrs, employee_id, date]
            );
          } catch(e) {}
        }
      }

      return res.status(200).json({success:true, message:`Check-in ${decision}!`});
    }

    res.status(405).json({error:"Method not allowed"});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
};
