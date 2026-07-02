// api/attendance-all.js — All employees attendance (manager)
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
  res.setHeader("Access-Control-Allow-Methods","GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  try {
    // GET — fetch attendance records
    if (req.method==="GET") {
      const {date, employee_id} = req.query||{};
      const ist   = new Date(Date.now()+5.5*60*60*1000);
      const today = date || ist.toISOString().split("T")[0];

      let sql, params;
      if (employee_id) {
        sql    = `SELECT a.*, e.name, e.department FROM attendance a
                  JOIN employees e ON a.employee_id=e.employee_id
                  WHERE a.employee_id=? AND a.date=? ORDER BY a.checkin_time`;
        params = [employee_id, today];
      } else {
        // All employees for a date
        sql    = `SELECT a.*, e.name, e.department FROM attendance a
                  JOIN employees e ON a.employee_id=e.employee_id
                  WHERE a.date=? ORDER BY e.name`;
        params = [today];
      }

      const att  = await dbQuery(sql, params);

      // Also get absent employees (not in attendance table for this date)
      const allEmps = await dbQuery(
        "SELECT employee_id, name, department FROM employees WHERE status='active' ORDER BY name"
      );
      const presentIds = new Set(att.map(a=>a.employee_id));
      const absent = allEmps.filter(e=>!presentIds.has(e.employee_id)).map(e=>({
        ...e, date:today, status:"absent", checkin_time:null, checkout_time:null
      }));

      return res.status(200).json({
        success:true, date:today,
        attendance: att,
        absent:     absent,
        present_count: att.length,
        absent_count:  absent.length,
      });
    }

    // PUT — edit or manually add attendance record
    if (req.method==="PUT") {
      const b = req.body||{};

      // Check if record exists
      const existing = await dbQuery(
        "SELECT id FROM attendance WHERE employee_id=? AND date=?",
        [b.employee_id, b.date]
      );

      if (existing.length) {
        // Update existing
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
        // Insert new (manual entry)
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
      return res.status(200).json({success:true, message:"Attendance saved!"});
    }

    res.status(405).json({error:"Method not allowed"});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
};
