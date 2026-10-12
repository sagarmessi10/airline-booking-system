const express = require("express");
const crypto = require("crypto");
const db = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { isValidEmail, toId } = require("../utils/validators");
const { createPaymentForm, paymentIsConfigured } = require("./payments");
const { multiplyAmount } = require("../utils/esewa");

const router = express.Router();

function newBookingReference() {
  return `AN-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function validatePassenger(body) {
  const passengerName = typeof body.passenger_name === "string" ? body.passenger_name.trim() : "";
  const passengerPhone = typeof body.passenger_phone === "string" ? body.passenger_phone : "";
  const passengerAge = Number(body.passenger_age);

  if (!/^[\p{L}][\p{L}\s'.-]{1,98}$/u.test(passengerName)) {
    return { error: "Enter a valid passenger name." };
  }
  if (!/^(?:98|97)\d{8,13}$/.test(passengerPhone)) {
    return { error: "Phone number must contain only 10 to 15 digits and start with 98 or 97." };
  }
  if (!Number.isInteger(passengerAge) || passengerAge < 19 || passengerAge > 120) {
    return { error: "Passenger must be at least 19 years old." };
  }
  return { passengerName, passengerPhone, passengerAge };
}

// POST /book - creates a pending booking and its first eSewa payment attempt.
router.post("/book", authenticateToken, async (req, res) => {
  if (!isValidEmail(req.user.email)) {
    return res.status(403).json({ message: "Only Gmail accounts can book flights." });
  }
  if (!paymentIsConfigured()) {
    return res.status(503).json({ message: "eSewa UAT payment is not configured." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const flightId = toId(body.flight_id);
  if (flightId === null) return res.status(400).json({ message: "Invalid flight." });
  const idempotencyKey = req.get("Idempotency-Key");
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9-]{16,100}$/.test(idempotencyKey)) {
    return res.status(400).json({ message: "A valid Idempotency-Key header is required." });
  }
  const passengerCount = Number(body.passenger_count ?? 1);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 9) {
    return res.status(400).json({ message: "Passenger count must be between 1 and 9." });
  }
  const passenger = validatePassenger(body);
  if (passenger.error) return res.status(400).json({ message: passenger.error });

  try {
    const booking = await db.transaction(async (tx) => {
      const [existingPayments] = await tx.query(
        `SELECT p.booking_id, p.transaction_uuid, p.amount, p.currency, p.status,
                b.user_id, b.flight_id, b.booking_reference, b.passenger_name, b.passenger_phone,
                b.passenger_age, b.passenger_count
         FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE p.idempotency_key = ? FOR UPDATE`,
        [idempotencyKey]
      );
      if (existingPayments.length) {
        const existing = existingPayments[0];
        const matchesRequest = Number(existing.user_id) === Number(req.user.id) &&
          Number(existing.flight_id) === flightId && Number(existing.passenger_count) === passengerCount &&
          existing.passenger_name === passenger.passengerName &&
          existing.passenger_phone === passenger.passengerPhone &&
          Number(existing.passenger_age) === passenger.passengerAge;
        if (!matchesRequest || existing.status !== "PENDING") return { conflict: true };
        const [flightRows] = await tx.query(
          `SELECT f.id, f.flight_name, f.departure_time, f.duration, f.price, f.flight_date,
                  f.seat_capacity - f.seats_reserved - f.seats_booked AS seats_available,
                  f.inventory_source AS data_source, 'NPR' AS currency,
                  a.name AS airline_name, a.active AS airline_active,
                  r.origin_iata AS source, origin.city AS source_name,
                  r.destination_iata AS destination, destination.city AS destination_name
           FROM flights f
           JOIN domestic_routes r ON r.id = f.route_id AND r.active = TRUE
           JOIN domestic_airports origin ON origin.iata = r.origin_iata AND origin.active = TRUE
           JOIN domestic_airports destination ON destination.iata = r.destination_iata AND destination.active = TRUE
           JOIN domestic_airlines a ON a.id = f.airline_id
           WHERE f.id = ? AND f.flight_date >= CURDATE()`,
          [flightId]
        );
        if (!flightRows.length) return { conflict: true };
        return {
          booking_id: existing.booking_id,
          booking_reference: existing.booking_reference,
          transaction_uuid: existing.transaction_uuid,
          amount: existing.amount,
          currency: existing.currency,
          flight: flightRows[0],
          passenger_count: passengerCount,
          passenger,
        };
      }

      const [flights] = await tx.query(
        `SELECT f.id, f.flight_name, f.departure_time, f.duration, f.price, f.flight_date,
                f.seat_capacity, f.seats_reserved, f.seats_booked,
                r.origin_iata AS source, origin.city AS source_name,
                r.destination_iata AS destination, destination.city AS destination_name,
                a.name AS airline_name, a.active AS airline_active
         FROM flights f
         JOIN domestic_routes r ON r.id = f.route_id AND r.active = TRUE
         JOIN domestic_airports origin ON origin.iata = r.origin_iata AND origin.active = TRUE
         JOIN domestic_airports destination ON destination.iata = r.destination_iata AND destination.active = TRUE
         JOIN domestic_airlines a ON a.id = f.airline_id
         WHERE f.id = ? AND f.flight_date >= CURDATE() FOR UPDATE`,
        [flightId]
      );
      const flight = flights[0];
      if (!flight) return null;
      if (!flight.airline_active) return { unavailable: "This airline is not active for domestic schedules." };
      if (Number(flight.seat_capacity) - Number(flight.seats_reserved) - Number(flight.seats_booked) < passengerCount) {
        return { unavailable: "There are not enough seats remaining for this passenger count." };
      }

      const amount = multiplyAmount(flight.price, passengerCount);
      const bookingReference = newBookingReference();
      const transactionUuid = crypto.randomUUID();
      const [reserved] = await tx.query(
        `UPDATE flights SET seats_reserved = seats_reserved + ?
         WHERE id = ? AND seat_capacity - seats_reserved - seats_booked >= ?`,
        [passengerCount, flight.id, passengerCount]
      );
      if (reserved.affectedRows !== 1) return { unavailable: "Seats were just reserved by another customer. Search again." };
      const [createdBooking] = await tx.query(
        "INSERT INTO bookings (user_id, flight_id, booking_reference, passenger_name, passenger_phone, passenger_age, passenger_count, amount, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NPR', 'PENDING')",
        [req.user.id, flight.id, bookingReference, passenger.passengerName, passenger.passengerPhone, passenger.passengerAge, passengerCount, amount]
      );
      await tx.query(
        "INSERT INTO payments (booking_id, transaction_uuid, idempotency_key, provider, amount, currency, status, verification_result) VALUES (?, ?, ?, 'esewa', ?, 'NPR', 'PENDING', 'AWAITING_PAYMENT')",
        [createdBooking.insertId, transactionUuid, idempotencyKey, amount]
      );
      return {
        booking_id: createdBooking.insertId,
        booking_reference: bookingReference,
        transaction_uuid: transactionUuid,
        amount,
        currency: "NPR",
        flight,
        passenger_count: passengerCount,
        passenger,
      };
    });

    if (booking && booking.unavailable) return res.status(409).json({ message: booking.unavailable });
    if (booking && booking.conflict) {
      return res.status(409).json({ message: "This checkout key has already been used for a different or completed booking." });
    }
    if (!booking) return res.status(404).json({ message: "Flight not found." });
    res.status(201).json({
      message: "Payment initialized.",
      booking_id: booking.booking_id,
      booking_reference: booking.booking_reference,
      amount: booking.amount,
      currency: booking.currency,
      flight: booking.flight,
      passenger_count: booking.passenger_count,
      passenger: {
        name: booking.passenger.passengerName,
        phone: booking.passenger.passengerPhone,
        age: booking.passenger.passengerAge,
      },
      ...createPaymentForm(booking),
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "This checkout is already being processed. Retry with the same Idempotency-Key." });
    }
    console.error("Booking creation failed:", error.message);
    res.status(500).json({ message: "Unable to create the booking and payment." });
  }
});

// GET /my-bookings
router.get("/my-bookings", authenticateToken, (req, res) => {
  const sql = `
    SELECT b.id AS booking_id, b.booking_reference, b.passenger_name, b.amount AS price,
           b.passenger_count, b.currency, b.status AS booking_status, b.created_at,
           p.status AS payment_status, p.provider_reference,
           f.flight_name, f.departure_time, f.duration, f.flight_date,
           r.origin_iata AS source, origin.city AS source_name,
           r.destination_iata AS destination, destination.city AS destination_name
    FROM bookings b
    JOIN flights f ON b.flight_id = f.id
    LEFT JOIN domestic_routes r ON r.id = f.route_id
    LEFT JOIN domestic_airports origin ON origin.iata = r.origin_iata
    LEFT JOIN domestic_airports destination ON destination.iata = r.destination_iata
    LEFT JOIN payments p ON p.id = (
      SELECT MAX(p2.id) FROM payments p2 WHERE p2.booking_id = b.id
    )
    WHERE b.user_id = ?
    ORDER BY b.id DESC
  `;
  db.query(sql, [req.user.id], (err, results) => {
    if (err) return res.status(500).json({ message: "Database error." });
    res.json(results);
  });
});

module.exports = router;
