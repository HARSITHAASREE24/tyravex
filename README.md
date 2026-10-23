# TYRAVEX — Hardware Telemetry & Monitoring System

> **"Real-Time Telemetry & Suspension Load Monitoring with ESP32 & Web Serial"**

TYRAVEX is an automotive suspension telemetry, environmental monitoring, and mechanical load estimation system. It pairs an **ESP32 microcontroller** streaming real-time multi-sensor telemetry with a **zero-backend, high-performance static frontend dashboard** running in desktop browsers via the browser-native **Web Serial API**.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Hardware Bill of Materials & Pin Wiring](#2-hardware-bill-of-materials--pin-wiring)
3. [Crucial Hardware Disclaimers & Design Truths](#3-crucial-hardware-disclaimers--design-truths)
4. [HX711 Load Cell Calibration Workflow](#4-hx711-load-cell-calibration-workflow)
5. [ESP32 Firmware Setup & Library Installation](#5-esp32-firmware-setup--library-installation)
6. [Serial JSON Telemetry Specification](#6-serial-json-telemetry-specification)
7. [Web Serial API Workflow](#7-web-serial-api-workflow)
8. [Automated Email Alerts (EmailJS)](#8-automated-email-alerts-emailjs)
9. [Vercel Static Deployment Guide](#9-vercel-static-deployment-guide)

---

## 1. System Architecture

```
+--------------------------------------------------------------------------+
|                        TYRAVEX SENSOR HARDWARE                           |
|  1. DHT11             -> Ambient Temperature (°C) & Humidity (%RH)       |
|  2. BMP280            -> Tire Pressure Module (PSI / bar / kPa / hPa)     |
|  3. Vibration Sensor  -> Analog Displacement (AO) & Digital Switch (DO)  |
|  4. 10 kg Load Cell   -> Tire Load on Suspension (HX711 DT: 18, SCK: 19)  |
+------------------------------------+-------------------------------------+
                                     | (Digital, I2C, ADC & SPI Signals)
                                     v
+--------------------------------------------------------------------------+
|                             ESP32 DEV MODULE                             |
|  - Firmware: esp32/tyravex_esp32.ino                                     |
|  - Non-blocking millis() scheduler (1000ms loop, 2000ms DHT11 rate)      |
|  - On-chip non-volatile NVS storage (Preferences) for Tare & Scale Factor|
|  - Serial command parser for TARE and CAL:<weight>                       |
|  - Newline-delimited JSON messages @ 115200 Baud                         |
+------------------------------------+-------------------------------------+
                                     | (USB Serial Stream)
                                     v
+--------------------------------------------------------------------------+
|                         CLIENT DESKTOP BROWSER                           |
|                         (Chrome / Edge / Opera)                          |
|  - Web Serial API (navigator.serial.requestPort)                         |
|  - serial.js: UTF-8 line buffer, JSON validator & command transmitter    |
+------------------------------------+-------------------------------------+
                                     |
         +---------------------------+---------------------------+
         |                                                       |
         v                                                       v
+------------------------------------+   +---------------------------------+
|      TYRAVEX DASHBOARD (UI)        |   |    EMAILJS CLOUD DISPATCHER     |
| - Card 1: Overall Monitoring Status|   | - High Ambient Temp Warning     |
| - Card 2: Ambient Temperature °C   |   | - Humidity Limit Alert          |
| - Card 3: Relative Humidity %RH    |   | - Harsh Mechanical Vibration    |
| - Card 4: Tire Pressure            |   | - Excessive Suspension Load     |
| - Card 5: Vibration Monitoring     |   | - Sensor Hardware Fault         |
| - Card 6: Tire Load (Suspension)   |   | - Configurable Cooldown (90s)   |
| - Card 7: Sensor Connection Status |   +---------------------------------+
| - Card 8: 5 Live Sensor Waveforms  |
| - Card 9: Incident Log & CSV Export|
+------------------------------------+
```

---

## 2. Hardware Bill of Materials & Pin Wiring

| Sensor / Module | Function | ESP32 GPIO Connection | Power Supply | Wiring Notes |
| :--- | :--- | :--- | :--- | :--- |
| **ESP32 Dev Board** | Standard 30-pin or 38-pin DevKit | USB to PC Host | 5V via USB | Microcontroller processing telemetry |
| **DHT11** | Ambient Temperature & Relative Humidity | **GPIO 4** | **3.3V** & GND | Digital single-bus. Has internal pull-up; external 10kΩ to 3.3V recommended |
| **BMP280** | Tire Pressure Sensing | **SDA: GPIO 21**<br>**SCL: GPIO 22** | **3.3V** & GND | Hardware I2C bus. Automatically checks address `0x76` and `0x77` |
| **Vibration Sensor** | Analog level & Digital pulse counter | **AO: GPIO 34** (ADC1)<br>**DO: GPIO 35** | **3.3V** & GND | GPIO 34/35 are input-only pins on ESP32 ADC1 (no WiFi ADC2 conflicts) |
| **10 kg Load Cell** | Tire load sensing via suspension | Connects to HX711 E+, E-, A+, A- | Powered by HX711 | Red: E+, Black: E-, White: A-, Green: A+ |
| **HX711 Amplifier** | 24-bit ADC for load cell | **DT: GPIO 18**<br>**SCK: GPIO 19** | **3.3V** & GND | DT: Data Output from HX711; SCK: Clock input to HX711 |
| **Indicator LED** | Telemetry Heartbeat | **GPIO 2** | Internal | Builtin dev board LED, toggles on each telemetry packet |

### Voltage Safety Rules:
1. **Always power the sensors from the 3.3V pin** of the ESP32 dev board.
2. **Never apply voltages > 3.3V to any ESP32 GPIO pin.**
3. GPIO 34 and GPIO 35 belong to ADC1 and do not share channels with ESP32 Wi-Fi, preventing ADC read corruption.

---

## 3. Crucial Hardware Disclaimers & Design Truths

1. **Tire Pressure Monitoring:**
   - The **BMP280 sensor serves as the dedicated Tire Pressure probe**, transmitting readings convertible to standard automotive units (**PSI**, **bar**, **kPa**, **hPa**), defaulting to PSI.
2. **Ambient Temperature:**
   - The **DHT11 measures ambient air temperature and relative humidity** in the vicinity of the sensor installation point.
3. **Tire Load from Suspension:**
   - The **10 kg load cell measures dynamic suspension load applied directly to the tire**.
   - Raw counts (~24k to 25k unloaded baseline) convert into dynamic applied load in kg and N (moving to ~64k - 100k+ counts under active vehicle suspension pressure).
4. **No Fabricated Data:**
   - When a sensor is disconnected or invalid, the system transmits `null` and sets `<sensor>_valid: false`. The dashboard visibly displays `SENSOR FAULT` or `UNCALIBRATED`.

---

## 4. HX711 Load Cell Calibration Workflow

The ESP32 firmware features on-chip non-volatile storage (`Preferences` in flash NVS). You do not need to hardcode scale factors in the source code.

### Calibration Steps:

#### Step 1: Tare (Zeroing Unloaded Cell)
1. Ensure the load cell is mechanically mounted with **no test weight or load applied**.
2. Click the **Tare (Zero)** button on Card 6 in the dashboard (or click **Tare Unloaded Cell** in Settings).
3. The dashboard sends the `TARE` serial command to the ESP32.
4. The ESP32 averages 15 readings, computes the zero-point offset, and saves it permanently to NVS.

#### Step 2: Calibrate with Known Reference Weight
1. Place a known reference test weight (e.g. **1.0 kg**, **2.0 kg**, or **5.0 kg**) onto the load cell.
2. In the dashboard Card 6 (or Settings modal), enter the test weight in kilograms (e.g. `1.0`).
3. Click **Calibrate**.
4. The dashboard sends `CAL:<weight>` (e.g. `CAL:1.0`) over serial.
5. The ESP32 computes:
   $$\text{Scale Factor} = \frac{\text{Raw Reading} - \text{Tare Offset}}{\text{Known Weight in kg}}$$
6. The scale factor is stored in ESP32 flash memory and `load_calibrated` is set to `true`.

#### Step 3: Verify Live Reading
1. Remove the weight: the display will return to `0.00 kg` (or `0.00 N`).
2. Re-apply the test weight: the display will accurately show the calibrated weight.

---

## 5. ESP32 Firmware Setup & Library Installation

### 1. Arduino IDE Setup
1. Download and install [Arduino IDE 2.x](https://www.arduino.cc/en/software).
2. Install the ESP32 Board Package:
   - Navigate to **File > Preferences > Additional Boards Manager URLs**.
   - Paste:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - Open **Tools > Board > Boards Manager**, search for `esp32` by Espressif Systems, and click **Install**.

### 2. Install Required Libraries
Open **Tools > Manage Libraries** (Ctrl + Shift + I) and install:
1. **DHT sensor library** (by Adafruit) — version 1.4.x
2. **Adafruit Unified Sensor** (by Adafruit) — dependency for DHT and BMP280
3. **Adafruit BMP280 Library** (by Adafruit) — version 2.6.x
4. **HX711** (by Bogdan Necula / bogde) — version 0.7.x

### 3. Compile & Flash Firmware
1. Open [`esp32/tyravex_esp32.ino`](file:///c:/Users/JEYAKRISHNAN/OneDrive/Desktop/HARISH/esp32/tyravex_esp32.ino).
2. Connect your ESP32 to your computer using a USB data cable.
3. In Arduino IDE:
   - Board: **ESP32 Dev Module**
   - Port: Select the COM port corresponding to your ESP32 (e.g., `COM3`, `COM5`).
4. Click **Upload** (Ctrl + U).
5. Once uploading finishes, **close the Arduino Serial Monitor** so the Web Serial API can open the USB port.

---

## 6. Serial JSON Telemetry Specification

The firmware outputs one newline-delimited JSON line per second (`115200` baud):

```json
{
  "device": "TYRAVEX",
  "temperature_c": 30.5,
  "humidity_percent": 55.0,
  "tire_pressure_hpa": 1008.2,
  "atmospheric_pressure_hpa": 1008.2,
  "vibration_analog_raw": 1250,
  "vibration_digital": 0,
  "vibration_event_count": 12,
  "load_raw": 64800,
  "load_kg": 1.87,
  "load_calibrated": true,
  "dht11_valid": true,
  "bmp280_valid": true,
  "vibration_analog_valid": true,
  "vibration_digital_valid": true,
  "hx711_valid": true,
  "timestamp_ms": 12500
}
```

### Field Definitions:
- `temperature_c` *(float | null)*: Ambient temperature in °C from DHT11.
- `humidity_percent` *(float | null)*: Relative humidity in %RH from DHT11.
- `tire_pressure_hpa` *(float | null)*: Tire pressure in hPa from BMP280 (converted to PSI/bar/kPa/hPa in UI).
- `vibration_analog_raw` *(int)*: Raw 12-bit ADC value (0 - 4095) from Vibration AO (GPIO 34).
- `vibration_digital` *(int)*: Digital trigger status (0 = quiet, 1 = active) from Vibration DO (GPIO 35).
- `vibration_event_count` *(unsigned long)*: Cumulative interrupt-driven count of vibration trigger pulses.
- `load_raw` *(long)*: Raw transducer counts from HX711 (DT: 18, SCK: 19; ~24.5k unloaded).
- `load_kg` *(float | null)*: Converted mechanical tire load in kg applied through the suspension.
- `load_calibrated` *(boolean)*: `true` if tare and scale factors are calibrated in NVS.
- `dht11_valid` *(boolean)*: `true` when DHT11 provides valid temperature and humidity readings.
- `bmp280_valid` *(boolean)*: `true` when BMP280 is detected and responding over I2C.
- `vibration_analog_valid` *(boolean)*: `true` when AO ADC channel is active.
- `vibration_digital_valid` *(boolean)*: `true` when DO digital input is active.
- `hx711_valid` *(boolean)*: `true` when HX711 amplifier is ready on GPIO 18/19.
- `timestamp_ms` *(unsigned long)*: Microcontroller uptime in milliseconds.

---

## 7. Web Serial API Workflow

1. Open TYRAVEX in a desktop browser with Web Serial support:
   - **Google Chrome** (v89+)
   - **Microsoft Edge** (v89+)
   - **Opera** (v75+)
2. Select **115200** baud in the connection bar.
3. Click **CONNECT ESP32**.
4. The browser security prompt will appear. Select your ESP32 device (`CP2102` or `CH340`) and click **Connect**.
5. The dashboard begins parsing the live telemetry stream immediately.

---

## 8. Automated Email Alerts (EmailJS)

TYRAVEX includes built-in rate-limited email alerting via the official EmailJS client SDK:
- **Alert Triggers:**
  - Ambient Temperature Limit Breach (e.g. > 60°C).
  - Humidity Warning (e.g. < 20% or > 80% RH).
  - Harsh Vibration Spike (e.g. ADC Raw > 3000).
  - Excessive Suspension Load (e.g. > 9.5 kg approaching 10 kg limit).
  - Hardware Sensor Failure / Disconnection.
- **Cooldown Rate Limiting:** Minimum 90 seconds (configurable) between duplicate alerts to prevent email spamming.
- **Zero Hardcoded Secrets:** Enter your own EmailJS Public Key, Service ID, and Template ID in the **Settings** modal. Stored securely only in your browser's local storage.

---

## 9. Vercel Static Deployment Guide

TYRAVEX is 100% client-side with zero backend dependencies, making it ideally suited for instant static deployment on Vercel:

### Option A: Deploy via GitHub (Recommended)
1. Push your TYRAVEX repository to GitHub:
   ```bash
   git add .
   git commit -m "Update TYRAVEX with revised 5-sensor hardware configuration"
   git push origin main
   ```
2. Log in to [Vercel](https://vercel.com).
3. Click **Add New... > Project**.
4. Import your `tyravex` GitHub repository.
5. In the Project Configuration:
   - **Framework Preset:** `Other` (Static HTML)
   - **Build Command:** *(Leave blank)*
   - **Output Directory:** *(Leave blank or `./`)*
6. Click **Deploy**.
7. Vercel will deploy your live dashboard with an HTTPS URL.

### Option B: Deploy via Vercel CLI
```bash
npm install -g vercel
vercel
```
Follow the interactive prompts and select default settings.

---

## 10. License

Designed and maintained by Team TYRAVEX. Released for prototyping and experimental telemetry evaluation.
