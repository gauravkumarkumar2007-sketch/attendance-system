# api/time.py
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timezone, timedelta
import json

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        utc = datetime.now(timezone.utc)
        ist = utc + timedelta(hours=5, minutes=30)
        body = json.dumps({
            "utc_timestamp": int(utc.timestamp() * 1000),
            "ist_hours":   ist.hour,
            "ist_minutes": ist.minute,
            "ist_seconds": ist.second,
            "ist_day":     ist.weekday(),
            "ist_date":    ist.day,
            "ist_month":   ist.month - 1,
            "ist_year":    ist.year,
            "timezone":    "Asia/Kolkata",
        }).encode()
        self.send_response(200)
        self.send_header("Content-type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def log_message(self, f, *a): pass
