# api/checkout.py — Self-contained
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timezone, timedelta
import json, os, urllib.request

def db_query(sql, params=None):
    url   = os.environ.get("TURSO_DATABASE_URL","").replace("libsql://","https://") + "/v2/pipeline"
    token = os.environ.get("TURSO_AUTH_TOKEN","")
    args  = []
    if params:
        for p in params:
            if p is None:              args.append({"type":"null"})
            elif isinstance(p, bool):  args.append({"type":"integer","value":"1" if p else "0"})
            elif isinstance(p, int):   args.append({"type":"integer","value":str(p)})
            elif isinstance(p, float): args.append({"type":"float","value":str(p)})
            else:                      args.append({"type":"text","value":str(p)})
    stmt = {"type":"execute","stmt":{"sql":sql}}
    if args: stmt["stmt"]["args"] = args
    body = json.dumps({"requests":[stmt,{"type":"close"}]}).encode()
    req  = urllib.request.Request(url,data=body,
           headers={"Authorization":f"Bearer {token}","Content-Type":"application/json"},method="POST")
    with urllib.request.urlopen(req,timeout=10) as r:
        result = json.loads(r.read())
    resp = result["results"][0]
    if resp["type"]=="error": raise Exception(resp["error"]["message"])
    data = resp["response"]["result"]
    cols = [c["name"] for c in data["cols"]]
    rows = []
    for row in data["rows"]:
        obj={}
        for i,col in enumerate(cols):
            v=row[i]; obj[col]=None if v["type"]=="null" else v["value"]
        rows.append(obj)
    return rows

def send_json(h, status, data):
    body = json.dumps(data).encode()
    h.send_response(status)
    h.send_header("Content-type","application/json")
    h.send_header("Access-Control-Allow-Origin","*")
    h.send_header("Content-Length",str(len(body)))
    h.end_headers(); h.wfile.write(body)

def get_body(h):
    try:
        n = int(h.headers.get("Content-Length",0))
        return json.loads(h.rfile.read(n)) if n>0 else {}
    except: return {}

def get_ist():
    return datetime.now(timezone.utc) + timedelta(hours=5,minutes=30)

def to_mins(t):
    h,m = map(int,t.split(";")); return h*60+m

def to_mins(t):
    parts = t.split(":")
    return int(parts[0])*60 + int(parts[1])

