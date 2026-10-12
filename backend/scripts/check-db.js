// npm run check-db  — verifies MySQL connection and sets up tables/seed data
const db = require("../src/config/db");
db.init()
  .then(() => { console.log("✔ Database OK"); process.exit(0); })
  .catch((e) => { console.error("✖ " + e.message); process.exit(1); });
