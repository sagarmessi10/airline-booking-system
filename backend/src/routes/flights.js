const express = require("express");
const db = require("../config/db");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { validateFlight } = require("../utils/validators");

const router = express.Router();

// GET /flights (public)
router.get("/flights", (req, res) => {
  db.query("SELECT * FROM flights ORDER BY id", (err, result) => {
    if (err) return res.status(500).json({ message: "Database error." });
    res.json(result);
  });
});

// POST /add-flight (admin)
router.post("/add-flight", authenticateToken, requireAdmin, (req, res) => {
  const { flight: f, error } = validateFlight(req.body);
  if (error) return res.status(400).json({ message: error });

  db.query(
    "INSERT INTO flights (flight_name, source, destination, departure_time, price, duration) VALUES (?, ?, ?, ?, ?, ?)",
    [f.flight_name, f.source, f.destination, f.departure_time, f.price, f.duration],
    (err, result) => {
      if (err) {
        console.error("Add flight error:", err.message);
        return res.status(500).json({ message: "Database error while adding flight." });
      }
      res.status(201).json({ message: "Flight Added", id: result.insertId });
    }
  );
});

module.exports = router;
