# backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta
import requests
from apscheduler.schedulers.background import BackgroundScheduler
import uvicorn
import smtplib
from email.message import EmailMessage
import uuid


app = FastAPI()

# Allow frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



def format_eta(minutes):
    if minutes is None:
        return "Unknown"
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f"{hours} hr {mins} min"
    elif hours:
        return f"{hours} hr"
    else:
        return f"{mins} min"


def send_email(to_email, subject, body):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = "hamza.ghojaria123@gmail.com"          # ✅ Replace with your email
    msg["To"] = to_email
    msg.set_content(body)

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login("hamza.ghojaria123@gmail.com", "gemn lfjj gaey cgdl")  # ✅ Use App Password #Website Link: https://myaccount.google.com/apppasswords
            smtp.send_message(msg)
        print(f"📧 Email sent to {to_email}")
    except Exception as e:
        print(f"❌ Failed to send email: {e}")



# In-memory storage for demo
trips = []
alerts = []  # ✅ New: store alerts

scheduler = BackgroundScheduler()
scheduler.start()

class Trip(BaseModel):
    id: int = None
    start_location: str
    end_location: str
    departure_time: str  # Format: "2025-06-19 08:00"
    alert_offset: int    # Minutes before departure
    mode: str = "walking"  # Default mode
    recurrence: str = None
    email: str = None  # ✅ Add this

@app.post("/register_trip")
def register_trip(trip: Trip):
    print("✅ Received trip with mode:", trip.mode)  # 👈 ADD THIS LINE
    trip_data = trip.dict()
    trip_data['id'] = str(uuid.uuid4())


    start_lat, start_lon = geocode_location(trip.start_location)
    end_lat, end_lon = geocode_location(trip.end_location)

    if None in (start_lat, start_lon, end_lat, end_lon):
        return {"error": "Failed to geocode one or both locations."}

    departure_dt = datetime.strptime(trip.departure_time, "%Y-%m-%d %H:%M")
    alert_time = departure_dt - timedelta(minutes=trip.alert_offset)

    # Fetch current ETA
    current_eta_min,current_distance_km = get_eta_now(start_lat, start_lon, end_lat, end_lon, trip.mode)
    print(f"🧪 Calling get_eta_now with: {trip.mode}")

    current_time_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    # ✅ Store confirmation info in the trip
    trip_data.update({
        "confirmed": True,
        "current_time": current_time_str,
        "current_eta_minutes": current_eta_min,
        "distance_km": current_distance_km
    })

    trips.append(trip_data)

    # Schedule alert
    scheduler.add_job(
    check_route,
    'date',
    run_date=alert_time,
    args=[
        start_lat, start_lon, end_lat, end_lon,
        trip.departure_time, trip_data['id'], trip.mode,
        trip.start_location, trip.end_location,
        trip_data['email']  # ✅ Pass email to the alert
    ]
    )

    return {
        "message": "Trip registered and alert scheduled.",
        "trip_id": trip_data['id'],
        "current_time": current_time_str,
        "departure_time": trip.departure_time,
        "eta_formatted": format_eta(current_eta_min),
        #"current_eta_minutes": current_eta_min,
        "distance_km": current_distance_km
    }


@app.get("/get_trips")
def get_trips():
    return trips

