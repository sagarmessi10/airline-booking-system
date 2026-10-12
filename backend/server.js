// Entry point:  npm start
const env = require("./src/config/env");
const db = require("./src/config/db");
const app = require("./src/app");

db.init()
  .then(() => app.listen(env.port, () => console.log(`AeroNepal server running on http://localhost:${env.port}`)))
  .catch((err) => {
    console.error("\n✖ Startup failed:\n" + err.message + "\n");
    process.exit(1);
  });
