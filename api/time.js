// api/time.js — Vercel Serverless Function
// Returns current IST time from server
// No CORS issues — runs on Vercel server side

export default function handler(req, res) {
  // Allow all origins
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // Get current server time in IST (UTC+5:30)
  const now = new Date();

  // Convert to IST
  const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in ms
  const istTime   = new Date(now.getTime() + istOffset);

  // Return time details
  res.status(200).json({
    datetime:    istTime.toISOString(),
    timestamp:   istTime.getTime(),
    hours:       istTime.getUTCHours(),
    minutes:     istTime.getUTCMinutes(),
    seconds:     istTime.getUTCSeconds(),
    date:        istTime.toISOString().split("T")[0],
    timezone:    "Asia/Kolkata",
    utc_offset:  "+05:30",
  });
}