@app.get("/get_time")
def get_time():
    return {"current_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


@app.get("/get_alerts")
def get_alerts():
    return alerts

@app.delete("/delete_trip/{trip_id}")
def delete_trip(trip_id: int):
    global trips
    trips = [t for t in trips if t['id'] != trip_id]
    return {"message": f"Trip {trip_id} deleted."}

@app.put("/update_trip/{trip_id}")
def update_trip(trip_id: int, updated_trip: Trip):
    for i, t in enumerate(trips):
        if t['id'] == trip_id:
            updated_data = updated_trip.dict()
            updated_data['id'] = trip_id
            trips[i] = updated_data
            return {"message": f"Trip {trip_id} updated."}
    return {"error": "Trip not found."}

def geocode_location(location: str):
    url = f"https://nominatim.openstreetmap.org/search?q={location}&format=json&limit=1"
    try:
        response = requests.get(url, headers={"User-Agent": "maps-alert-app"})
        data = response.json()
        if data:
            return float(data[0]['lat']), float(data[0]['lon'])
    except Exception as e:
        print(f"Geocoding error for '{location}': {e}")
    return None, None


# Multipliers to simulate other modes based on driving ETA
ETA_MULTIPLIERS = {
    "driving": 1.0,
    "walking": 2.5,        # Walking takes longer
    "cycling": 1.5,        # Cycling is slower than driving
    "motorcycle": 0.75,    # Motorcycle faster than car
    "scooter": 0.9,        # Slightly faster than driving in traffic
    "transit": 1.2         # Simulate public transport
}

def get_eta_now(start_lat, start_lon, end_lat, end_lon, mode):
    print(f"🛣️ Mode received for routing: {mode}")
    
    osrm_mode = mode if mode in ['driving', 'walking', 'cycling'] else 'driving'
    
    url = f"http://router.project-osrm.org/route/v1/{osrm_mode}/{start_lon},{start_lat};{end_lon},{end_lat}?overview=false"
    
    try:
        print("Get ETA Now", url)
        response = requests.get(url)
        data = response.json()
        if data.get('code') == 'Ok':
            best_route = data['routes'][0]
            base_eta_min = round(best_route['duration'] / 60)

            multiplier = ETA_MULTIPLIERS.get(mode, 1.0)
            adjusted_eta = round(base_eta_min * multiplier)
            distance = best_route['distance']

            print(f"Base ETA: {base_eta_min} min, Adjusted for '{mode}': {adjusted_eta} min")
            return adjusted_eta, round(distance / 1000, 2)
    except Exception as e:
        print(f"ETA fetch error: {e}")
    return None



def check_route(start_lat, start_lon, end_lat, end_lon, departure_time, trip_id, mode, start_location, end_location, email):
    print(f"[Alert] Checking best route from ({start_lat}, {start_lon}) to ({end_lat}, {end_lon}) for {departure_time} [Trip ID: {trip_id}] via {mode}")

    url = (
        f"http://router.project-osrm.org/route/v1/{mode}/"
        f"{start_lon},{start_lat};{end_lon},{end_lat}?overview=full&alternatives=true"
    )
    response = requests.get(url)
    data = response.json()
    print("response",response)
    if data.get('code') == 'Ok':
        best_route = data['routes'][0]
        duration_sec = best_route['duration']
        distance_m = best_route['distance']
        base_eta_min = round(duration_sec / 60)
        distance_km = round(distance_m / 1000, 2)

        multiplier = ETA_MULTIPLIERS.get(mode, 1.0)
        adjusted_eta_min = round(base_eta_min * multiplier)
        adjusted_distance_km = distance_km  # distance doesn’t change per mode


        # Google Maps link
        gmaps_mode = {
            "driving": "driving",
            "walking": "walking",
            "cycling": "bicycling",
            "motorcycle": "two-wheeler",  # fallback
            "scooter": "two-wheeler",     # fallback
            "transit": "transit"
        }.get(mode, "driving")

        map_link = (
            f"https://www.google.com/maps/dir/?api=1&origin={start_lat},{start_lon}&destination={end_lat},{end_lon}&travelmode={gmaps_mode}"   
        )
        map_link1 = (
         f"https://www.google.com/maps/dir/?api=1"
            f"&origin={start_location.replace(' ', '+')}"
            f"&destination={end_location.replace(' ', '+')}"
            f"&travelmode={gmaps_mode}"
        )

        alert_msg = {
            "trip_id": trip_id,
            "message": f"🚗 It's time to leave! ETA is {format_eta(adjusted_eta_min)}.",
            "distance": f"{adjusted_distance_km} km",
            "departure_time": departure_time,
            "current_time": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "start_location": start_location,
            "end_location": end_location
        }

        alerts.append(alert_msg)
        if email:
            subject = "🚨 Maps Alert: Time to Leave!"
            body = (
            "🚨 Trip Alert: Time to Leave! 🚨\n\n"
            f"Hi there!\n\n"
            f"Your scheduled trip:\n"
            f"🔹 From: {start_location}\n"
            f"🔹 To: {end_location}\n"
            f"🔹 Mode: {mode.title()}\n"
            f"🕒 Estimated Travel Time: {format_eta(adjusted_eta_min)}\n"
            f"🧭 Alternate Routes:\n{alt_routes_info or 'No alternate routes found.'}"
            f"📏 Distance: {adjusted_distance_km} km\n"
            f"🛫 Departure Time: {departure_time}\n\n"
            "👉 It's the best time to leave now to arrive on time.\n\n"
            f"🗺️ View on Map: {map_link}\n\n"
            f"🗺️ View on Map: {map_link1}\n\n"
            "Have a safe journey! ✨\n"
            "-- Maps Alert Team 🌍"
        )
           
  
            send_email(email, subject, body)

        print(f"Best route ETA: {adjusted_eta_min} minutes")

        alt_routes_info = ""
        for i, route in enumerate(data['routes'][1:], start=2):
            alt_min = round(route['duration'] / 60)
            alt_eta = round(alt_min * ETA_MULTIPLIERS.get(mode, 1.0))
            alt_routes_info += f"🛤️ Route {i} ETA: {format_eta(alt_eta)}\n"
            print(f"Alternative route {i} ETA: {alt_eta} minutes")


    else:
        print(f"Route check failed: {data.get('message', 'Unknown error')}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)

