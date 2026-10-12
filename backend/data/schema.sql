-- AeroNepal schema. Executed automatically on server start (CREATE ... IF NOT EXISTS, safe to re-run).
-- You can also import it manually:  mysql -u root -p airline_db < schema.sql

CREATE TABLE IF NOT EXISTS `user` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS domestic_airports (
  iata CHAR(3) PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  city VARCHAR(100) NOT NULL,
  province VARCHAR(40) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS domestic_airlines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  iata CHAR(2) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS domestic_routes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  origin_iata CHAR(3) NOT NULL,
  destination_iata CHAR(3) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_domestic_route (origin_iata, destination_iata),
  FOREIGN KEY (origin_iata) REFERENCES domestic_airports(iata),
  FOREIGN KEY (destination_iata) REFERENCES domestic_airports(iata)
);

CREATE TABLE IF NOT EXISTS flights (
  id INT AUTO_INCREMENT PRIMARY KEY,
  flight_name VARCHAR(100) NOT NULL,
  source VARCHAR(100) NOT NULL,
  destination VARCHAR(100) NOT NULL,
  departure_time VARCHAR(50) NULL,
  price DECIMAL(10,2) NOT NULL,
  duration VARCHAR(20) NOT NULL DEFAULT '1h 15m',
  route_id INT NULL,
  airline_id INT NULL,
  flight_date DATE NULL,
  arrival_time TIME NULL,
  seat_capacity SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  seats_reserved SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  seats_booked SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  inventory_source VARCHAR(30) NOT NULL DEFAULT 'ADMIN_DEMO',
  INDEX ix_flights_search (flight_date, route_id, airline_id),
  UNIQUE KEY uq_flights_schedule (route_id, airline_id, flight_date, departure_time, flight_name),
  CONSTRAINT fk_flights_domestic_route FOREIGN KEY (route_id) REFERENCES domestic_routes(id) ON DELETE RESTRICT,
  CONSTRAINT fk_flights_domestic_airline FOREIGN KEY (airline_id) REFERENCES domestic_airlines(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  flight_id INT NOT NULL,
  booking_reference VARCHAR(40) NOT NULL,
  passenger_name VARCHAR(100) NOT NULL,
  passenger_phone VARCHAR(30) NOT NULL,
  passenger_age SMALLINT NOT NULL,
  passenger_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NPR',
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bookings_reference (booking_reference),
  FOREIGN KEY (user_id) REFERENCES `user`(id) ON DELETE CASCADE,
  FOREIGN KEY (flight_id) REFERENCES flights(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  booking_id INT NOT NULL,
  transaction_uuid VARCHAR(100) NOT NULL,
  idempotency_key VARCHAR(100) NULL,
  provider VARCHAR(20) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  provider_reference VARCHAR(100) NULL,
  verification_result VARCHAR(40) NOT NULL DEFAULT 'AWAITING_PAYMENT',
  callback_signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  verified_at TIMESTAMP NULL,
  UNIQUE KEY uq_payments_transaction_uuid (transaction_uuid),
  UNIQUE KEY uq_payments_idempotency_key (idempotency_key),
  INDEX ix_payments_booking_id (booking_id),
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
