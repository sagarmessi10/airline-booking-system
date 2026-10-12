const express = require("express");
const db = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { toId } = require("../utils/validators");

const router = express.Router();

// POST /book
router.post("/book", authenticateToken, (req, res) => {
  const { flight_id, card_number, card_holder, expiry } = req.body;
  if (!flight_id || !card_number || !card_holder || !expiry) {
    return res.status(400).json({ message: "Incomplete booking details." });
  }

  const flightId = toId(flight_id);
  if (flightId === null) return res.status(400).json({ message: "Invalid flight." });

  const digits = String(card_number).replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) return res.status(400).json({ message: "Invalid card number." });
  // Never persist the full card number — keep only the last 4 digits
  const maskedCard = "**** **** **** " + digits.slice(-4);

  db.query("SELECT id FROM flights WHERE id = ?", [flightId], (err, flights) => {
    if (err) return res.status(500).json({ message: "Database error during booking." });
    if (flights.length === 0) return res.status(404).json({ message: "Flight not found." });

    db.query(
      "INSERT INTO bookings (user_id, flight_id, card_number, card_holder, expiry) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, flightId, maskedCard, String(card_holder).trim(), String(expiry).trim()],
      (err, result) => {
        if (err) {
          console.error("Booking db error:", err.message);
          return res.status(500).json({ message: "Database error during booking." });
        }
        res.json({ message: "Booking Successful", booking_id: result.insertId });
      }
    );
  });
});

// GET /my-bookings
router.get("/my-bookings", authenticateToken, (req, res) => {
  const sql = `
    SELECT b.id AS booking_id, b.card_holder, b.created_at,
           f.flight_name, f.source, f.destination, f.departure_time, f.price
    FROM bookings b
    JOIN flights f ON b.flight_id = f.id
    WHERE b.user_id = ?
    ORDER BY b.id DESC
  `;
  db.query(sql, [req.user.id], (err, results) => {
    if (err) return res.status(500).json({ message: "Database error." });
    res.json(results);
  });
});

module.exports = router;
