// api/disputes.js — Employee raises, Manager resolves
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
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  try {
    // GET — list disputes (employee's own, or all for manager)
    if (req.method==="GET") {
      const { employee_id, status } = req.query||{};
      let sql, params;
      if (employee_id) {
        sql    = `SELECT d.*, e.name FROM disputes d JOIN employees e ON d.employee_id=e.employee_id WHERE d.employee_id=? ORDER BY d.created_at DESC`;
        params = [employee_id];
      } else if (status) {
        sql    = `SELECT d.*, e.name, e.department FROM disputes d JOIN employees e ON d.employee_id=e.employee_id WHERE d.status=? ORDER BY d.created_at DESC`;
        params = [status];
      } else {
        sql    = `SELECT d.*, e.name, e.department FROM disputes d JOIN employees e ON d.employee_id=e.employee_id ORDER BY d.created_at DESC`;
        params = [];
      }
      const rows = await dbQuery(sql, params);
      return res.status(200).json({success:true, disputes:rows});
    }

    // POST — employee raises a new dispute
    if (req.method==="POST") {
      const b = req.body||{};
      if (!b.employee_id || !b.issue)
        return res.status(400).json({error:"employee_id and issue required"});
      await dbQuery(
        `INSERT INTO disputes (employee_id, date, issue, status) VALUES (?,?,?,'pending')`,
        [b.employee_id, b.date||null, b.issue]
      );
      return res.status(200).json({success:true, message:"Dispute submitted!"});
    }

    // PUT — manager resolves/replies
    if (req.method==="PUT") {
      const b = req.body||{};
      if (!b.id) return res.status(400).json({error:"Dispute id required"});

      const ist = new Date(Date.now()+5.5*60*60*1000);
      const h=ist.getUTCHours(), m=ist.getUTCMinutes();
      const ap=h>=12?"PM":"AM", h12=h%12||12;
      const resolvedAt = `${h12}:${String(m).padStart(2,"0")} ${ap}, ${ist.toISOString().split("T")[0]}`;

      await dbQuery(
        `UPDATE disputes SET status=?, manager_reply=?, resolved_at=? WHERE id=?`,
        [b.status||"resolved", b.manager_reply||"", resolvedAt, b.id]
      );
      return res.status(200).json({success:true, message:"Dispute updated!"});
    }

    res.status(405).json({error:"Method not allowed"});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
};
