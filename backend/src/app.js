const express = require("express");
const path = require("path");
const cors = require("cors");
const db = require("./config/db");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "..", "frontend")));

app.get("/", (req, res) => res.send("AeroNepal Backend Running ✈"));
app.get("/health", (req, res) => {
  db.query("SELECT 1", (err) => {
    if (err) return res.status(503).json({ status: "error", database: "down" });
    res.json({ status: "ok", database: "up" });
  });
});

app.use(require("./routes/auth"));
app.use(require("./routes/flights"));
app.use("/api", require("./routes/live-flights"));
app.use(require("./routes/bookings"));
app.use("/payments", require("./routes/payments").router);
app.use("/admin", require("./routes/admin"));
app.use("/admin/domestic", require("./routes/domestic-admin"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
