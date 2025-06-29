document.addEventListener("DOMContentLoaded", () => {
    const timeInput = document.getElementById("time");
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const formattedNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    timeInput.min = formattedNow;

    const form = document.getElementById("tripForm");
    const tripList = document.getElementById("tripList");
    const mapDiv = document.getElementById("map");

    let map;
    let routeLayer = [];

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
            start_location: document.getElementById("start").value.trim(),
            end_location: document.getElementById("end").value.trim(),
            departure_time: document.getElementById("time").value.replace("T", " "),
            alert_offset: parseInt(document.getElementById("offset").value),
            email: document.getElementById("email").value.trim(),
            mode: document.getElementById("mode").value
        };

        try {
            const res = await fetch("http://localhost:8000/register_trip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (res.ok) {
                await fetchTripsAndAlerts();
                showRouteOnMap(payload.start_location, payload.end_location, payload.mode);
            } else {
                alert(data.error || "Something went wrong while scheduling the trip.");
            }
        } catch (err) {
            console.error("❌ Error connecting to server:", err);
            alert("❌ Error connecting to server.");
        }
    });

    async function fetchTripsAndAlerts() {
        try {
            const [tripRes, alertRes] = await Promise.all([
                fetch("http://localhost:8000/get_trips"),
                fetch("http://localhost:8000/get_alerts")
            ]);

            const trips = await tripRes.json();
            const alerts = await alertRes.json();
            const alertMap = new Map();
            alerts.forEach(alert => alertMap.set(alert.trip_id, alert));

            tripList.innerHTML = "";

            if (trips.length === 0) {
                tripList.innerHTML = "<li>No trips scheduled yet.</li>";
                return;
            }

            trips.forEach(trip => {
                const li = document.createElement("li");
                const alert = alertMap.get(trip.id);
                const alertHTML = alert ? generateAlertHTML(alert) : "<em>🔔 No alerts yet for this trip.</em>";

                const confirmationHTML = trip.confirmed ? (() => {
                    const depTime = new Date(trip.departure_time);
                    const alertTime = new Date(depTime.getTime() - trip.alert_offset * 60000);
                    const pad = (n) => n.toString().padStart(2, '0');
                    const formattedAlertTime = `${pad(alertTime.getHours())}:${pad(alertTime.getMinutes())}`;

                    return `
                        <div class="trip-confirmation">
                            ✅ Trip scheduled!<br>
                            🕒 Current time (Server): <strong>${trip.current_time}</strong><br>
                            ⏱️ Estimated travel time: <strong>${formatEta(trip.current_eta_minutes)}</strong><br>
                            📏 Distance: <strong>${trip.distance_km} km</strong><br>
                            🛫 Planned departure at: <strong>${trip.departure_time}</strong><br>
                            🔔 Alert will trigger at: <strong>${formattedAlertTime}</strong> for <strong>${trip.mode}</strong> mode.
                        </div>
                    `;
                })() : "";

                li.innerHTML = `
                    <div><strong>${trip.start_location} ➡️ ${trip.end_location}</strong>
                    ${confirmationHTML}
                    <div style="margin-top: 10px;">${alertHTML}</div>
                    <button onclick="deleteTrip(${trip.id})" style="margin-top: 10px;">🗑️ Delete Trip</button>
                `;

                tripList.appendChild(li);
            });
        } catch (err) {
            console.error("Failed to fetch trips or alerts:", err);
        }
    }

    function generateAlertHTML(alert) {
        return `
            <div class="alert-item">
                <strong>⏰ Alert Active</strong><br>
                🕒 Current Time: <strong>${alert.current_time}</strong><br>
                🚀 Departure Time: <strong>${alert.departure_time}</strong><br>
                ⏱️ ${alert.message}
                ${alert.distance ? `📏 ${alert.distance}` : ""}
            </div>
        `;
    }

    window.deleteTrip = async function (id) {
        await fetch(`http://localhost:8000/delete_trip/${id}`, {
            method: "DELETE"
        });
        fetchTripsAndAlerts();
    };

    async function geocode(location) {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`, {
            headers: { "User-Agent": "maps-alert-app" }
        });
        const data = await res.json();
        if (data && data.length > 0) {
            return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
        }
        return null;
    }

    async function showRouteOnMap(start, end, mode = "driving") {
        const startCoords = await geocode(start);
        const endCoords = await geocode(end);
        if (!startCoords || !endCoords) return;

        const url = `http://router.project-osrm.org/route/v1/${mode}/${startCoords[1]},${startCoords[0]};${endCoords[1]},${endCoords[0]}?overview=full&geometries=geojson&alternatives=true`;

        const res = await fetch(url);
        const data = await res.json();
        if (data.code !== "Ok") return;

        const colorByMode = {
            driving: "#007BFF",
            walking: "#28a745",
            cycling: "#ffc107",
            motorcycle: "#6f42c1",
            scooter: "#fd7e14",
            transit: "#17a2b8"
        };
        const primaryColor = colorByMode[mode] || "#007BFF";

        if (!map) initializeMap();

        if (routeLayer.length) {
            routeLayer.forEach(layer => map.removeLayer(layer));
        }
        routeLayer = [];

        let midRoutePopupOpened = false;

        data.routes.forEach((route, index) => {
            const routeColor = index === 0 ? primaryColor : "#999";
            const distKm = (route.distance / 1000).toFixed(2);
            const rawEtaMin = Math.round(route.duration / 60);
            const etaMultipliers = {
                driving: 1.0,
                walking: 2.5,
                cycling: 1.5,
                motorcycle: 0.75,
                scooter: 0.9,
                transit: 1.2
            };
            const adjustedEtaMin = Math.round(rawEtaMin * (etaMultipliers[mode] || 1.0));


            const geojsonLayer = L.geoJSON(route.geometry, {
                style: {
                    color: routeColor,
                    weight: 4,
                    dashArray: index === 0 ? null : "6 6"
                }
            }).addTo(map);

            routeLayer.push(geojsonLayer);

            if (index === 0 && route.geometry.coordinates.length > 0) {
                const coords = route.geometry.coordinates;
                const midIndex = Math.floor(coords.length / 2);
                const [lon, lat] = coords[midIndex];

                const popupText = `Route 1<br>ETA: ${formatEta(adjustedEtaMin)}<br>Distance: ${distKm} km`;


                // Add invisible marker to bind and open popup
                const marker = L.marker([lat, lon], { opacity: 0 })
                    .addTo(map)
                    .bindPopup(popupText)
                    .openPopup();
            } else {
                geojsonLayer.bindPopup(`Route ${index + 1}<br>ETA: ${formatEta(adjustedEtaMin)}<br>Distance: ${distKm} km`);

            }
        });

        setTimeout(() => {
            map.invalidateSize();
            const boundsList = routeLayer.map(l => l.getBounds());
            const combinedBounds = boundsList.reduce((acc, b) => acc.extend(b), boundsList[0]);
            map.fitBounds(combinedBounds);
        }, 300);

        mapDiv.style.display = "block";
    }


    function initializeMap() {
        const baseLayers = {
            "Street View": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                attribution: "&copy; OpenStreetMap contributors"
            }),
            "Satellite View": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
                attribution: "&copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye"
            }),
            "Dark Mode": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
                attribution: "&copy; CartoDB & OpenStreetMap contributors"
            })
        };

        map = L.map("map", {
            center: [20.5937, 78.9629],
            zoom: 5,
            layers: [baseLayers["Street View"]]
        });

        L.control.layers(baseLayers).addTo(map);
    }

    async function fetchLocationSuggestions(query, boxId, inputId) {
        const box = document.getElementById(boxId);
        const input = document.getElementById(inputId);

        if (!query || query.length < 2) {
            box.classList.remove("show");
            return;
        }

        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`, {
            headers: { "User-Agent": "maps-alert-app" }
        });
        const data = await res.json();

        box.innerHTML = "";

        if (!data.length) {
            box.classList.remove("show");
            return;
        }

        data.forEach(item => {
            const div = document.createElement("div");
            div.className = "suggestion-item";
            div.textContent = item.display_name;
            div.onclick = () => {
                input.value = item.display_name;
                box.classList.remove("show");
            };
            box.appendChild(div);
        });

        box.classList.add("show");
    }



    async function startClock() {
        const el = document.getElementById("clock");
        async function update() {
            try {
                const res = await fetch("http://localhost:8000/get_time");
                const { current_time } = await res.json();
                el.textContent = "🕒 Live Clock: " + current_time.split(" ")[1];
            } catch (e) {
                console.error("Clock sync failed:", e);
            }
        }
        await update();
        setInterval(update, 1000);
    }

    const debounce = (fn, delay) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn(...args), delay);
        };
    };

    document.getElementById("start").addEventListener("input", debounce((e) => {
        fetchLocationSuggestions(e.target.value, "startSuggestions", "start");
    }, 300));

    document.getElementById("end").addEventListener("input", debounce((e) => {
        fetchLocationSuggestions(e.target.value, "endSuggestions", "end");
    }, 300));

    function formatEta(minutes) {
        if (!minutes || isNaN(minutes)) return "Unknown";
        const hrs = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (hrs && mins) return `${hrs} hr ${mins} min`;
        if (hrs) return `${hrs} hr`;
        return `${mins} min`;
    }



    startClock();
    fetchTripsAndAlerts();
    initializeMap();
    setInterval(fetchTripsAndAlerts, 30000);
});
