from flask import Flask, request, jsonify
from flask_cors import CORS
import pandas as pd
import numpy as np
import joblib
from datetime import datetime
import os
import psycopg2
from psycopg2 import errors
import math
from twilio.rest import Client

app = Flask(__name__)
CORS(app)

# =========================
# LOAD MODELS
# =========================
rf     = joblib.load("real_models/rf_model.pkl")
scaler = joblib.load("real_models/scaler.pkl")
le     = joblib.load("real_models/label_encoder.pkl")
print("Model Loaded")

# =========================
# DB CONFIG
# =========================
DB_CONFIG = {
    "host":     os.getenv("PGHOST",     "10.175.146.214"),
    "port":     int(os.getenv("PGPORT", "5432")),
    "dbname":   os.getenv("PGDATABASE", "app_db"),
    "user":     os.getenv("PGUSER",     "admin"),
    "password": os.getenv("PGPASSWORD", "password"),
}

# =========================
# TWILIO CONFIG
# =========================
TWILIO_ACCOUNT_SID = "SID"
TWILIO_AUTH_TOKEN  = "TOKEN"
TWILIO_FROM_NUMBER = "NUMBER1"
TWILIO_TO_NUMBER   = "NUMBER2"

# =========================
# FEATURE ORDER (must match training exactly — 13 features)
# =========================
FEATURE_ORDER = [
    "temperature_C",
    "humidity_%",
    "vibration_g",
    "noise_dB",
    "temp_x_humidity",
    "vib_x_noise",
    "temp_hum_sum",
    "temp_vib_ratio",
    "noise_vib_ratio",
    "temp_noise_product",
    "hour",
    "minute",
    "dayofweek",
]

# =============================================================
# THRESHOLD DEFINITIONS  (from Smart Rack Threshold Rule Set)
# =============================================================
# Temperature (°C)
T_NORMAL_MAX  = 30.0   # T0: < 30  → Normal
T_WARNING_MAX = 37.0   # T1: 30–37 → Warning
                       # T2: > 37  → Critical

# Humidity (%)
H_NORMAL_LOW  = 45.0   # H0: 45–55 → Normal
H_NORMAL_HIGH = 55.0
H_WARNING_LOW = 35.0   # H1: 35–45 OR 55–65 → Warning
H_WARNING_HIGH= 65.0
                       # H2: < 35 OR > 65 → Critical

# Vibration (g)
VB_NORMAL_MAX  = 0.48  # VB0: < 0.48  → Normal
VB_WARNING_MAX = 0.75  # VB1: 0.48–0.75 → Warning
                       # VB2: > 0.75   → Critical

# Noise (dB)
N_NORMAL_MAX  = 50.0   # N0: < 50    → Normal
N_WARNING_MAX = 53.0   # N1: 50–53   → Warning
                       # N2: > 53    → Critical


def classify_temp(t):
    if t < T_NORMAL_MAX:  return 0   # Normal
    if t <= T_WARNING_MAX: return 1  # Warning
    return 2                          # Critical

def classify_humidity(h):
    if H_NORMAL_LOW <= h <= H_NORMAL_HIGH: return 0   # Normal
    if H_WARNING_LOW <= h <= H_WARNING_HIGH: return 1  # Warning (covers 35-45 and 55-65)
    return 2                                            # Critical (< 35 or > 65)

def classify_vibration(v):
    if v < VB_NORMAL_MAX:  return 0  # Normal
    if v <= VB_WARNING_MAX: return 1  # Warning
    return 2                          # Critical

def classify_noise(n):
    if n < N_NORMAL_MAX:  return 0   # Normal
    if n <= N_WARNING_MAX: return 1  # Warning
    return 2                          # Critical


