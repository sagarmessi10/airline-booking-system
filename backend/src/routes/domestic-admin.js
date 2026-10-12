const express = require("express");
const db = require("../config/db");
const { authenticateToken, requireAdmin } = require("../middleware/auth");
const {
  validateAirportCode,
  validateRoute,
  validateSchedule,
} = require("../utils/domestic");
const { toId } = require("../utils/validators");

const router = express.Router();
router.use(authenticateToken, requireAdmin);

router.get("/airports", (req, res) => {
  db.query("SELECT iata, name, city, province, active FROM domestic_airports ORDER BY city", (error, rows) => {
    if (error) return res.status(500).json({ message: "Unable to load airport registry." });
    res.json(rows);
  });
});

router.patch("/airports/:iata", async (req, res) => {
  const code = validateAirportCode(req.params.iata);
  const active = req.body && req.body.active;
  if (!code || typeof active !== "boolean") {
    return res.status(400).json({ message: "Use a verified Nepal airport code and an active boolean." });
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [airports] = await tx.query("SELECT iata FROM domestic_airports WHERE iata = ? FOR UPDATE", [code]);
      if (!airports.length) return false;
      await tx.query("UPDATE domestic_airports SET active = ? WHERE iata = ?", [active ? 1 : 0, code]);
      if (!active) {
        await tx.query(
          "UPDATE domestic_routes SET active = FALSE WHERE origin_iata = ? OR destination_iata = ?",
          [code, code]
        );
      }
      return true;
    });
    if (!result) return res.status(404).json({ message: "Airport not found." });
    res.json({ message: "Airport status updated." });
  } catch (error) {
    console.error("Airport status update failed:", error.message);
    res.status(500).json({ message: "Unable to update airport status." });
  }
});

router.get("/airlines", (req, res) => {
  db.query("SELECT id, iata, name, active FROM domestic_airlines ORDER BY name", (error, rows) => {
    if (error) return res.status(500).json({ message: "Unable to load airline registry." });
    res.json(rows);
  });
});

router.get("/routes", (req, res) => {
  db.query(
    `SELECT r.id, r.origin_iata, r.destination_iata, r.active,
            origin.city AS origin_city, destination.city AS destination_city
     FROM domestic_routes r
     JOIN domestic_airports origin ON origin.iata = r.origin_iata
     JOIN domestic_airports destination ON destination.iata = r.destination_iata
     ORDER BY origin.city, destination.city`,
    (error, rows) => {
      if (error) return res.status(500).json({ message: "Unable to load route registry." });
      res.json(rows);
    }
  );
});

router.post("/routes", async (req, res) => {
  const { route, error } = validateRoute(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const created = await db.transaction(async (tx) => {
      const [airports] = await tx.query(
        "SELECT iata, active FROM domestic_airports WHERE iata IN (?, ?) FOR UPDATE",
        [route.origin_iata, route.destination_iata]
      );
      if (airports.length !== 2 || airports.some((airport) => !airport.active)) return { error: "inactive" };
      const [result] = await tx.query(
        "INSERT INTO domestic_routes (origin_iata, destination_iata, active) VALUES (?, ?, TRUE)",
        [route.origin_iata, route.destination_iata]
      );
      return { id: result.insertId };
    });
    if (created.error) return res.status(400).json({ message: "Both route airports must be active in Nepal." });
    res.status(201).json({ message: "Domestic route created.", id: created.id });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "This domestic route already exists." });
    console.error("Domestic route creation failed:", error.message);
    res.status(500).json({ message: "Unable to create domestic route." });
  }
});

