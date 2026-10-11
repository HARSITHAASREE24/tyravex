# TYRAVEX

> **"Monitor Every Ride. Protect Every Tyre."**

TYRAVEX is a modern, responsive, hardware-integrated Tire Monitoring and Tyre Health Estimation System. It pairs an **ESP32 microcontroller** collecting real-time tyre telemetry with a **zero-backend, static frontend dashboard** hosted on Vercel via the browser's native **Web Serial API**.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Key Features](#key-features)
3. [Hardware Bill of Materials & Wiring](#hardware-bill-of-materials--wiring)
4. [Pressure Sensor & Safety Clarification](#pressure-sensor--safety-clarification)
5. [ESP32 Firmware Flashing Guide](#esp32-firmware-flashing-guide)
6. [Web Serial API Workflow](#web-serial-api-workflow)
7. [Tyre Health Estimation Algorithm](#tyre-health-estimation-algorithm)
8. [EmailJS Automated Alerts Integration](#emailjs-automated-alerts-integration)
9. [Vercel Static Deployment Guide](#vercel-static-deployment-guide)
10. [Safety & Prototype Disclaimer](#safety--prototype-disclaimer)

---

## 1. System Architecture

```
+-------------------------------------------------------+
|                 TYRE SENSING HARDWARE                 |
|  - DS18B20 Waterproof Temp (OneWire @ GPIO 4)         |
|  - Tyre Pressure Transducer (ADC @ GPIO 34 + Divider)  |
|  - Vibration Sensor (ADC / Switch @ GPIO 35)          |
+---------------------------+---------------------------+
                            | (Analog & OneWire Signals)
                            v
+-------------------------------------------------------+
|                    ESP32 DEV MODULE                   |
|  - tyravex_esp32.ino Firmware                         |
|  - Non-blocking millis() scheduler (1000ms loop)      |
|  - Out-of-bounds & disconnect safety checks           |
|  - JSON serialization: {"device":"TYRAVEX", ...}      |
+---------------------------+---------------------------+
                            | (USB Serial @ 115200 Baud)
                            v
+-------------------------------------------------------+
|               CLIENT DESKTOP BROWSER                  |
|               (Chrome / Edge / Opera)                 |
|  - Web Serial API (navigator.serial.requestPort)      |
|  - serial.js: UTF-8 line buffer & JSON validator      |
+---------------------------+---------------------------+
                            |
         +------------------+------------------+
         |                                     |
         v                                     v
+-----------------------------+   +-----------------------------+
|    TYRAVEX DASHBOARD (UI)   |   |   EMAILJS ALERT DISPATCHER  |
| - Overall Health Ring Gauge |   | - Rate-limited critical alerts|
| - Dynamic Unit Conversion   |   | - 90s category cooldown     |
| - Live Chart.js Waveforms   |   | - Cloud email transport     |
| - Event Log & CSV Export    |   +-----------------------------+
+-----------------------------+
```

---

## 2. Key Features

- **Direct Web Serial Telemetry:** Seamlessly streams raw sensor packets from an ESP32 over USB without any intermediate Python server, Node.js gateway, or desktop driver software.
- **Automotive Telemetry Aesthetic:** Dark graphite interface, glowing electric cyan and blue metrics, high-contrast status pills (Good / Warning / Critical / Insufficient Data), and smooth micro-interactions.
- **Light & Dark Theme Priority:** Instant one-click toggle in header and persistent setting in Settings modal. Choose between high-contrast **Automotive Dark Graphite** mode, cleanroom **Daylight Light** mode, or automatic **System Priority** (`prefers-color-scheme`). Waveform charts and gauges dynamically adapt colors.
- **Card A: Overall Tyre Health Score:** Circular progress ring with transparent, user-configurable penalty weightings. Enforces strict safety logic—**never reports healthy (`GOOD`) if essential sensors are offline or uncalibrated**.
- **Card B: Tyre Temperature (DS18B20):** Continuous thermal tracking with min/max session history, trend direction, and disconnected probe detection (`-127°C` sensor fault detection).
- **Card C: Calibrated Tyre Pressure:** Instant mathematical unit conversion between **PSI**, **bar**, and **kPa**. Displays `RAW / UNCALIBRATED` until calibrated against confirmed transducer curves.
- **Card D & E: Vibration & Road Impact Profiling:** 3-axis magnitude acceleration monitoring, peak impact detection, and dynamic road surface classification (`SMOOTH`, `MODERATE`, `ROUGH`).
- **Card F: Sensor Health Matrix:** Independent diagnostics for ESP32 UART, temperature probe, pressure transducer, and vibration sensor.
- **Card G: Live Chart.js Waveforms:** Real-time rolling history (configurable buffer size) with Pause/Resume and Reset controls.
- **Card H: Live Event Log & CSV Export:** Real-time incident logs with severity filtering and one-click CSV download.
- **EmailJS Cloud Alerts:** Automated notifications during critical pressure loss, thermal runaway, or severe impact events with spam cooldown prevention.
- **Simulated Demo Mode:** Toggleable presentation mode with synthetic physics telemetry for testing when physical hardware is not yet connected.

---

## 3. Hardware Bill of Materials & Wiring

| Component | Recommended Specification | ESP32 Pin Connection | Wiring Notes |
| :--- | :--- | :--- | :--- |
| **Microcontroller** | ESP32 Dev Module (WROOM-32) | USB to PC | Powered via 5V USB |
| **Temperature Sensor** | Dallas DS18B20 Waterproof Probe | **GPIO 4** | Requires **4.7 kΩ pull-up resistor** between Data line and 3.3V |
| **Pressure Sensor** | Waterproof Tyre Pressure Transducer | **GPIO 34** (ADC1) | **Must not exceed 3.3V**; requires voltage divider if powered by 5V |
| **Vibration Sensor** | SW-420 Digital Switch or Piezo/ADXL | **GPIO 35** (ADC1/Digital) | Connect output to GPIO 35 with appropriate GND reference |
| **Indicator LED** | Built-in Dev Board LED | **GPIO 2** | Flashes as telemetry heartbeat |

### Wiring Schematic Notes:
1. **DS18B20 Temperature Probe:**
   - Red wire: 3.3V VCC
   - Black wire: GND
   - Yellow/Blue wire: GPIO 4
   - **4.7 kΩ Resistor:** Connect between 3.3V and GPIO 4.
2. **Pressure Sensor Transducer:**
   - If the transducer is powered by 5V and outputs 0.5V - 4.5V:
     ```
     Sensor Output (0.5V - 4.5V) ───[ 10 kΩ ]───┬───> ESP32 GPIO 34 (Max 3.0V)
                                                │
                                            [ 20 kΩ ]
                                                │
                                               GND
     ```
   - This $2:1$ voltage divider ensures maximum sensor output ($4.5\text{ V}$) scales safely to $3.0\text{ V}$, well within the ESP32 ADC limits.

---

## 4. Pressure Sensor & Safety Clarification

> **IMPORTANT HARDWARE DISTINCTION:**
> - **BMP180 / BMP280 Sensors:** These are **ambient barometric pressure sensors** intended for weather stations and altitude estimation. **They cannot measure internal tyre pressure.**
> - **Actual Tyre Pressure Transducers:** Require a sealed threaded pneumatic connection (e.g. Schrader valve port) rated for 0 - 100 PSI (0 - 7 bar).
> - **Calibration Rule:** If `PRESSURE_CALIBRATED` is `false` in `tyravex_esp32.ino`, the firmware sets `pressure_valid: false` and `pressure: null`. The TYRAVEX dashboard will visibly display **`RAW / UNCALIBRATED`**. The system **never invents fake pressure values**.

---

## 5. ESP32 Firmware Flashing Guide

1. Download and install the [Arduino IDE](https://www.arduino.cc/en/software) (version 2.x recommended).
2. Install the ESP32 Board Package:
   - Navigate to **File > Preferences > Additional Boards Manager URLs**.
   - Add: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
   - Open **Tools > Board > Boards Manager**, search for `esp32` by Espressif Systems, and click **Install**.
3. Install required libraries via **Tools > Manage Libraries**:
   - `OneWire` (by Paul Stoffregen)
   - `DallasTemperature` (by Miles Burton)
4. Open `esp32/tyravex_esp32.ino`.
5. Select your board under **Tools > Board > ESP32 Dev Module**.
6. Select the appropriate COM port under **Tools > Port**.
7. Click **Upload** (Ctrl + U).
8. Once uploaded, close the Arduino Serial Monitor so the browser's Web Serial API can access the USB port!

---

## 6. Web Serial API Workflow

1. Open TYRAVEX in a supported desktop browser:
   - **Google Chrome** (v89+)
   - **Microsoft Edge** (v89+)
   - **Opera** (v75+)
   - *Note: Firefox, Safari, and mobile browsers currently do not support the Web Serial API.*
2. Set the baud rate dropdown to **115200** (default).
3. Click the **CONNECT ESP32** button.
4. The browser will open its native device permission dialog.
5. Select your ESP32 device (e.g. `CP2102 USB to UART Bridge` or `CH340`) and click **Connect**.
6. The dashboard will automatically transition to **CONNECTED** and begin parsing incoming JSON telemetry at 1 Hz.

### Data Packet Format (JSON)
Each packet transmitted by the ESP32 terminates with `\n`:
```json
{
  "device": "TYRAVEX",
  "temperature": 34.5,
  "pressure": null,
  "pressure_unit": "PSI",
  "pressure_valid": false,
  "vibration": 1.25,
  "vibration_unit": "g",
  "vibration_valid": true,
  "temperature_valid": true,
  "timestamp_ms": 12500
}
```

---

## 7. Tyre Health Estimation Algorithm

The TYRAVEX Overall Tyre Health Score ($H$) is an experimental 0 - 100% composite score calculated transparently based on user-configured weighting:

$$H = \left( S_{\text{pressure}} \times W_p \right) + \left( S_{\text{temp}} \times W_t \right) + \left( S_{\text{vibration}} \times W_v \right)$$

### Default Weightings:
- **Pressure Weight ($W_p$):** 45%
- **Temperature Weight ($W_t$):** 30%
- **Vibration Weight ($W_v$):** 25%

### Safety Criteria:
- **Insufficient Data / Offline:** If critical sensors are disconnected or uncalibrated, the health status switches to **`INSUFFICIENT DATA`** or **`WARNING`**.
- **Good ($H \ge 80\%$):** Requires all essential sensors to be operational with zero active warnings.
- **Warning ($60\% \le H < 80\%$):** Triggered when pressure or temperature breaches configured tolerance.
- **Critical ($H < 60\%$):** Triggered by severe pressure loss, overheating ($> 70^\circ\text{C}$), or severe vibration spikes.

---

## 8. EmailJS Automated Alerts Integration

TYRAVEX includes native integration with [EmailJS](https://www.emailjs.com/) for automated alerts:

1. Create a free account at [emailjs.com](https://www.emailjs.com/).
2. Add an **Email Service** (e.g., Gmail, Outlook, SendGrid).
3. Create an **Email Template** with the following template variables:
   - `{{alert_title}}`
   - `{{alert_category}}`
   - `{{alert_details}}`
   - `{{temperature_reading}}`
   - `{{pressure_reading}}`
   - `{{vibration_reading}}`
   - `{{health_score}}`
   - `{{timestamp}}`
4. Open the TYRAVEX dashboard, click the **Settings icon** (top right), and enter your:
   - **Public Key**
   - **Service ID**
   - **Template ID**
   - **Recipient Email**
5. Click **Send Test Email** to verify configuration.
6. **Spam Prevention:** All alerts enforce a configurable 90-second cooldown per alert type to avoid mailbox flooding.

---

## 9. Vercel Static Deployment Guide

TYRAVEX is 100% static (HTML, CSS, Vanilla JS) and requires no build step, Node server, or database.

### Deploying via Vercel Web Dashboard:
1. Push your TYRAVEX folder to a GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initial TYRAVEX release"
   git remote add origin https://github.com/your-username/tyravex.git
   git push -u origin main
   ```
2. Log into [vercel.com](https://vercel.com/) and click **Add New Project**.
3. Select your `tyravex` GitHub repository.
4. Framework Preset: **Other** (leave Root Directory as `./`).
5. Click **Deploy**. Vercel will instantly generate a live HTTPS URL (e.g., `https://tyravex.vercel.app`).

### Deploying via Vercel CLI:
```bash
npm i -g vercel
cd tyravex
vercel --prod
```

> **Why HTTPS is Required:** The Web Serial API strictly requires a **Secure Context (HTTPS or localhost)** to function. Vercel provides automated SSL certificates for all deployments.

---

## 10. Safety & Prototype Disclaimer

> [!CAUTION]
> **RESEARCH & PROTOTYPE DISCLAIMER**
> 
> TYRAVEX is an experimental hardware-software engineering prototype developed for laboratory and educational telemetry research. 
> 
> - **Not a Certified Safety Device:** This system does not replace factory-installed TPMS (Tire Pressure Monitoring Systems) certified under FMVSS No. 138, UNECE R64, or ISO 21750.
> - **Uncalibrated Sensors:** The health score and road impact profiles are experimental mathematical estimates. Do not use this prototype as the sole basis for high-speed driving decisions or tyre maintenance intervals.
> - **Physical Inspection:** Regularly inspect tyre tread depth, sidewalls, and cold inflation pressures using a calibrated mechanical tyre pressure gauge.