def rule_engine(temp, humidity, vibration, noise):
    """
    Implements the exact 3-output decision logic from the
    Smart Rack Monitoring System Threshold Rule Set document.
    """
    t  = classify_temp(temp)
    h  = classify_humidity(humidity)
    vb = classify_vibration(vibration)
    n  = classify_noise(noise)

    # -------------------------------------------------------
    # FAN CONTROL (Section 3.1)
    # Fan ON if:
    #   - Temperature Critical (T2), OR
    #   - Vibration Critical (VB2), OR
    #   - Noise Critical (N2), OR
    #   - Temperature Warning (T1) AND (Vibration >= VB1 OR Noise >= N1)
    # -------------------------------------------------------
    fan_on = (
        t  == 2 or
        vb == 2 or
        n  == 2 or
        (t == 1 and (vb >= 1 or n >= 1))
    )

    # -------------------------------------------------------
    # DASHBOARD WARNING (Section 3.2)
    # WARNING if:
    #   - Any sensor Critical (Stage 2), OR
    #   - Two or more sensors Warning (Stage 1), OR
    #   - Temperature alone Warning (T1), OR
    #   - Both Vibration AND Noise Warning simultaneously
    # -------------------------------------------------------
    warning_count = sum(1 for s in [t, h, vb, n] if s == 1)
    any_critical  = any(s == 2 for s in [t, h, vb, n])

    dashboard_warning = (
        any_critical or
        warning_count >= 2 or
        t == 1 or
        (vb >= 1 and n >= 1)
    )

    # -------------------------------------------------------
    # SMS ALERT (Section 3.3)
    # SMS if:
    #   - Temperature Critical (T2), OR
    #   - Humidity Critical (H2), OR
    #   - Vibration Critical (VB2), OR
    #   - Noise Critical (N2), OR
    # Early Failure Detection:
    #   - Temperature Warning (T1) AND Vibration >= VB1 AND Noise >= N1
    # -------------------------------------------------------
    sms_alert = (
        t  == 2 or
        h  == 2 or
        vb == 2 or
        n  == 2 or
        (t == 1 and vb >= 1 and n >= 1)
    )

    return {
        "fan_status":        "ON"      if fan_on          else "OFF",
        "dashboard_status":  "WARNING" if dashboard_warning else "NORMAL",
        "sms_alert":         "YES"     if sms_alert        else "NO",
        # Expose individual stage classifications for transparency
        "stages": {
            "temp_stage":      t,
            "humidity_stage":  h,
            "vibration_stage": vb,
            "noise_stage":     n,
        }
    }


# =========================
# FEATURE BUILDER
# =========================
def build_features(temp, humidity, vibration, noise, now=None):
    """Compute all 13 model input features from 4 raw sensor values."""
    if now is None:
        now = datetime.now()
    return {
        "temperature_C":      temp,
        "humidity_%":         humidity,
        "vibration_g":        vibration,
        "noise_dB":           noise,
        "temp_x_humidity":    temp * humidity,
        "vib_x_noise":        vibration * noise,
        "temp_hum_sum":       temp + humidity,
        "temp_vib_ratio":     temp / (vibration + 1e-6),
        "noise_vib_ratio":    noise / (vibration + 1e-6),
        "temp_noise_product": temp * noise,
        "hour":               now.hour,
        "minute":             now.minute,
        "dayofweek":          now.weekday(),
    }


# =========================
# PREDICT
# =========================
def predict_status(temp, humidity, vibration, noise):
    features = build_features(temp, humidity, vibration, noise)
    df       = pd.DataFrame([features])[FEATURE_ORDER]
    X_scaled = scaler.transform(df)
    pred     = rf.predict(X_scaled)
    label    = le.inverse_transform(pred)[0]   # NORMAL / WARNING
    rules    = rule_engine(temp, humidity, vibration, noise)
    return label, rules


# =========================
# DB HELPER
# =========================
def fetch_latest_row(table_name, columns):
    order_by_candidates = ["created_at", "id"]
    query_template = "SELECT {cols} FROM {table} ORDER BY {order_by} DESC LIMIT 1"
    with psycopg2.connect(**DB_CONFIG) as conn:
        with conn.cursor() as cur:
            for order_by in order_by_candidates:
                try:
                    cur.execute(query_template.format(
                        cols=",".join(columns),
                        table=table_name,
                        order_by=order_by,
                    ))
                    row = cur.fetchone()
                    if row is None:
                        return None
                    return dict(zip(columns, row))
                except errors.UndefinedColumn:
                    conn.rollback()
                    continue
                except Exception:
                    conn.rollback()
                    raise
    return None


def fetch_rows_since(table_name, columns, hours_back):
    query = (
        "SELECT {cols} FROM {table} "
        "WHERE created_at >= NOW() - INTERVAL %s "
        "ORDER BY created_at ASC"
    )
    with psycopg2.connect(**DB_CONFIG) as conn:
        with conn.cursor() as cur:
            cur.execute(
                query.format(cols=",".join(columns), table=table_name),
                (f"{hours_back} hours",),
            )
            rows = cur.fetchall()
            return [dict(zip(columns, row)) for row in rows]