router.patch("/routes/:id", async (req, res) => {
  const id = toId(req.params.id);
  const active = req.body && req.body.active;
  if (id === null || typeof active !== "boolean") {
    return res.status(400).json({ message: "Provide a valid route ID and active boolean." });
  }
  try {
    const outcome = await db.transaction(async (tx) => {
      const [routes] = await tx.query(
        `SELECT r.id, origin.active AS origin_active, destination.active AS destination_active
         FROM domestic_routes r
         JOIN domestic_airports origin ON origin.iata = r.origin_iata
         JOIN domestic_airports destination ON destination.iata = r.destination_iata
         WHERE r.id = ? FOR UPDATE`,
        [id]
      );
      if (!routes.length) return "not_found";
      if (active && (!routes[0].origin_active || !routes[0].destination_active)) return "inactive_airport";
      await tx.query("UPDATE domestic_routes SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
      return "updated";
    });
    if (outcome === "not_found") return res.status(404).json({ message: "Route not found." });
    if (outcome === "inactive_airport") {
      return res.status(409).json({ message: "Both route airports must be active before enabling this route." });
    }
    res.json({ message: "Route status updated." });
  } catch (error) {
    console.error("Domestic route status update failed:", error.message);
    res.status(500).json({ message: "Unable to update domestic route." });
  }
});

router.delete("/routes/:id", async (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ message: "Invalid route ID." });
  try {
    const outcome = await db.transaction(async (tx) => {
      const [route] = await tx.query("SELECT id FROM domestic_routes WHERE id = ? FOR UPDATE", [id]);
      if (!route.length) return "not_found";
      const [schedules] = await tx.query("SELECT COUNT(*) AS count FROM flights WHERE route_id = ?", [id]);
      if (Number(schedules[0].count) > 0) return "has_schedules";
      const [result] = await tx.query("DELETE FROM domestic_routes WHERE id = ?", [id]);
      return result.affectedRows ? "deleted" : "not_found";
    });
    if (outcome === "has_schedules") {
      return res.status(409).json({ message: "Route has schedules and cannot be deleted. Deactivate it instead." });
    }
    if (outcome === "not_found") return res.status(404).json({ message: "Route not found." });
    res.json({ message: "Route deleted." });
  } catch (error) {
    console.error("Domestic route deletion failed:", error.message);
    res.status(500).json({ message: "Unable to delete domestic route." });
  }
});

router.get("/schedules", (req, res) => {
  db.query(
    `SELECT f.id, f.flight_name, f.flight_date, f.departure_time, f.duration, f.price,
            f.seat_capacity, f.seats_reserved, f.seats_booked,
            f.seat_capacity - f.seats_reserved - f.seats_booked AS seats_available,
            f.inventory_source AS data_source, f.route_id, f.airline_id,
            a.name AS airline_name, a.iata AS airline_iata,
            r.origin_iata AS source, origin.city AS source_name,
            r.destination_iata AS destination, destination.city AS destination_name
     FROM flights f
     JOIN domestic_routes r ON r.id = f.route_id
     JOIN domestic_airlines a ON a.id = f.airline_id
     JOIN domestic_airports origin ON origin.iata = r.origin_iata
     JOIN domestic_airports destination ON destination.iata = r.destination_iata
     ORDER BY f.flight_date DESC, f.departure_time`,
    (error, rows) => {
      if (error) return res.status(500).json({ message: "Unable to load domestic schedules." });
      res.json(rows);
    }
  );
});

async function checkSelections(schedule) {
  const [selections] = await db.transaction((tx) => tx.query(
    `SELECT ? >= CURDATE() AS flight_date_valid,
            r.id AS route_id, r.active AS route_active,
            origin.active AS origin_active, destination.active AS destination_active,
            a.id AS airline_id, a.active AS airline_active,
            r.origin_iata, r.destination_iata
     FROM domestic_routes r
     JOIN domestic_airports origin ON origin.iata = r.origin_iata
     JOIN domestic_airports destination ON destination.iata = r.destination_iata
     JOIN domestic_airlines a ON a.id = ?
     WHERE r.id = ? FOR UPDATE`,
    [schedule.flight_date, schedule.airline_id, schedule.route_id]
  ));
  const selection = selections[0];
  if (!selection || !selection.flight_date_valid) return { error: "Schedule date must be today or later." };
  if (!selection || !selection.route_active || !selection.origin_active ||
      !selection.destination_active || !selection.airline_active) {
    return { error: "Choose an active domestic route and a supported active airline." };
  }
  return { selection };
}