def parse_12h(t):
    try:
        dt = datetime.strptime(t.strip(),"%I:%M %p")
        return dt.hour, dt.minute
    except: return 9,0

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            b   = get_body(self)
            tid = b.get("telegram_user_id")
            if not tid:
                return send_json(self,400,{"error":"Telegram ID required"})

            emps = db_query("SELECT * FROM employees WHERE telegram_user_id=? AND status='active'",[tid])
            if not emps: return send_json(self,404,{"error":"Employee not found"})
            emp = emps[0]

            srows = db_query("SELECT key,value FROM settings")
            s = {r["key"]:r["value"] for r in srows}

            ist   = get_ist()
            today = ist.strftime("%Y-%m-%d")

            att = db_query("SELECT * FROM attendance WHERE employee_id=? AND date=?",
                           [emp["employee_id"],today])
            if not att or not att[0].get("checkin_time"):
                return send_json(self,400,{"error":"Not checked in today"})
            att = att[0]
            if att.get("checkout_time"):
                return send_json(self,400,{"error":"Already checked out today"})

            checkout = ist.strftime("%I:%M %p").lstrip("0")
            now_mins = ist.hour*60 + ist.minute
            in_h,in_m = parse_12h(att["checkin_time"])
            work_mins = max(0, now_mins - (in_h*60+in_m))

            cool_s = to_mins(s.get("cooling_start","17:50"))
            cool_e = to_mins(s.get("cooling_end","18:10"))
            off_e  = to_mins(s.get("office_end","18:00"))

            if   now_mins < cool_s:  zone = "early_exit"
            elif now_mins <= cool_e: zone = "cooling"
            else:                    zone = "late_ot"

            ot_mul      = float(att.get("ot_multiplier") or 1.0)
            ot_rate     = float(emp.get("ot_rate_per_hour") or 50)
            basic       = float(emp.get("basic_salary") or 15000)
            work_days   = float(s.get("working_days_month","26"))
            daily_rate  = basic / work_days
            hourly_rate = daily_rate / 8

            early_ot_hrs = float(att.get("early_ot_hours") or 0)
            late_ot_hrs  = round((now_mins-cool_e)/60,2) if zone=="late_ot"    else 0
            exit_deduct  = round((off_e-now_mins)/60,2)  if zone=="early_exit" else 0

            early_ot_amt = round(early_ot_hrs*ot_rate*ot_mul,2)
            late_ot_amt  = round(late_ot_hrs*ot_rate*ot_mul,2)
            late_cut     = round(float(att.get("deduction_hours") or 0)*hourly_rate,2)
            exit_cut     = round(exit_deduct*hourly_rate,2)
            total_deduct = late_cut + exit_cut
            today_earn   = round(daily_rate+early_ot_amt+late_ot_amt-total_deduct,2)

            db_query("""UPDATE attendance SET checkout_time=?,working_hours=?,
                late_ot_hours=?,checkout_status=? WHERE employee_id=? AND date=?""",
                [checkout,round(work_mins/60,2),late_ot_hrs,zone,emp["employee_id"],today])

            month,year = ist.month,ist.year
            sal = db_query("SELECT * FROM monthly_salary WHERE employee_id=? AND month=? AND year=?",
                           [emp["employee_id"],month,year])
            if sal:
                db_query("""UPDATE monthly_salary SET
                    total_present=total_present+1,
                    early_ot_hours=early_ot_hours+?,
                    late_ot_hours=late_ot_hours+?,
                    basic_earned=basic_earned+?,
                    normal_ot_amount=normal_ot_amount+?,
                    late_deduction=late_deduction+?,
                    net_salary=net_salary+?,
                    updated_at=datetime('now')
                    WHERE employee_id=? AND month=? AND year=?""",
                    [early_ot_hrs,late_ot_hrs,daily_rate,
                     early_ot_amt+late_ot_amt,total_deduct,today_earn,
                     emp["employee_id"],month,year])
            else:
                db_query("""INSERT INTO monthly_salary
                    (employee_id,month,year,total_present,early_ot_hours,
                     late_ot_hours,basic_earned,normal_ot_amount,late_deduction,net_salary)
                    VALUES(?,?,?,1,?,?,?,?,?,?)""",
                    [emp["employee_id"],month,year,early_ot_hrs,late_ot_hrs,
                     daily_rate,early_ot_amt+late_ot_amt,total_deduct,today_earn])

            ms = db_query("SELECT * FROM monthly_salary WHERE employee_id=? AND month=? AND year=?",
                          [emp["employee_id"],month,year])
            ms = ms[0] if ms else {}

            send_json(self,200,{
                "success":True,"employee":emp["name"],
                "checkin_time":att["checkin_time"],"checkout_time":checkout,
                "working_hours":round(work_mins/60,2),
                "early_ot_hours":early_ot_hrs,"late_ot_hours":late_ot_hrs,
                "zone":zone,"today_earning":today_earn,
                "daily_rate":round(daily_rate,2),
                "ot_amount":round(early_ot_amt+late_ot_amt,2),
                "deduction":total_deduct,"ot_multiplier":ot_mul,
                "month_summary":{
                    "present":int(ms.get("total_present") or 0),
                    "absent":int(ms.get("total_absent") or 0),
                    "late":int(ms.get("total_late") or 0),
                    "total_ot":round(float(ms.get("early_ot_hours") or 0)+float(ms.get("late_ot_hours") or 0),2),
                    "basic":round(float(ms.get("basic_earned") or 0),2),
                    "ot_amount":round(float(ms.get("normal_ot_amount") or 0),2),
                    "deductions":round(float(ms.get("late_deduction") or 0),2),
                    "net_salary":round(float(ms.get("net_salary") or 0),2),
                }
            })
        except Exception as e:
            send_json(self,500,{"error":str(e)})

    def log_message(self,f,*a): pass