def align_series(base_rows, other_rows, value_key, time_key="created_at"):
    aligned = []
    idx = 0
    current_value = None
    for base in base_rows:
        base_time = base[time_key]
        while idx < len(other_rows) and other_rows[idx][time_key] <= base_time:
            current_value = other_rows[idx][value_key]
            idx += 1
        aligned.append(current_value)
    return aligned


# =========================
# SMS HELPER
# =========================
def send_sms_alert(label, temp, humidity, vibration, noise, stages):
    if not all([TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
                TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER]):
        return {"sent": False, "reason": "twilio_not_configured"}
    try:
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        body   = (
            f"Smart Rack ALERT: {label}. "
            f"Temp={temp:.1f}C (stage {stages['temp_stage']}), "
            f"Humidity={humidity:.1f}% (stage {stages['humidity_stage']}), "
            f"Vibration={vibration:.3f}g (stage {stages['vibration_stage']}), "
            f"Noise={noise:.1f}dB (stage {stages['noise_stage']})."
        )
        message = client.messages.create(
            body=body, from_=TWILIO_FROM_NUMBER, to=TWILIO_TO_NUMBER
        )
        return {"sent": True, "sid": message.sid}
    except Exception as exc:
        return {"sent": False, "reason": str(exc)}


# =============================================================
# ROUTES
# =============================================================

def get_float_field(data, keys, label):
    for key in keys:
        if key in data and data[key] is not None:
            return float(data[key])
    raise KeyError(f"Missing field: {label} (expected one of {keys})")

@app.route("/predict", methods=["POST"])
def predict_api():
    """
    POST /predict
    Body: { "temperature_C": 28.5, "humidity_%": 55.0,
            "vibration_g": 0.35, "noise_dB": 48.0 }
    """
    try:
        data = request.json or {}
        if not isinstance(data, dict) or not data:
            return jsonify({"error": "Request body must be JSON", "status": "failed"}), 400
        if "url" in data and len(data.keys()) == 1:
            return jsonify({"status": "ignored", "reason": "non-sensor payload"}), 200

        temp = get_float_field(
            data,
            ["temperature_C", "temperature", "temp", "temp_am2305b"],
            "temperature",
        )
        humidity = get_float_field(
            data,
            ["humidity_%", "humidity", "humdi", "humidity_am2305b"],
            "humidity",
        )
        vibration = get_float_field(
            data,
            ["vibration_g", "vibration", "vibra"],
            "vibration",
        )
        noise = get_float_field(
            data,
            ["noise_dB", "noise", "noise_db"],
            "noise",
        )

        label, rules = predict_status(temp, humidity, vibration, noise)

        sms_result = {"sent": False}
        if rules["sms_alert"] == "YES":
            sms_result = send_sms_alert(
                label, temp, humidity, vibration, noise, rules["stages"]
            )

        return jsonify({
            "prediction":       label,
            "fan_status":       rules["fan_status"],
            "dashboard_status": rules["dashboard_status"],
            "sms_alert":        rules["sms_alert"],
            "stages":           rules["stages"],
            "sms":              sms_result,
            "status":           "success",
        })

    except KeyError as e:
        return jsonify({"error": f"Missing field: {e}", "status": "failed"}), 400
    except Exception as e:
        return jsonify({"error": str(e), "status": "failed"}), 500


@app.route("/am2305", methods=["GET"])
@app.route("/am2305/latest", methods=["GET"])
def am2305_latest():
    try:
        row = fetch_latest_row("am2305", ["temperature", "humidity"])
        return jsonify(row or {})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/noise_data", methods=["GET"])
@app.route("/noise_data/latest", methods=["GET"])
def noise_latest():
    try:
        row = fetch_latest_row("noise_data", ["noise_db"])
        return jsonify(row or {})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/vibration", methods=["GET"])
@app.route("/vibration/latest", methods=["GET"])
def vibration_latest():
    try:
        row = fetch_latest_row(
            "vibration_data",
            ["accel_x", "accel_y", "accel_z",
             "vel_x", "vel_y", "vel_z",
             "freq_x", "freq_y", "freq_z",
             "angle_x", "angle_y", "angle_z",
             "temperature", "device_name", "created_at"],
        )
        if not row:
            return jsonify({})
        vibration_g = math.sqrt(
            (row["accel_x"] or 0)**2 +
            (row["accel_y"] or 0)**2 +
            (row["accel_z"] or 0)**2
        )
        return jsonify({"vibration_g": round(vibration_g, 4), **row})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/live", methods=["GET"])