router.post("/schedules", async (req, res) => {
  const { schedule, error } = validateSchedule(req.body || {});
  if (error) return res.status(400).json({ message: error });
  try {
    const { selection, error: selectionError } = await checkSelections(schedule);
    if (selectionError) return res.status(400).json({ message: selectionError });
    const [created] = await db.transaction((tx) => tx.query(
      `INSERT INTO flights
         (flight_name, source, destination, departure_time, price, duration, route_id, airline_id,
          flight_date, seat_capacity, inventory_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN_DEMO')`,
      [schedule.flight_name, selection.origin_iata, selection.destination_iata, schedule.departure_time,
        schedule.price, schedule.duration, schedule.route_id, schedule.airline_id,
        schedule.flight_date, schedule.seat_capacity]
    ));
    res.status(201).json({ message: "Admin-managed demo schedule created.", id: created.insertId });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "A schedule already exists for this airline, route, date, and time." });
    console.error("Domestic schedule creation failed:", error.message);
    res.status(500).json({ message: "Unable to create domestic schedule." });
  }
});

router.put("/schedules/:id", async (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ message: "Invalid schedule ID." });
  const { schedule, error } = validateSchedule(req.body || {});
  if (error) return res.status(400).json({ message: error });

  try {
    const { selection, error: selectionError } = await checkSelections(schedule);
    if (selectionError) return res.status(400).json({ message: selectionError });
    const result = await db.transaction(async (tx) => {
      const [rows] = await tx.query(
        "SELECT id, route_id, airline_id, CAST(flight_date AS CHAR) AS flight_date, departure_time, seats_booked, seats_reserved FROM flights WHERE id = ? FOR UPDATE",
        [id]
      );
      if (!rows.length) return "not_found";
      if (schedule.seat_capacity < Number(rows[0].seats_booked) + Number(rows[0].seats_reserved)) return "capacity";
      const [bookings] = await tx.query("SELECT COUNT(*) AS count FROM bookings WHERE flight_id = ?", [id]);
      if (Number(bookings[0].count) > 0 &&
          (Number(rows[0].route_id) !== schedule.route_id ||
           String(rows[0].flight_date).slice(0, 10) !== schedule.flight_date ||
           Number(rows[0].airline_id) !== schedule.airline_id ||
           String(rows[0].departure_time).slice(0, 5) !== schedule.departure_time)) return "booked";
      await tx.query(
        `UPDATE flights SET flight_name = ?, source = ?, destination = ?, departure_time = ?, price = ?,
         duration = ?, route_id = ?, airline_id = ?, flight_date = ?, seat_capacity = ? WHERE id = ?`,
        [schedule.flight_name, selection.origin_iata, selection.destination_iata, schedule.departure_time,
          schedule.price, schedule.duration, schedule.route_id, schedule.airline_id,
          schedule.flight_date, schedule.seat_capacity, id]
      );
      return "updated";
    });
    if (result === "not_found") return res.status(404).json({ message: "Schedule not found." });
    if (result === "capacity") return res.status(409).json({ message: "Seat capacity cannot be lower than already reserved or booked seats." });
    if (result === "booked") return res.status(409).json({ message: "Route, airline, date, or time cannot change after bookings have been made." });
    res.json({ message: "Domestic schedule updated." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "A schedule already exists for this airline, route, date, and time." });
    console.error("Domestic schedule update failed:", error.message);
    res.status(500).json({ message: "Unable to update domestic schedule." });
  }
});

router.delete("/schedules/:id", async (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ message: "Invalid schedule ID." });
  try {
    const outcome = await db.transaction(async (tx) => {
      const [schedule] = await tx.query("SELECT id FROM flights WHERE id = ? FOR UPDATE", [id]);
      if (!schedule.length) return "not_found";
      const [bookings] = await tx.query("SELECT COUNT(*) AS count FROM bookings WHERE flight_id = ?", [id]);
      if (Number(bookings[0].count) > 0) return "has_bookings";
      const [result] = await tx.query("DELETE FROM flights WHERE id = ?", [id]);
      return result.affectedRows ? "deleted" : "not_found";
    });
    if (outcome === "has_bookings") return res.status(409).json({ message: "Schedule has bookings and cannot be deleted." });
    if (outcome === "not_found") return res.status(404).json({ message: "Schedule not found." });
    res.json({ message: "Schedule deleted." });
  } catch (error) {
    console.error("Domestic schedule deletion failed:", error.message);
    res.status(500).json({ message: "Unable to delete domestic schedule." });
  }
});

module.exports = router;
