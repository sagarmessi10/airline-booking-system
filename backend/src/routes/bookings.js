const express = require("express");
const crypto = require("crypto");
const db = require("../config/db");
const { authenticateToken } = require("../middleware/auth");
const { isValidEmail, toId } = require("../utils/validators");
const { createPaymentForm, paymentIsConfigured } = require("./payments");
const { formatAmount } = require("../utils/esewa");

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
  const passenger = validatePassenger(body);
  if (passenger.error) return res.status(400).json({ message: passenger.error });

  try {
    const booking = await db.transaction(async (tx) => {
      const [flights] = await tx.query(
        "SELECT id, flight_name, source, destination, departure_time, duration, price FROM flights WHERE id = ?",
        [flightId]
      );
      const flight = flights[0];
      if (!flight) return null;

      const amount = formatAmount(flight.price);
      const bookingReference = newBookingReference();
      const transactionUuid = crypto.randomUUID();
      const [createdBooking] = await tx.query(
        "INSERT INTO bookings (user_id, flight_id, booking_reference, passenger_name, passenger_phone, passenger_age, amount, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'NPR', 'PENDING')",
        [req.user.id, flight.id, bookingReference, passenger.passengerName, passenger.passengerPhone, passenger.passengerAge, amount]
      );
      const [createdPayment] = await tx.query(
        "INSERT INTO payments (booking_id, transaction_uuid, provider, amount, currency, status, verification_result) VALUES (?, ?, 'esewa', ?, 'NPR', 'PENDING', 'AWAITING_PAYMENT')",
        [createdBooking.insertId, transactionUuid, amount]
      );
      return {
        id: createdPayment.insertId,
        booking_id: createdBooking.insertId,
        booking_reference: bookingReference,
        transaction_uuid: transactionUuid,
        amount,
        currency: "NPR",
        flight,
        passenger,
      };
    });

    if (!booking) return res.status(404).json({ message: "Flight not found." });
    res.status(201).json({
      message: "Payment initialized.",
      booking_id: booking.booking_id,
      booking_reference: booking.booking_reference,
      amount: booking.amount,
      currency: booking.currency,
      flight: booking.flight,
      passenger: {
        name: booking.passenger.passengerName,
        phone: booking.passenger.passengerPhone,
        age: booking.passenger.passengerAge,
      },
      ...createPaymentForm(booking),
    });
  } catch (error) {
    console.error("Booking creation failed:", error.message);
    res.status(500).json({ message: "Unable to create the booking and payment." });
  }
});

// GET /my-bookings
router.get("/my-bookings", authenticateToken, (req, res) => {
  const sql = `
    SELECT b.id AS booking_id, b.booking_reference, b.passenger_name, b.amount AS price,
           b.currency, b.status AS booking_status, b.created_at,
           p.status AS payment_status, p.provider_reference,
           f.flight_name, f.source, f.destination, f.departure_time, f.duration
    FROM bookings b
    JOIN flights f ON b.flight_id = f.id
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
