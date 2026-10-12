const express = require("express");
const db = require("../config/db");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const { validateSearch, validateAirportCode } = require("../utils/domestic");

const router = express.Router();
const FLIGHT_DETAILS = `
  SELECT f.id, f.flight_name, f.departure_time, f.duration, f.price, f.flight_date,
         f.seat_capacity - f.seats_reserved - f.seats_booked AS seats_available,
         f.inventory_source AS data_source, 'NPR' AS currency,
         a.name AS airline_name, a.iata AS airline_iata,
         origin.iata AS source, origin.city AS source_name,
         destination.iata AS destination, destination.city AS destination_name
  FROM flights f
  JOIN domestic_routes r ON r.id = f.route_id AND r.active = TRUE
  JOIN domestic_airlines a ON a.id = f.airline_id AND a.active = TRUE
  JOIN domestic_airports origin ON origin.iata = r.origin_iata AND origin.active = TRUE
  JOIN domestic_airports destination ON destination.iata = r.destination_iata AND destination.active = TRUE
`;

router.get("/airports", (req, res) => {
  db.query(
    "SELECT iata, name, city, province FROM domestic_airports WHERE active = TRUE ORDER BY city",
    (error, rows) => {
      if (error) return res.status(500).json({ message: "Unable to load domestic airports." });
      res.json(rows);
    }
  );
});

router.get("/routes", (req, res) => {
  db.query(
    `SELECT r.id, r.origin_iata, r.destination_iata,
            origin.city AS origin_city, destination.city AS destination_city
     FROM domestic_routes r
     JOIN domestic_airports origin ON origin.iata = r.origin_iata AND origin.active = TRUE
     JOIN domestic_airports destination ON destination.iata = r.destination_iata AND destination.active = TRUE
     WHERE r.active = TRUE ORDER BY origin.city, destination.city`,
    (error, rows) => {
      if (error) return res.status(500).json({ message: "Unable to load domestic routes." });
      res.json(rows);
    }
  );
});

router.get("/flights", (req, res) => {
  const search = validateSearch(req.query);
  if (search.error) return res.status(400).json({ message: search.error });

  const sql = `${FLIGHT_DETAILS}
    WHERE r.origin_iata = ? AND r.destination_iata = ? AND f.flight_date = ? AND f.flight_date >= CURDATE()
      AND f.seat_capacity - f.seats_reserved - f.seats_booked >= ?
    ORDER BY f.departure_time, a.name`;
  db.query(sql, [search.origin, search.destination, search.date, search.passengers], (error, rows) => {
    if (error) return res.status(500).json({ message: "Unable to search domestic schedules." });
    res.json(rows);
  });
});

router.get("/flights/:id", (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: "Invalid flight ID." });
  db.query(`${FLIGHT_DETAILS} WHERE f.id = ?`, [Number(req.params.id)], (error, rows) => {
    if (error) return res.status(500).json({ message: "Unable to load the selected schedule." });
    if (!rows.length) return res.status(404).json({ message: "Domestic schedule not found." });
    res.json(rows[0]);
  });
});

// Keep the former write endpoint closed; schedule writes use the validated admin API.
router.post("/add-flight", authenticateToken, requireAdmin, (req, res) =>
  res.status(410).json({ message: "Use the domestic schedule management API." })
);

module.exports = router;
