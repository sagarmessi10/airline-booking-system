const isValidEmail = (e) => typeof e === "string" && /^[^\s@]+@gmail\.com$/i.test(e);
const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

module.exports = { isValidEmail, toId };
