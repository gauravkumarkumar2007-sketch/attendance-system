// api/time.js — IST Server Time
module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const utc = new Date();
  const ist = new Date(utc.getTime() + (5.5 * 60 * 60 * 1000));

  res.status(200).json({
    utc_timestamp: utc.getTime(),
    ist_hours:     ist.getUTCHours(),
    ist_minutes:   ist.getUTCMinutes(),
    ist_seconds:   ist.getUTCSeconds(),
    ist_day:       ist.getUTCDay(),
    ist_date:      ist.getUTCDate(),
    ist_month:     ist.getUTCMonth(),
    ist_year:      ist.getUTCFullYear(),
    timezone:      "Asia/Kolkata",
  });
};
