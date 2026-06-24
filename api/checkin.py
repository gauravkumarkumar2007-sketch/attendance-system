# api/checkin.py — Self-contained, no imports from other files
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timezone, timedelta
import json, math, os, urllib.request

# ── DB Helper ────────────────────────────────────────────────
def db_query(sql, params=None):
    url   = os.environ.get("TURSO_DATABASE_URL", "").replace("libsql://", "https://") + "/v2/pipeline"
    token = os.environ.get("TURSO_AUTH_TOKEN", "")
    args  = []
    if params:
        for p in params:
            if p is None:              args.append({"type": "null"})
            elif isinstance(p, bool):  args.append({"type": "integer", "value": "1" if p else "0"})
            elif isinstance(p, int):   args.append({"type": "integer", "value": str(p)})
            elif isinstance(p, float): args.append({"type": "float",   "value": str(p)})
            else:                      args.append({"type": "text",    "value": str(p)})
    stmt = {"type": "execute", "stmt": {"sql": sql}}
    if args: stmt["stmt"]["args"] = args
    body = json.dumps({"requests": [stmt, {"type": "close"}]}).encode()
    req  = urllib.request.Request(url, data=body,
           headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.loads(r.read())
    resp = result["results"][0]
    if resp["type"] == "error": raise Exception(resp["error"]["message"])
    data = resp["response"]["result"]
    cols = [c["name"] for c in data["cols"]]
    rows = []
    for row in data["rows"]:
        obj = {}
        for i, col in enumerate(cols):
            v = row[i]
            obj[col] = None if v["type"] == "null" else v["value"]
        rows.append(obj)
    return rows

def send_json(h, status, data):
    body = json.dumps(data).encode()
    h.send_response(status)
    h.send_header("Content-type", "application/json")
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)

def get_body(h):
    try:
        n = int(h.headers.get("Content-Length", 0))
        return json.loads(h.rfile.read(n)) if n > 0 else {}
    except: return {}

def get_ist():
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)

def to_mins(t):
    h, m = map(int, t.split(":")); return h * 60 + m

def get_dist(la1, lo1, la2, lo2):
    R = 6371000
    dL = math.radians(la2-la1); dl = math.radians(lo2-lo1)
    a  = math.sin(dL/2)**2 + math.cos(math.radians(la1))*math.cos(math.radians(la2))*math.sin(dl/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

# ── Handler ──────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            b   = get_body(self)
            tid = b.get("telegram_user_id")
            lat = b.get("location_lat")
            lng = b.get("location_lng")
            selfie = str(b.get("selfie_base64", ""))[:100]

            if not tid:
                return send_json(self, 400, {"error": "Telegram ID required"})

            emps = db_query("SELECT * FROM employees WHERE telegram_user_id=? AND status='active'", [tid])
            if not emps:
                return send_json(self, 404, {"error": "Employee not found"})
            emp = emps[0]

            srows = db_query("SELECT key, value FROM settings")
            s = {r["key"]: r["value"] for r in srows}

            ist   = get_ist()
            today = ist.strftime("%Y-%m-%d")

            existing = db_query("SELECT checkin_time FROM attendance WHERE employee_id=? AND date=?",
                                [emp["employee_id"], today])
            if existing and existing[0].get("checkin_time"):
                return send_json(self, 400, {"error": "Already checked in today"})

            if lat and lng:
                dist = get_dist(float(lat), float(lng),
                                float(s.get("office_lat","28.6139")),
                                float(s.get("office_lng","77.2090")))
                if dist > float(s.get("radius_meters","100")):
                    return send_json(self, 400, {"error": f"Too far from office ({round(dist)}m)"})

            now_mins = ist.hour*60 + ist.minute
            if   now_mins < to_mins(s.get("early_ot_cutoff","09:30")): zone = "early_ot"
            elif now_mins < to_mins(s.get("normal_end","10:05")):       zone = "normal"
            elif now_mins < to_mins(s.get("manager_zone_end","10:30")): zone = "manager_zone"
            else:                                                        zone = "late_deduct"

            early_ot = round((600 - now_mins)/60, 2) if zone=="early_ot"    else 0
            deduct   = round((now_mins - 600)/60, 2)  if zone=="late_deduct" else 0
            is_sun   = 1 if ist.weekday()==6 else 0
            hol      = db_query("SELECT id FROM holidays WHERE date=?", [today])
            is_hol   = 1 if hol else 0
            ot_mul   = 2.0 if (is_sun or is_hol) else 1.0
            checkin  = ist.strftime("%I:%M %p").lstrip("0")

            db_query("""INSERT INTO attendance
                (employee_id,date,checkin_time,early_ot_hours,is_sunday,
                 is_holiday,ot_multiplier,checkin_status,deduction_hours,
                 location_lat,location_lng,selfie_base64,status)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'present')""",
                [emp["employee_id"],today,checkin,early_ot,
                 is_sun,is_hol,ot_mul,zone,deduct,lat,lng,selfie])

            if zone=="manager_zone":
                db_query("INSERT INTO manager_approvals(employee_id,date,checkin_time,decision) VALUES(?,?,?,'pending')",
                         [emp["employee_id"],today,checkin])

            send_json(self, 200, {
                "success": True, "message": "Check-in successful!",
                "employee": emp["name"], "employee_id": emp["employee_id"],
                "time": checkin, "zone": zone,
                "early_ot": early_ot, "deduction": deduct,
                "is_sunday": bool(is_sun), "ot_multiplier": ot_mul,
            })
        except Exception as e:
            send_json(self, 500, {"error": str(e)})

    def log_message(self, f, *a): pass
