# api/employees.py — Self-contained
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json, os, urllib.request

def db_query(sql, params=None):
    url   = os.environ.get("TURSO_DATABASE_URL","").replace("libsql://","https://") + "/v2/pipeline"
    token = os.environ.get("TURSO_AUTH_TOKEN","")
    args  = []
    if params:
        for p in params:
            if p is None:              args.append({"type":"null"})
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

def send_json(h,status,data):
    body=json.dumps(data).encode()
    h.send_response(status)
    h.send_header("Content-type","application/json")
    h.send_header("Access-Control-Allow-Origin","*")
    h.send_header("Content-Length",str(len(body)))
    h.end_headers(); h.wfile.write(body)

def get_body(h):
    try:
        n=int(h.headers.get("Content-Length",0))
        return json.loads(h.rfile.read(n)) if n>0 else {}
    except: return {}

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type")
        self.end_headers()

    def do_GET(self):
        try:
            qs  = parse_qs(urlparse(self.path).query)
            eid = qs.get("id",[None])[0]
            if eid:
                rows = db_query("SELECT * FROM employees WHERE employee_id=?",[eid])
            else:
                rows = db_query("SELECT employee_id,telegram_user_id,name,phone,department,designation,joining_date,basic_salary,ot_rate_per_hour,status FROM employees WHERE status='active' ORDER BY name")
            send_json(self,200,{"success":True,"employees":rows})
        except Exception as e:
            send_json(self,500,{"error":str(e)})

    def do_POST(self):
        try:
            b = get_body(self)
            db_query("""INSERT INTO employees
                (employee_id,telegram_user_id,name,phone,department,
                 designation,joining_date,basic_salary,ot_rate_per_hour,status)
                VALUES(?,?,?,?,?,?,?,?,?,'active')""",
                [b.get("employee_id"),b.get("telegram_user_id"),
                 b.get("name"),b.get("phone"),b.get("department"),
                 b.get("designation"),b.get("joining_date"),
                 b.get("basic_salary",0),b.get("ot_rate_per_hour",50)])
            send_json(self,200,{"success":True,"message":"Employee added!"})
        except Exception as e:
            send_json(self,500,{"error":str(e)})

    def do_PUT(self):
        try:
            b = get_body(self)
            db_query("""UPDATE employees SET telegram_user_id=?,name=?,phone=?,
                department=?,designation=?,basic_salary=?,ot_rate_per_hour=?,
                status=? WHERE employee_id=?""",
                [b.get("telegram_user_id"),b.get("name"),b.get("phone"),
                 b.get("department"),b.get("designation"),
                 b.get("basic_salary"),b.get("ot_rate_per_hour"),
                 b.get("status","active"),b.get("employee_id")])
            send_json(self,200,{"success":True,"message":"Employee updated!"})
        except Exception as e:
            send_json(self,500,{"error":str(e)})

    def do_DELETE(self):
        try:
            b = get_body(self)
            db_query("UPDATE employees SET status='inactive' WHERE employee_id=?",[b.get("employee_id")])
            send_json(self,200,{"success":True,"message":"Employee deactivated!"})
        except Exception as e:
            send_json(self,500,{"error":str(e)})

    def log_message(self,f,*a): pass
