// api/salary-all.js — All employees salary (manager)
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
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="GET")     return res.status(405).json({error:"Method not allowed"});

  try {
    const ist   = new Date(Date.now()+5.5*60*60*1000);
    const month = parseInt(req.query?.month) || (ist.getUTCMonth()+1);
    const year  = parseInt(req.query?.year)  || ist.getUTCFullYear();

    // Get all active employees
    const emps = await dbQuery(
      "SELECT employee_id,name,department,basic_salary,ot_rate_per_hour FROM employees WHERE status='active' ORDER BY name"
    );

    // Get salary records for this month
    const salRows = await dbQuery(
      "SELECT * FROM monthly_salary WHERE month=? AND year=?",
      [month, year]
    );
    const salMap = Object.fromEntries(salRows.map(s=>[s.employee_id, s]));

    // Merge
    const result = emps.map(e=>{
      const sal = salMap[e.employee_id] || {
        total_present:0, total_absent:0, total_late:0,
        early_ot_hours:0, late_ot_hours:0,
        basic_earned:0, normal_ot_amount:0,
        late_deduction:0, net_salary:0, is_locked:0,
      };
      return { ...e, ...sal };
    });

    res.status(200).json({success:true, month, year, employees:result});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
};