def live_predict():
    """
    GET /live — pulls latest readings from all DB tables,
    runs prediction, returns full status. Use for dashboard polling.
    """
    try:
        am_row    = fetch_latest_row("am2305",        ["temperature", "humidity"])
        noise_row = fetch_latest_row("noise_data",    ["noise_db"])
        vib_row   = fetch_latest_row("vibration_data",["accel_x", "accel_y", "accel_z"])

        if not all([am_row, noise_row, vib_row]):
            return jsonify({"error": "One or more DB tables returned no data"}), 503

        temp      = float(am_row["temperature"])
        humidity  = float(am_row["humidity"])
        noise     = float(noise_row["noise_db"])
        vibration = math.sqrt(
            (vib_row["accel_x"] or 0)**2 +
            (vib_row["accel_y"] or 0)**2 +
            (vib_row["accel_z"] or 0)**2
        )

        label, rules = predict_status(temp, humidity, vibration, noise)

        sms_result = {"sent": False}
        if rules["sms_alert"] == "YES":
            sms_result = send_sms_alert(
                label, temp, humidity, vibration, noise, rules["stages"]
            )

        return jsonify({
            "sensor_readings": {
                "temperature_C": round(temp, 2),
                "humidity_%":    round(humidity, 2),
                "vibration_g":   round(vibration, 4),
                "noise_dB":      round(noise, 2),
            },
            "prediction":       label,
            "fan_status":       rules["fan_status"],
            "dashboard_status": rules["dashboard_status"],
            "sms_alert":        rules["sms_alert"],
            "stages":           rules["stages"],
            "sms":              sms_result,
            "status":           "success",
        })

    except Exception as e:
        return jsonify({"error": str(e), "status": "failed"}), 500


@app.route("/sensor_data", methods=["GET"])
def sensor_data():
    """
    GET /sensor_data?hours=24
    Returns time-aligned series for charting.
    """
    try:
        hours_back = float(request.args.get("hours", 24))

        am_rows = fetch_rows_since(
            "am2305", ["temperature", "humidity", "created_at"], hours_back
        )
        noise_rows = fetch_rows_since(
            "noise_data", ["noise_db", "created_at"], hours_back
        )
        vib_rows = fetch_rows_since(
            "vibration_data",
            ["accel_x", "accel_y", "accel_z", "created_at"],
            hours_back,
        )

        vib_series = []
        for row in vib_rows:
            vibration_g = math.sqrt(
                (row["accel_x"] or 0) ** 2 +
                (row["accel_y"] or 0) ** 2 +
                (row["accel_z"] or 0) ** 2
            )
            vib_series.append({
                "created_at": row["created_at"],
                "vibration_g": round(vibration_g, 4),
            })

        noise_series = [
            {"created_at": row["created_at"], "noise_db": row["noise_db"]}
            for row in noise_rows
        ]

        if not am_rows:
            return jsonify([])

        aligned_noise = align_series(am_rows, noise_series, "noise_db")
        aligned_vib = align_series(am_rows, vib_series, "vibration_g")

        data = []
        for i, row in enumerate(am_rows):
            data.append({
                "created_at": row["created_at"].isoformat(),
                "temperature_C": row["temperature"],
                "humidity_%": row["humidity"],
                "noise_dB": aligned_noise[i],
                "vibration_g": aligned_vib[i],
            })

        return jsonify(data)

    except Exception as e:
        return jsonify({"error": str(e), "status": "failed"}), 500


@app.route("/export_csv", methods=["GET"])
def export_csv():
    try:
        with psycopg2.connect(**DB_CONFIG) as conn:
            am2305_df    = pd.read_sql("SELECT * FROM am2305",         conn)
            noise_df     = pd.read_sql("SELECT * FROM noise_data",     conn)
            vibration_df = pd.read_sql("SELECT * FROM vibration_data", conn)

        am2305_df["source"]    = "am2305"
        noise_df["source"]     = "noise"
        vibration_df["source"] = "vibration"

        combined_df = pd.concat(
            [am2305_df, noise_df, vibration_df],
            ignore_index=True, sort=False
        )

        os.makedirs("exports", exist_ok=True)
        filename = f"export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        filepath = os.path.join("exports", filename)
        combined_df.to_csv(filepath, index=False)

        return jsonify({"status": "success", "file": filepath})
    except Exception as e:
        return jsonify({"status": "failed", "error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)