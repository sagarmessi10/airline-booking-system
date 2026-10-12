const API_URL = "http://localhost:5000";

// Add flight
document.getElementById("addFlightForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const flight = {
        flight_name: document.getElementById("flight_name").value,
        source: document.getElementById("source").value,
        destination: document.getElementById("destination").value,
        departure_time: document.getElementById("departure_time").value,
        price: document.getElementById("price").value
    };

    const res = await fetch(`${API_URL}/add-flight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flight)
    });

    const data = await res.text();
    alert(data);
    loadFlights(); // reload flight list
});

// Load all flights
async function loadFlights() {
    const res = await fetch(`${API_URL}/flights`);
    const flights = await res.json();

    const list = document.getElementById("flightsList");
    list.innerHTML = "";
    flights.forEach(flight => {
        const li = document.createElement("li");
        li.textContent = `${flight.flight_name} | ${flight.source} → ${flight.destination} | ${flight.departure_time} | Rs.${flight.price}`;
        list.appendChild(li);
    });
}

// Initial load
loadFlights();