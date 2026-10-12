const isValidEmail = (e) => typeof e === "string" && /^[^\s@]+@gmail\.com$/i.test(e);
const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

function validateFlight(body) {
  const flight_name = String(body.flight_name || "").trim();
  const source = String(body.source || "").trim();
  const destination = String(body.destination || "").trim();
  const departure_time = String(body.departure_time || "").trim() || null;
  const duration = String(body.duration || "").trim() || "1h 15m";
  const price = Number(body.price);

  if (!flight_name || !source || !destination) {
    return { error: "Flight name, source and destination are required." };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { error: "Price must be a valid positive number." };
  }
  return { flight: { flight_name, source, destination, departure_time, price, duration } };
}

module.exports = { isValidEmail, toId, validateFlight };
