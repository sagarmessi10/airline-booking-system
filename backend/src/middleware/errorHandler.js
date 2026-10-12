function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON in request body." });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal server error." });
}

module.exports = { notFound, errorHandler };
