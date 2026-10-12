const express = require("express");
const db = require("../config/db");
const env = require("../config/env");
const { airports } = require("../../data/domestic-registry");
const { validateSearch } = require("../utils/domestic");

const router = express.Router();
const AVIATIONSTACK_FLIGHTS_URL = "https://api.aviationstack.com/v1/flights";
const PROVIDER_TIMEOUT_MS = 8000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const CACHE_TTL_MS = 2 * 60_000;
const MAX_CACHE_ENTRIES = 300;
const MAX_RATE_LIMIT_ENTRIES = 5000;
const airportByCode = new Map(airports.map((airport) => [airport.iata, airport]));
const responseCache = new Map();
const rateLimitBuckets = new Map();

function queryRows(sql, params) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

function consumeRateLimit(ip, now = Date.now()) {
  const bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { startedAt: now, count: 1 });
    if (rateLimitBuckets.size > MAX_RATE_LIMIT_ENTRIES) {
      const oldestIp = rateLimitBuckets.keys().next().value;
      rateLimitBuckets.delete(oldestIp);
    }
    return { allowed: true };
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.startedAt)) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true };
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapFlight(item, search) {
  if (!item || typeof item !== "object" || item.flight_date !== search.date ||
      !item.departure || !item.arrival ||
      String(item.departure.iata || "").toUpperCase() !== search.origin ||
      String(item.arrival.iata || "").toUpperCase() !== search.destination) {
    return null;
  }

  const departureAirport = airportByCode.get(search.origin);
  const arrivalAirport = airportByCode.get(search.destination);
  const flightNumber = optionalString(item.flight && item.flight.iata) ||
    optionalString(item.flight && item.flight.number);
  const live = item.live && typeof item.live === "object" ? item.live : {};

  return {
    flight_date: search.date,
    flight_number: flightNumber,
    airline_name: optionalString(item.airline && item.airline.name),
    flight_status: optionalString(item.flight_status),
    departure: {
      airport_code: search.origin,
      airport_name: departureAirport.name,
      scheduled: optionalString(item.departure.scheduled),
      estimated: optionalString(item.departure.estimated),
      actual: optionalString(item.departure.actual),
      delay_minutes: Number.isFinite(item.departure.delay) ? item.departure.delay : null,
      terminal: optionalString(item.departure.terminal),
      gate: optionalString(item.departure.gate),
    },
    arrival: {
      airport_code: search.destination,
      airport_name: arrivalAirport.name,
      scheduled: optionalString(item.arrival.scheduled),
      estimated: optionalString(item.arrival.estimated),
      actual: optionalString(item.arrival.actual),
      delay_minutes: Number.isFinite(item.arrival.delay) ? item.arrival.delay : null,
      terminal: optionalString(item.arrival.terminal),
      gate: optionalString(item.arrival.gate),
    },
    provider_updated_at: optionalString(live.updated),
  };
}

function getCached(key, now) {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (now - cached.cachedAt >= CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached.response;
}

function cacheResponse(key, response, now) {
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, { cachedAt: now, response });
}

async function requestFlights(search) {
  const url = new URL(AVIATIONSTACK_FLIGHTS_URL);
  url.searchParams.set("access_key", env.aviationstack.apiKey);
  url.searchParams.set("dep_iata", search.origin);
  url.searchParams.set("arr_iata", search.destination);
  url.searchParams.set("flight_date", search.date);
  url.searchParams.set("limit", "100");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      return { error: "invalid_response" };
    }

    if (response.status === 429 || (body && body.error && body.error.code === 104)) {
      return { error: "rate_limited" };
    }
    if (!response.ok || !body || body.error || !Array.isArray(body.data)) {
      const providerCode = body && body.error && body.error.code;
      console.warn("Aviationstack request failed.", { status: response.status, providerCode });
      return { error: "unavailable" };
    }
    return { data: body.data };
  } catch (error) {
    if (error.name === "AbortError") return { error: "timeout" };
    console.warn("Aviationstack request could not be completed.");
    return { error: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

router.get("/airports/domestic", async (req, res) => {
  try {
    const rows = await queryRows(
      "SELECT iata, name, city, province FROM domestic_airports WHERE active = TRUE ORDER BY city",
      []
    );
    res.json(rows);
  } catch (error) {
    console.error("Domestic airport API failed:", error.message);
    res.status(500).json({ message: "Unable to load domestic airports." });
  }
});

router.get("/flights/live", async (req, res) => {
  const rate = consumeRateLimit(req.ip || req.socket.remoteAddress || "unknown");
  if (!rate.allowed) {
    res.set("Retry-After", String(rate.retryAfter));
    return res.status(429).json({
      code: "LIVE_SEARCH_RATE_LIMITED",
      message: "Too many live flight searches. Please wait before trying again.",
    });
  }

  const search = validateSearch(req.query);
  if (search.error) return res.status(400).json({ code: "INVALID_SEARCH", message: search.error });

  try {
    const routes = await queryRows(
      `SELECT r.id FROM domestic_routes r
       JOIN domestic_airports origin ON origin.iata = r.origin_iata AND origin.active = TRUE
       JOIN domestic_airports destination ON destination.iata = r.destination_iata AND destination.active = TRUE
       WHERE r.origin_iata = ? AND r.destination_iata = ? AND r.active = TRUE`,
      [search.origin, search.destination]
    );
    if (!routes.length) {
      return res.status(400).json({
        code: "UNSUPPORTED_DOMESTIC_ROUTE",
        message: "This domestic airport pair is not enabled. Choose a supported route.",
      });
    }
  } catch (error) {
    console.error("Domestic route validation failed:", error.message);
    return res.status(500).json({ code: "ROUTE_VALIDATION_FAILED", message: "Unable to validate this domestic route." });
  }

  if (!env.aviationstack.apiKey) {
    return res.status(503).json({
      code: "LIVE_PROVIDER_NOT_CONFIGURED",
      message: "Live flight data is not configured. Add AVIATIONSTACK_API_KEY to the backend environment and restart the server.",
    });
  }

  const cacheKey = `${search.origin}:${search.destination}:${search.date}`;
  const cached = getCached(cacheKey, Date.now());
  if (cached) return res.json(cached);

  const providerResult = await requestFlights(search);
  if (providerResult.error === "timeout") {
    return res.status(504).json({
      code: "LIVE_PROVIDER_TIMEOUT",
      message: "The live flight provider took too long to respond. No demo data is shown as live.",
    });
  }
  if (providerResult.error === "rate_limited") {
    return res.status(503).json({
      code: "LIVE_PROVIDER_RATE_LIMITED",
      message: "The live flight provider has reached its request limit. Please try again later.",
    });
  }
  if (providerResult.error) {
    return res.status(502).json({
      code: "LIVE_PROVIDER_UNAVAILABLE",
      message: "Live flight data is temporarily unavailable. No demo data is shown as live.",
    });
  }

  const flights = providerResult.data
    .map((item) => mapFlight(item, search))
    .filter(Boolean);
  const response = {
    source: "AVIATIONSTACK",
    origin: search.origin,
    destination: search.destination,
    date: search.date,
    checked_at: new Date().toISOString(),
    flights,
  };
  cacheResponse(cacheKey, response, Date.now());
  res.json(response);
});

module.exports = router;
