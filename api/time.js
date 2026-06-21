// api/time.js — Vercel Serverless Function
// Returns current IST time components directly

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // UTC timestamp
  const utcMs = Date.now();

  // IST = UTC + 5 hours 30 minutes
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istMs       = utcMs + istOffsetMs;
  const istDate     = new Date(istMs);

  // Use getUTC* because we manually shifted to IST
  const hours   = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  const seconds = istDate.getUTCSeconds();
  const day     = istDate.getUTCDay();    // 0=Sun, 6=Sat
  const date    = istDate.getUTCDate();
  const month   = istDate.getUTCMonth(); // 0-11
  const year    = istDate.getUTCFullYear();

  res.status(200).json({
    utc_timestamp: utcMs,  // for client-side syncing
    ist_hours:     hours,
    ist_minutes:   minutes,
    ist_seconds:   seconds,
    ist_day:       day,
    ist_date:      date,
    ist_month:     month,
    ist_year:      year,
    timezone:      "Asia/Kolkata",
  });
}
