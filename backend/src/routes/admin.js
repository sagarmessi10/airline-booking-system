const express = require("express");
const db = require("../config/db");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { toId, validateFlight } = require("../utils/validators");

const router = express.Router();
router.use(authenticateToken, requireAdmin); // every /admin route is admin-only

// GET /admin/stats
router.get("/stats", (req, res) => {
  const queries = {
    totalUsers: "SELECT COUNT(*) AS count FROM user",
    totalFlights: "SELECT COUNT(*) AS count FROM flights",
    totalBookings: "SELECT COUNT(*) AS count FROM bookings",
  };
  const stats = {};
  const keys = Object.keys(queries);
  let done = 0;
  keys.forEach((key) => {
    db.query(queries[key], (err, results) => {
      stats[key] = err ? 0 : results[0].count;
      if (++done === keys.length) res.json(stats);
    });
  });
});

// GET /admin/users
router.get("/users", (req, res) => {
  db.query("SELECT id, name, email, role FROM user ORDER BY id DESC", (err, results) => {
    if (err) return res.status(500).json({ message: "Database error." });
    res.json(results);
  });
});

// PUT /admin/users/:id/role
router.put("/users/:id/role", (req, res) => {
  const { role } = req.body;
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ message: "Invalid user id." });
  if (!["user", "admin"].includes(role)) return res.status(400).json({ message: "Role must be 'user' or 'admin'." });
  if (id === req.user.id && role !== "admin") return res.status(400).json({ message: "You cannot remove your own admin role." });

  db.query("UPDATE user SET role = ? WHERE id = ?", [role, id], (err, result) => {
    if (err) return res.status(500).json({ message: "Database error." });
    if (result.affectedRows === 0) return res.status(404).json({ message: "User not found." });
    res.json({ message: "Role updated." });
  });
});

// GET /admin/bookings
router.get("/bookings", (req, res) => {
  const sql = `
    SELECT b.id AS booking_id, b.card_holder, b.created_at,
           u.name AS user_name, u.email AS user_email,
           f.flight_name, f.source, f.destination, f.departure_time, f.price
    FROM bookings b
    JOIN user u ON b.user_id = u.id
    JOIN flights f ON b.flight_id = f.id
    ORDER BY b.id DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: "Database error." });
    res.json(results);
  });
});

// PUT /admin/flights/:id
router.put("/flights/:id", (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ message: "Invalid flight id." });
  const { flight: f, error } = validateFlight(req.body);
  if (error) return res.status(400).json({ message: error });

  db.query(
    "UPDATE flights SET flight_name=?, source=?, destination=?, departure_time=?, price=?, duration=? WHERE id=?",
    [f.flight_name, f.source, f.destination, f.departure_time, f.price, f.duration, id],
    (err, result) => {
      if (err) return res.status(500).json({ message: "Database error." });
      if (result.affectedRows === 0) return res.status(404).json({ message: "Flight not found." });
      res.json({ message: "Flight updated." });
    }
  );
});

// DELETE /admin/flights/:id
router.delete("/flights/:id", (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ message: "Invalid flight id." });
  db.query("DELETE FROM flights WHERE id = ?", [id], (err, result) => {
    if (err) {
      if (err.code === "ER_ROW_IS_REFERENCED_2") return res.status(409).json({ message: "Flight has existing bookings and cannot be deleted." });
      return res.status(500).json({ message: "Database error." });
    }
    if (result.affectedRows === 0) return res.status(404).json({ message: "Flight not found." });
    res.json({ message: "Flight deleted." });
  });
});

module.exports = router;
