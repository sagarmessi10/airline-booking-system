const { airports } = require("../../data/domestic-registry");
const { toId } = require("./validators");

const domesticAirportCodes = new Set(airports.map((airport) => airport.iata));

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateAirportCode(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return domesticAirportCodes.has(code) ? code : null;
}

function validateSearch(query) {
  const origin = validateAirportCode(query.origin);
  const destination = validateAirportCode(query.destination);
  const date = typeof query.date === "string" ? query.date : "";
  const passengers = Number(query.passengers);
  if (!origin || !destination) return { error: "Select valid domestic airports in Nepal." };
  if (origin === destination) return { error: "Origin and destination must be different airports." };
  if (!isValidDate(date)) {
    return { error: "Enter a valid departure date." };
  }
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 9) {
    return { error: "Passenger count must be between 1 and 9." };
  }
  return { origin, destination, date, passengers };
}

function validateRoute(body) {
  const origin = validateAirportCode(body.origin_iata);
  const destination = validateAirportCode(body.destination_iata);
  if (!origin || !destination) return { error: "Routes must use airports from the verified Nepal registry." };
  if (origin === destination) return { error: "Origin and destination must be different airports." };
  return { route: { origin_iata: origin, destination_iata: destination } };
}

function validateSchedule(body) {
  const routeId = toId(body.route_id);
  const airlineId = toId(body.airline_id);
  const flightName = typeof body.flight_name === "string" ? body.flight_name.trim() : "";
  const flightDate = typeof body.flight_date === "string" ? body.flight_date : "";
  const departureTime = typeof body.departure_time === "string" ? body.departure_time : "";
  const duration = typeof body.duration === "string" ? body.duration.trim() : "";
  const price = Number(body.price);
  const seatCapacity = Number(body.seat_capacity);

  if (routeId === null || airlineId === null) return { error: "Select a domestic route and airline." };
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,29}$/.test(flightName)) return { error: "Enter a valid flight number or schedule label." };
  if (!isValidDate(flightDate)) {
    return { error: "Enter a valid schedule date." };
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(departureTime)) return { error: "Departure time must use 24-hour HH:MM format." };
  if (!/^(?:\d{1,2}h(?:\s?\d{1,2}m)?|\d{1,3}m)$/.test(duration)) {
    return { error: "Enter a duration such as 35m or 1h 15m." };
  }
  if (!Number.isFinite(price) || price <= 0 || price > 10000000 || Math.round(price * 100) !== price * 100) {
    return { error: "Fare must be a positive amount up to NPR 10,000,000 with at most two decimal places." };
  }
  if (!Number.isInteger(seatCapacity) || seatCapacity < 1 || seatCapacity > 500) {
    return { error: "Seat inventory must be between 1 and 500." };
  }
  return {
    schedule: {
      route_id: routeId,
      airline_id: airlineId,
      flight_name: flightName,
      flight_date: flightDate,
      departure_time: departureTime,
      duration,
      price,
      seat_capacity: seatCapacity,
    },
  };
}

module.exports = { domesticAirportCodes, validateAirportCode, validateSearch, validateRoute, validateSchedule };
