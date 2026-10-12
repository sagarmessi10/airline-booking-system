const express = require("express");
const db = require("../config/db");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { toId } = require("../utils/validators");

const router = express.Router();
router.use(authenticateToken, requireAdmin); // every /admin route is admin-only

// GET /admin/stats
router.get("/stats", (req, res) => {
  db.query(
    `SELECT (SELECT COUNT(*) FROM user) AS totalUsers,
            (SELECT COUNT(*) FROM flights WHERE route_id IS NOT NULL) AS totalFlights,
            (SELECT COUNT(*) FROM bookings) AS totalBookings`,
    (error, rows) => {
      if (error) {
        console.error("Admin dashboard stats query failed:", error.message);
        return res.status(500).json({ message: "Unable to load dashboard statistics." });
      }
      res.json(rows[0]);
    }
  );
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
    SELECT b.id AS booking_id, b.booking_reference, b.passenger_name, b.amount AS price,
           b.passenger_count, b.currency, b.status AS booking_status, p.status AS payment_status, b.created_at,
           u.name AS user_name, u.email AS user_email,
           f.flight_name, r.origin_iata AS source, origin.city AS source_name,
           r.destination_iata AS destination, destination.city AS destination_name,
           f.departure_time, f.flight_date
    FROM bookings b
    JOIN user u ON b.user_id = u.id
    JOIN flights f ON b.flight_id = f.id
    LEFT JOIN domestic_routes r ON r.id = f.route_id
    LEFT JOIN domestic_airports origin ON origin.iata = r.origin_iata
    LEFT JOIN domestic_airports destination ON destination.iata = r.destination_iata
    LEFT JOIN payments p ON p.id = (
      SELECT MAX(p2.id) FROM payments p2 WHERE p2.booking_id = b.id
    )
    ORDER BY b.id DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: "Database error." });
    res.json(results);
  });
});

module.exports = router;
