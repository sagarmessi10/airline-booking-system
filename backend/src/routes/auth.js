const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const env = require("../config/env");
const { authenticateToken } = require("../middleware/auth");
const { isValidEmail } = require("../utils/validators");

const router = express.Router();
const signToken = (u) => jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role }, env.jwtSecret, { expiresIn: "7d" });

// POST /register
router.post("/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!name || !email || !password) return res.status(400).json({ message: "Name, email, and password are required." });
  if (!isValidEmail(email)) return res.status(400).json({ message: "Please enter a valid Gmail address." });
  if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });

  db.query("SELECT id FROM user WHERE email = ?", [email], async (err, results) => {
    if (err) return res.status(500).json({ message: "Database error." });
    if (results.length > 0) return res.status(409).json({ message: "An account with this email already exists." });

    try {
      const hashed = await bcrypt.hash(password, 10);
      const role = email === env.adminEmail ? "admin" : "user";
      db.query("INSERT INTO user (name, email, password, role) VALUES (?, ?, ?, ?)", [name, email, hashed, role], (err, result) => {
        if (err) {
          if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "An account with this email already exists." });
          console.error("Register error:", err.message);
          return res.status(500).json({ message: "Failed to create account." });
        }
        const user = { id: result.insertId, name, email, role };
        res.status(201).json({ message: "Account created successfully!", token: signToken(user), user });
      });
    } catch (e) {
      res.status(500).json({ message: "Server error during registration." });
    }
  });
});

// POST /login
router.post("/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) return res.status(400).json({ message: "Email and password are required." });
  if (!isValidEmail(email)) return res.status(400).json({ message: "Please enter a valid Gmail address." });

  db.query("SELECT * FROM user WHERE email = ?", [email], async (err, results) => {
    if (err) return res.status(500).json({ message: "Database error." });
    if (results.length === 0) return res.status(401).json({ message: "No account found with this email." });

    const u = results[0];
    try {
      if (!(await bcrypt.compare(password, u.password))) {
        return res.status(401).json({ message: "Incorrect password. Please try again." });
      }
      const user = { id: u.id, name: u.name, email: u.email, role: u.role };
      res.json({ message: "Login successful!", token: signToken(user), user });
    } catch (e) {
      res.status(500).json({ message: "Server error during login." });
    }
  });
});

// GET /me
router.get("/me", authenticateToken, (req, res) => res.json({ user: req.user }));

module.exports = router;
