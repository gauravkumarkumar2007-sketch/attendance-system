// api/login.js — Employee ID + Password verify
const https = require("https");

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    const url   = (process.env.TURSO_DATABASE_URL||"").trim().replace("libsql://","https://") + "/v2/pipeline";
    const token = process.env.TURSO_AUTH_TOKEN||"";
    const args  = params.map(p => {
      if (p===null||p===undefined) return {type:"null"};
      if (typeof p==="number") {
        if (Number.isInteger(p)) return {type:"integer",value:String(p)};
        return {type:"float",value:p};
      }
      return {type:"text",value:String(p)};
    });
    const stmt = {type:"execute",stmt:args.length?{sql,args}:{sql}};
    const body = JSON.stringify({requests:[stmt,{type:"close"}]});
    const u    = new URL(url);
    const opts = {hostname:u.hostname,path:u.pathname,method:"POST",
      headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
    const req = https.request(opts, r => {
      let raw="";
      r.on("data",d=>raw+=d);
      r.on("end",()=>{
        try {
          const parsed=JSON.parse(raw);
          if(parsed.error) return reject(new Error(parsed.error));
          if(!parsed.results) return reject(new Error("Bad response"));
          const resp=parsed.results[0];
          if(!resp||resp.type==="error") return resolve([]);
          const result=resp.response?.result;
          if(!result) return resolve([]);
          const cols=result.cols||[];
          resolve((result.rows||[]).map(row=>
            Object.fromEntries(cols.map((c,i)=>[c.name,row[i]?.type==="null"?null:row[i]?.value]))
          ));
        } catch(e){reject(new Error("Parse: "+e.message));}
      });
    });
    req.on("error",e=>reject(new Error("Net: "+e.message)));
    req.write(body); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();
  if (req.method!=="POST")    return res.status(405).json({error:"Method not allowed"});

  try {
    const {employee_id, password} = req.body||{};
    if (!employee_id||!password)
      return res.status(400).json({error:"Employee ID and password required"});

    const rows = await dbQuery(
      "SELECT * FROM employees WHERE employee_id=? AND status='active'",
      [employee_id.toUpperCase()]
    );
    if (!rows.length)
      return res.status(404).json({error:"Employee not found"});

    const emp = rows[0];
    if ((emp.password||"1234") !== password)
      return res.status(401).json({error:"Wrong password"});

    // Also get today's attendance
    const ist   = new Date(Date.now()+5.5*60*60*1000);
    const today = ist.toISOString().split("T")[0];
    const att   = await dbQuery(
      "SELECT checkin_time,checkout_time,status FROM attendance WHERE employee_id=? AND date=?",
      [emp.employee_id, today]
    );
    const todayAtt = att[0]||null;

    res.status(200).json({
      success:    true,
      employee: {
        employee_id:       emp.employee_id,
        telegram_user_id:  emp.telegram_user_id,
        name:              emp.name,
        phone:             emp.phone,
        department:        emp.department,
        designation:       emp.designation,
        joining_date:      emp.joining_date,
        basic_salary:      emp.basic_salary,
        ot_rate_per_hour:  emp.ot_rate_per_hour,
        status:            emp.status,
      },
      today_attendance: todayAtt,
    });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
};
