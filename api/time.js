// api/time.js — Vercel Serverless Function (CommonJS)
module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // UTC ms
  const utcMs      = Date.now();
  // IST = UTC + 5hr 30min
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istMs       = utcMs + istOffsetMs;
  const d           = new Date(istMs);

  // getUTC* because we manually shifted to IST
  res.status(200).json({
    utc_timestamp: utcMs,
    ist_hours:     d.getUTCHours(),
    ist_minutes:   d.getUTCMinutes(),
    ist_seconds:   d.getUTCSeconds(),
    ist_day:       d.getUTCDay(),
    ist_date:      d.getUTCDate(),
    ist_month:     d.getUTCMonth(),
    ist_year:      d.getUTCFullYear(),
    timezone:      "Asia/Kolkata",
  });
};
