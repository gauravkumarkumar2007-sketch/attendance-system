// api/test.js — Debug endpoint to check env vars
module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const dbUrl   = process.env.TURSO_DATABASE_URL;
  const dbToken = process.env.TURSO_AUTH_TOKEN;

  res.status(200).json({
    db_url_set:    !!dbUrl,
    db_url_starts: dbUrl ? dbUrl.substring(0, 20) + "..." : "NOT SET",
    token_set:     !!dbToken,
    token_length:  dbToken ? dbToken.length : 0,
    node_version:  process.version,
  });
};
